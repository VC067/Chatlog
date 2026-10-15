import { renderConversationMarkdown } from '../../destinations/markdown/render.ts';
import { resolveMarkdownNotePath, deliverMarkdown } from '../../destinations/markdown/deliver.ts';
import { readFolderAccess } from '../../destinations/markdown/permission.ts';
import { readRootHandle } from '../../destinations/markdown/handle-store.ts';
import { clearNotionDeliveryIssue, readNotionConfig, readNotionStatus, recordNotionDeliveryStatus } from '../../destinations/notion/config.ts';
import { deliverNotion } from '../../destinations/notion/deliver.ts';
import { writeSideFiles } from '../../destinations/markdown/side-files.ts';
import { readSettings } from '../settings.ts';
import {
  claimJob, finishClaimedJob, renewClaimedJob, listJobs,
  readConversation, readDelivery, saveJob,
} from '../archive/repository.ts';
import type { DeliveryJob } from '../contracts/jobs.ts';

const LEASE_MS = 120_000;
const REVIEW_ERRORS = new Set([
  'notion_write_uncertain', 'notion_section_changed', 'notion_duplicate_identity',
  'notion_duplicate_section', 'notion_section_uncertain',
  'notion_destination_mismatch',
]);
function isoAfter(ms: number): string { return new Date(Date.now() + ms).toISOString(); }

async function finish(job: DeliveryJob, patch: Partial<DeliveryJob>): Promise<void> {
  await finishClaimedJob(job, patch);
}

async function runJob(job: DeliveryJob): Promise<void> {
  const conversation = await readConversation(job.conversationKey);
  if (!conversation || conversation.revision !== job.revision) {
    await finish(job, { state: 'completed', errorCode: 'superseded' });
    return;
  }
  const settings = await readSettings();
  const assertLease = async () => {
    if (!await renewClaimedJob(job, isoAfter(LEASE_MS))) throw new Error('delivery_lease_lost');
  };
  if (job.destinationId === 'markdown') {
    if (!settings.markdownEnabled) {
      await finish(job, { state: 'blocked', errorCode: 'destination_disabled' });
      return;
    }
    const prepared = await writeSideFiles(conversation, settings);
    await assertLease();
    const notePath = await resolveMarkdownNotePath(prepared, { projects: settings.saveClaudeProjects });
    const markdown = renderConversationMarkdown(prepared, {
      includeSources: settings.includeSources,
      saveCreatedFiles: settings.saveCreatedFiles,
      saveUploadedFiles: settings.saveUploadedFiles,
      saveCodeGallery: settings.saveCodeGallery,
      folderDiskPath: settings.folderDiskPath, notePath,
    });
    const outcome = await deliverMarkdown(prepared, markdown);
    await finish(job, {
      state: outcome === 'blocked' ? 'blocked' : outcome === 'kept-edits' ? 'needs_review' : 'completed',
      errorCode: outcome === 'blocked' ? 'permission_required' : outcome === 'kept-edits' ? 'local_edits' : null,
    });
    return;
  }
  if (job.destinationId === 'notion') {
    const config = await readNotionConfig();
    if (!config) {
      await finish(job, { state: 'blocked', errorCode: 'notion_not_configured' });
      return;
    }
    const status = await readNotionStatus();
    if (status.state === 'error' && ['notion_workspace_limit', 'notion_api_restricted'].includes(status.errorCode ?? '')) {
      await finish(job, { state: 'blocked', errorCode: status.errorCode });
      return;
    }
    if (browser.permissions?.contains && !await browser.permissions.contains({ origins: ['https://api.notion.com/*'] })) {
      await recordNotionDeliveryStatus(false, { errorCode: 'notion_permission_required', message: 'Allow Notion access again in Connections.' }, config);
      await finish(job, { state: 'blocked', errorCode: 'notion_permission_required' });
      return;
    }
    const mapping = await readDelivery(conversation.key, 'notion');
    const result = await deliverNotion({
      conversation, markdown: renderConversationMarkdown(conversation, { includeSources: settings.includeSources }),
      token: config.token, parentId: config.dataSourceId, parentType: 'data_source_id',
      pageId: mapping?.externalId ?? null, config, assertLease,
    });
    if (result.status === 'retry') {
      await recordNotionDeliveryStatus(false, result, config);
      await finish(job, {
        state: 'retry_wait', nextEligibleAt: isoAfter(result.retryAfterMs ?? 60_000),
        errorCode: result.errorCode ?? 'rate_limited',
      });
    } else if (result.status === 'failed') {
      await recordNotionDeliveryStatus(false, result, config);
      await finish(job, {
        state: REVIEW_ERRORS.has(result.errorCode ?? '') ? 'needs_review'
          : ['notion_unauthorized', 'notion_forbidden', 'unauthorized', 'restricted_resource', 'object_not_found', 'notion_workspace_limit', 'notion_api_restricted'].includes(result.errorCode ?? '') ? 'blocked'
          : job.attempts >= 5 ? 'failed' : 'retry_wait',
        nextEligibleAt: isoAfter(60_000), errorCode: result.errorCode ?? 'notion_failed',
      });
    } else {
      await recordNotionDeliveryStatus(true, undefined, config);
      // The Notion writer persists its own mapping and recovery checkpoints.
      await finish(job, { state: 'completed', errorCode: null });
    }
    return;
  }
  await finish(job, { state: 'failed', errorCode: 'unknown_destination' });
}

async function recoverBlockedJobs(jobs: DeliveryJob[]): Promise<void> {
  const [settings, config, root] = await Promise.all([readSettings(), readNotionConfig(), readRootHandle()]);
  const permission = root ? await readFolderAccess(root) : 'missing';
  const notionPermission = config !== null && (!browser.permissions?.contains || await browser.permissions.contains({ origins: ['https://api.notion.com/*'] }));
  for (const job of jobs) {
    if (job.state !== 'blocked') continue;
    const ready = job.destinationId === 'markdown' && settings.markdownEnabled && permission === 'granted' &&
      (job.errorCode === 'permission_required' || job.errorCode === 'destination_disabled') ||
      job.destinationId === 'notion' && notionPermission &&
      (job.errorCode === 'notion_not_configured' || job.errorCode === 'notion_permission_required');
    if (ready) await saveJob({ ...job, state: 'pending', nextEligibleAt: null, errorCode: null });
  }
}

export interface QueueResult { written: number; blocked: number; skipped: number }
let active: Promise<QueueResult> | null = null;

/** A user-requested retry may recheck a corrected plan, without resetting API cooldowns. */
export async function retryDestinationQueue(): Promise<QueueResult> {
  await clearNotionDeliveryIssue();
  for (const job of await listJobs()) {
    if (job.destinationId === 'notion' && job.state === 'blocked' &&
      ['notion_workspace_limit', 'notion_api_restricted'].includes(job.errorCode ?? '')) {
      await saveJob({ ...job, state: 'pending', attempts: 0, nextEligibleAt: null, errorCode: null, leaseOwner: null, leaseExpiresAt: null });
    }
  }
  return runDeliveryQueue();
}

export function runDeliveryQueue(): Promise<QueueResult> {
  active ??= runQueue().finally(() => { active = null; });
  return active;
}

async function rewriteHiddenNotionBodies(): Promise<void> {
  const stored = await browser.storage.local.get('notionBodyVersion');
  if (stored.notionBodyVersion === 2) return;
  for (const job of await listJobs()) {
    if (job.destinationId !== 'notion' || job.state !== 'completed') continue;
    await saveJob({ ...job, state: 'pending', attempts: 0, nextEligibleAt: null, errorCode: null, leaseOwner: null, leaseExpiresAt: null });
  }
  await browser.storage.local.set({ notionBodyVersion: 2 });
}

async function rewriteSavedNotes(): Promise<void> {
  const stored = await browser.storage.local.get('archiveFormatVersion');
  if (stored.archiveFormatVersion === 3) return;
  for (const job of await listJobs()) {
    if ((job.destinationId !== 'markdown' && job.destinationId !== 'notion') || job.state !== 'completed') continue;
    await saveJob({ ...job, state: 'pending', attempts: 0, nextEligibleAt: null, errorCode: null, leaseOwner: null, leaseExpiresAt: null });
  }
  await browser.storage.local.set({ archiveFormatVersion: 3 });
}

async function runQueue(): Promise<QueueResult> {
  await rewriteHiddenNotionBodies();
  await rewriteSavedNotes();
  await recoverBlockedJobs(await listJobs());
  let written = 0;
  let blocked = 0;
  let skipped = 0;
  const deadline = Date.now() + 20_000;
  for (const job of await listJobs()) {
    if (Date.now() > deadline) break;
    const now = new Date().toISOString();
    if (job.nextEligibleAt !== null && job.nextEligibleAt > now ||
      !['pending', 'retry_wait', 'running'].includes(job.state)) continue;
    const claimed = await claimJob(job.id, now, isoAfter(LEASE_MS));
    if (!claimed) { skipped += 1; continue; }
    const heartbeat = setInterval(() => {
      void renewClaimedJob(claimed, isoAfter(LEASE_MS)).catch(() => undefined);
    }, 20_000);
    try {
      await runJob(claimed);
    } catch {
      await finish(claimed, {
        state: claimed.attempts >= 5 ? 'failed' : 'retry_wait',
        nextEligibleAt: isoAfter(Math.min(300_000, 15_000 * 2 ** Math.min(claimed.attempts, 4))),
        errorCode: 'delivery_unavailable',
      });
    } finally { clearInterval(heartbeat); }
    const updated = (await listJobs()).find((item) => item.id === claimed.id);
    if (updated?.state === 'completed') written += 1;
    else if (updated?.state === 'blocked' || updated?.state === 'needs_review') blocked += 1;
    else skipped += 1;
    if (claimed.destinationId === 'notion') await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { written, blocked, skipped };
}
