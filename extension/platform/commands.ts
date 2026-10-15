import { ingestDraft } from '../core/archive/ingest.ts';
import { clearArchive, listJobs, listRecentConversations, readConversation, saveJob } from '../core/archive/repository.ts';
import { renderConversationMarkdown, renderMessageMarkdown } from '../destinations/markdown/render.ts';
import { acceptIncomingMarkdown, deliverMarkdown, resolveMarkdownNotePath } from '../destinations/markdown/deliver.ts';
import { readRootHandle } from '../destinations/markdown/handle-store.ts';
import { readFolderAccess } from '../destinations/markdown/permission.ts';
import { configureNotion, disconnectNotion, readNotionConfig, readNotionStatus, clearNotionDeliveryIssue } from '../destinations/notion/config.ts';
import { retryDestinationQueue, runDeliveryQueue } from '../core/queue/runner.ts';
import { titleFromText } from '../providers/shared/extract.ts';
import { readSettings, writeSettings, type Settings } from '../core/settings.ts';
import {
  discoverPending, readInbox, readSyncStatus, savePending, readImportSessions,
  startSync, pauseImports, startResumeImports, syncOne, getProviderHostFetch, resetProviderFailure,
} from '../core/sync/run.ts';
import { collectRedactedShapes, exportSamplePayloads } from '../core/sync/samples.ts';
import { parseTrustedCommand, type TrustedCommand } from '../core/contracts/messages.ts';
import { getEntitlementStatus, activateLicense, deactivateLicense } from '../core/licensing/policy.ts';
import { listArchiveRows, searchArchive } from '../core/search/index.ts';
import { isTrustedExtensionSender } from './trusted-sender.ts';
import { checkClaudeConnection, clearClaudeConnectionCheck, readClaudeConnectionCheck, readClaudeConnectionReport } from '../core/sync/claude-connection.ts';
import type { ArchivedMessage } from '../core/contracts/conversation.ts';
import { ProviderRequestError } from '../core/sync/transport.ts';
import { CLAUDE_ENABLED } from '../core/provider-features.ts';
import { readHistoryUsage } from '../core/sync/persistence.ts';
import { readCaptureHealth, collectCaptureRuntime } from '../core/sync/capture-health.ts';

function syncError(error: string | null | undefined): string | null {
  if (!error) return null;
  const messages: Record<string, string> = {
    needs_signin: 'Sign into this provider, refresh its tab, and try again.',
    blocked: 'The provider blocked this request. Open its site and refresh before retrying.',
    rate_limited: 'The provider asked us to slow down. Saving will retry automatically.',
    unreadable: 'The provider returned a format this build could not read.',
    unreadable_conversation: 'One conversation could not be read. Open it and try saving it manually.',
    skipped_unreadable: 'Some chats could not be read and were skipped. The rest of the import continued.',
    claude_accounts_skipped: 'Saved accessible Claude history. Some Claude workspaces were unavailable; those chats were not imported.',
    provider_request_failed: 'Could not contact the provider. Check your connection and sign-in.',
    unavailable: 'The provider is temporarily unavailable. Saving will retry automatically.',
    trial_history_limit: 'Your history import allowance is used. Saving an open chat is still available.',
    entitlement_inactive: 'Automatic and bulk saving are paused. Manual saving and your archive remain available.',
    paused: 'History saving is paused.',
  };
  return messages[error] ?? (/^[a-z_]+$/.test(error) ? 'Saving needs attention. Check the provider and retry.' : error);
}

async function readStatus(): Promise<Record<string, unknown>> {
  const [stored, handle, jobs, settings, notionStatus, license, sync, imports, claudeConnection, historyUsage] = await Promise.all([
    browser.storage.local.get('connectedProviders'), readRootHandle(), listJobs(),
    readSettings(), readNotionStatus(), getEntitlementStatus(), readSyncStatus(), readImportSessions(),
    readClaudeConnectionCheck(),
    readHistoryUsage(),
  ]);
  const connected = Array.isArray(stored.connectedProviders)
    ? stored.connectedProviders.filter((value): value is string => ['chatgpt', 'claude', 'grok'].includes(value) && (CLAUDE_ENABLED || value !== 'claude')) : [];
  return {
    folder: await readFolderAccess(handle), folderName: handle?.name ?? null,
    pendingJobs: jobs.filter((job) => ['pending', 'running', 'retry_wait'].includes(job.state)).length,
    blockedJobs: jobs.filter((job) => ['blocked', 'needs_review', 'failed'].includes(job.state)).length,
    connected, notion: Boolean(await readNotionConfig()), notionStatus, claudeConnection: CLAUDE_ENABLED ? claudeConnection : null,
    settings, license, sync: sync.map((item) => ({ ...item, errorCode: item.error, error: syncError(item.error) })),
    historyUsage: historyUsage.filter((item) => CLAUDE_ENABLED || item.provider !== 'claude').map((item) => ({ ...item, limit: license.historyLimit })),
    deliveryIssues: await Promise.all(jobs.filter((job) => ['blocked', 'failed', 'needs_review'].includes(job.state)).map(async (job) => ({
      id: job.id, destinationId: job.destinationId, state: job.state, errorCode: job.errorCode,
      title: (await readConversation(job.conversationKey))?.title ?? 'Archived conversation',
    }))),
    imports: imports.filter((item) => CLAUDE_ENABLED || item.provider !== 'claude').map(({ id, provider, state, discoveredCount, completedCount, error, nextEligibleAt }) =>
      ({ id, provider, state, discoveredCount, completedCount, errorCode: error ?? null, nextEligibleAt: nextEligibleAt ?? null, error: syncError(error) })),
  };
}

async function archivedMessage(key: string): Promise<string> {
  const jobs = (await listJobs()).filter((job) => job.conversationKey === key);
  if (jobs.some((job) => job.state === 'needs_review')) return 'Archived locally. A destination needs your review in Settings.';
  if (jobs.some((job) => job.state === 'blocked' || job.state === 'failed')) return 'Archived locally. A destination needs attention in Settings.';
  if (jobs.some((job) => ['pending', 'running', 'retry_wait'].includes(job.state))) return 'Archived locally. Destination delivery will continue in the background.';
  return 'Conversation archived. Check its destination status in the archive.';
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return null;
  try { return { tab, url: new URL(tab.url) }; } catch { return null; }
}

async function captureGrok(): Promise<{ ok: boolean; message: string }> {
  const active = await activeTab();
  if (!active) return { ok: false, message: 'Open a Grok conversation first.' };
  const { tab, url } = active;
  const allowed = url.protocol === 'https:' &&
    (url.hostname === 'grok.com' || url.hostname.endsWith('.grok.com') ||
      (url.hostname === 'x.com' || url.hostname.endsWith('.x.com')) && url.pathname.includes('/grok'));
  const id = url.pathname.split('/').filter(Boolean).at(-1);
  if (!allowed || !id || ['grok', 'chat', 'chats', 'home', 'c'].includes(id) || id.length < 6) {
    return { ok: false, message: 'Open an individual Grok conversation, then save it.' };
  }
  const [result] = await browser.scripting.executeScript({
    target: { tabId: tab.id! },
    func: () => {
      const nodes = [...document.querySelectorAll('main article, main [data-testid*="message"]')];
      const turns = nodes.map((node) => {
        const hint = [node.getAttribute('data-role'), node.getAttribute('data-author'), node.getAttribute('data-message-author-role')].filter(Boolean).join(' ').toLowerCase();
        return { role: /user|human/.test(hint) ? 'user' : /assistant|grok/.test(hint) ? 'assistant' : null, text: (node.textContent ?? '').trim() };
      }).filter((turn) => turn.text.length > 0);
      const text = turns.length ? turns.map((turn) => turn.text).join('\n\n') : (document.querySelector('main') as HTMLElement | null)?.innerText ?? '';
      const maximum = 500_000;
      return { turns: text.length > maximum ? [] : turns, text: text.slice(0, maximum), truncated: text.length > maximum, title: document.title };
    },
  });
  const capture = result?.result as {
    turns?: Array<{ role: string | null; text: string }>; text?: string; truncated?: boolean; title?: string;
  } | undefined;
  if (!capture?.text?.trim()) return { ok: false, message: 'No conversation text was visible. Load the conversation and try again.' };
  const attributed = capture.turns?.length && capture.turns.every((turn) => turn.role === 'user' || turn.role === 'assistant');
  const entries = attributed ? capture.turns!.map((turn) => ({ role: turn.role as 'user' | 'assistant', text: turn.text }))
    : [{ role: 'system' as const, text: 'Visible transcript — speaker attribution unavailable.\n\n' + capture.text }];
  const messages: ArchivedMessage[] = entries.map((entry) => ({
    sourceId: null, role: entry.role, blocks: [{ type: 'text', text: entry.text }],
    createdAt: null, model: null, parentId: null, branchId: null,
  }));
  const key = 'grok:default:' + id;
  const warning = [
    'This manual capture contains rendered text only. Load older messages before saving again.',
    attributed ? '' : 'Speaker attribution could not be verified.',
    capture.truncated ? 'The visible transcript exceeded the capture size limit and was truncated.' : '',
  ].filter(Boolean).join(' ');
  const outcome = await ingestDraft({
    provider: 'grok', accountScope: 'default', sourceId: id, sourceUrl: tab.url!,
    title: capture.title?.replace(/\s*[-|]\s*Grok\s*$/i, '').trim() || titleFromText(capture.text),
    text: '', messages, replace: true, completeness: 'partial', warning,
    manual: true, captureKind: 'manual',
  });
  if (outcome === 'ignored' || outcome === 'paused') return { ok: false, message: 'This visible transcript could not be archived.' };
  await runDeliveryQueue();
  return { ok: true, message: await archivedMessage(key) + ' Visible-text capture is marked partial.' };
}

async function saveActiveConversation(): Promise<{ ok: boolean; message: string }> {
  const active = await activeTab();
  if (!active) return { ok: false, message: 'Open a ChatGPT, Claude or Grok conversation first.' };
  const { url } = active;
  if (url.hostname === 'grok.com' || url.hostname.endsWith('.grok.com') ||
    (url.hostname === 'x.com' || url.hostname.endsWith('.x.com')) && url.pathname.includes('/grok')) return captureGrok();
  const provider = url.hostname === 'chatgpt.com' ? 'chatgpt' : url.hostname === 'claude.ai' ? 'claude' : null;
  if (provider === 'claude' && !CLAUDE_ENABLED) return { ok: false, message: 'Claude is temporarily disabled in this testing build.' };
  if (!provider || url.protocol !== 'https:') return { ok: false, message: 'Open a supported provider conversation first.' };
  const parts = url.pathname.split('/').filter(Boolean);
  const marker = provider === 'chatgpt' ? 'c' : 'chat';
  const index = parts.lastIndexOf(marker);
  const id = index >= 0 ? parts[index + 1] : null;
  if (!id) return { ok: false, message: 'Open an individual conversation, then save it.' };
  let scopes = ['default'];
  if (provider === 'claude') {
    const response = await getProviderHostFetch(provider)('https://claude.ai/api/organizations');
    if (!response.ok) return { ok: false, message: 'Sign into Claude, then refresh its tab and try again.' };
    const body = JSON.parse(response.body) as Array<{ uuid?: string }> | { data?: Array<{ uuid?: string }> };
    scopes = (Array.isArray(body) ? body : body.data ?? []).flatMap((row) => typeof row.uuid === 'string' ? [row.uuid] : []);
  }
  let blockedScope = false;
  for (const scope of scopes) {
    try {
      const outcome = await syncOne(provider, scope, id, { manual: true });
      if (outcome === 'saved') return { ok: true, message: await archivedMessage(provider + ':' + scope + ':' + id) };
    } catch (error) {
      // The open chat can belong to a different connected Claude workspace.
      if (provider === 'claude' && error instanceof ProviderRequestError && error.code === 'blocked') { blockedScope = true; continue; }
      throw error;
    }
  }
  if (blockedScope) return { ok: false, message: 'Claude denied access to this conversation in the connected workspaces. Check its workspace access in Claude.' };
  return { ok: false, message: 'The provider did not return a readable transcript. Confirm you are signed in and refresh the conversation.' };
}

async function requeueDestination(destinationId: 'markdown' | 'notion'): Promise<void> {
  for (const conversation of await listRecentConversations()) {
    await saveJob({
      id: destinationId + ':' + conversation.key + ':' + conversation.revision,
      conversationKey: conversation.key, revision: conversation.revision, destinationId,
      operation: 'upsert', state: 'pending', attempts: 0, nextEligibleAt: null,
      leaseOwner: null, leaseExpiresAt: null, checkpoint: null, errorCode: null,
    });
  }
}

async function resolveEdit(jobId: string, choice: 'keep' | 'replace' | 'copy') {
  const job = (await listJobs()).find((item) => item.id === jobId);
  if (!job || job.state !== 'needs_review' || job.destinationId !== 'markdown') {
    return { ok: false, message: 'This file review is no longer available.' };
  }
  const conversation = await readConversation(job.conversationKey);
  if (!conversation || conversation.revision !== job.revision) return { ok: false, message: 'A newer conversation revision is available. Refresh the review list.' };
  if (choice === 'copy') {
    if (await acceptIncomingMarkdown(conversation) !== 'written') return { ok: false, message: 'The incoming copy needs attention. Check folder access and that the copy has not been edited.' };
  } else if (choice === 'replace') {
    const settings = await readSettings();
    const markdown = renderConversationMarkdown(conversation, {
      includeSources: settings.includeSources,
      notePath: await resolveMarkdownNotePath(conversation, { projects: settings.saveClaudeProjects }),
    });
    if (await deliverMarkdown(conversation, markdown, { replaceEdits: true }) === 'blocked') return { ok: false, message: 'Allow the folder again before replacing the note.' };
  }
  await saveJob({ ...job, state: 'completed', errorCode: choice === 'keep' ? 'kept_user_edits' : null, leaseOwner: null, leaseExpiresAt: null });
  return { ok: true, message: choice === 'copy' ? 'The incoming copy is now the synced note. Your original edited note remains untouched.' : choice === 'keep' ? 'Your edited note was kept.' : 'The note was replaced with the archived conversation.' };
}

async function diagnosticsText(): Promise<string> {
  const [settings, sync, claudeConnection, captureHealth, captureRuntime] = await Promise.all([readSettings(), readSyncStatus(), readClaudeConnectionReport(), readCaptureHealth(), collectCaptureRuntime()]);
  const { folderDiskPath: _privatePath, ...safeSettings } = settings;
  void _privatePath;
  let providerShapes: unknown;
  try { providerShapes = await collectRedactedShapes(); }
  catch { providerShapes = { error: 'unavailable' }; }
  return JSON.stringify({
    name: browser.runtime.getManifest().name, version: browser.runtime.getManifest().version,
    browser: navigator.userAgent, settings: safeSettings,
    sync: sync.map(({ provider, state, discoveredCount, savedCount }) => ({ provider, state, discoveredCount, savedCount })),
    claudeConnection,
    captureHealth,
    captureRuntime,
    providerShapes,
  }, null, 2);
}

async function handleCommand(message: TrustedCommand): Promise<unknown> {
  if (!CLAUDE_ENABLED && (
    message.action === 'provider.check' || message.action === 'provider.reset' ||
    'provider' in message && message.provider === 'claude' && !message.action.startsWith('archive.') ||
    message.action === 'inbox.save' && message.chat.provider === 'claude' ||
    (message.action === 'import.pause' || message.action === 'import.resume') && message.importId.endsWith('claude')
  )) return { ok: false, message: 'Claude is temporarily disabled in this testing build.' };
  switch (message.action) {
    case 'status.get': return readStatus();
    case 'provider.check': return checkClaudeConnection();
    case 'provider.reset': {
      await resetProviderFailure(message.provider);
      await clearClaudeConnectionCheck();
      return { ok: true, message: 'Previous Claude connection failures were reset. Saved chats and import progress are kept. Check connection to verify current access.' };
    }
    case 'settings.get': return readSettings();
    case 'settings.set': {
      const previous = await readSettings();
      const next = await writeSettings(message.patch as Partial<Settings>);
      if (previous.syncIntervalMinutes !== next.syncIntervalMinutes) {
        await browser.alarms.create('vaultdraft-sync', { periodInMinutes: next.syncIntervalMinutes });
      }
      if (!previous.markdownEnabled && next.markdownEnabled) {
        await requeueDestination('markdown');
        void runDeliveryQueue().catch(() => undefined);
      }
      return next;
    }
    case 'archive.list': return message.provider ? searchArchive({ query: '', provider: message.provider }) : listArchiveRows();
    case 'archive.search': return searchArchive({ query: message.query, provider: message.provider });
    case 'archive.get': {
      const conversation = await readConversation(message.key);
      if (!conversation) return null;
      return {
        key: conversation.key, title: conversation.title, provider: conversation.provider,
        sourceUrl: conversation.sourceUrl, capturedAt: conversation.capturedAt,
        completeness: conversation.completeness, warnings: conversation.warnings.map((warning) => warning.description),
        messages: conversation.messages.map((entry) => ({ role: entry.role, text: renderMessageMarkdown(entry) })),
      };
    }
    case 'archive.read': {
      const conversation = await readConversation(message.key);
      return conversation ? renderConversationMarkdown(conversation) : '';
    }
    case 'inbox.read': return readInbox();
    case 'inbox.refresh': {
      const license = await getEntitlementStatus();
      if (!license.canImportHistory) return { ...await readInbox(), notice: 'The trial has ended. Manual saving of the open conversation is still available.' };
      return discoverPending(Math.min((await readSettings()).latestSaveCount, license.historyLimit ?? 500));
    }
    case 'inbox.save': {
      const result = await savePending({ ...message.chat, projectName: message.chat.projectName ?? null, projectSlug: message.chat.projectSlug ?? null });
      return result.ok ? { ok: true, message: await archivedMessage(message.chat.provider + ':' + message.chat.accountScope + ':' + message.chat.id) } : result;
    }
    case 'sync.run': return startSync({ maxItems: message.full ? null : message.limit ?? (await readSettings()).latestSaveCount, manual: true, provider: message.provider });
    case 'import.start': return startSync({ maxItems: (await readSettings()).latestSaveCount, manual: true, provider: message.provider });
    case 'sync.pause': await pauseImports(message.provider); return { ok: true, message: 'History saving will pause after the current request.' };
    case 'import.pause': await pauseImports(message.importId.endsWith('claude') ? 'claude' : 'chatgpt'); return { ok: true };
    case 'sync.resume': return startResumeImports(message.provider);
    case 'import.resume': return startResumeImports(message.importId.endsWith('claude') ? 'claude' : 'chatgpt');
    case 'import.status': return (await readImportSessions()).filter((item) => CLAUDE_ENABLED || item.provider !== 'claude');
    case 'notion.save': {
      if (!await browser.permissions.contains({ origins: ['https://api.notion.com/*'] })) return { ok: false, message: 'Allow Notion access from the connection screen, then try again.' };
      const result = await configureNotion(message);
      if (result.ok) {
        await requeueDestination('notion');
        void runDeliveryQueue().catch(() => undefined);
      }
      return result;
    }
    case 'notion.disconnect': {
      await disconnectNotion();
      for (const job of await listJobs()) {
        if (job.destinationId === 'notion' && job.state !== 'completed') {
          await saveJob({ ...job, state: 'blocked', errorCode: 'notion_not_configured', leaseOwner: null, leaseExpiresAt: null });
        }
      }
      return { ok: true, message: 'Notion disconnected. Existing pages remain in your workspace.' };
    }
    case 'notion.status': return readNotionStatus();
    case 'license.status': return getEntitlementStatus();
    case 'license.activate': {
      if (!await browser.permissions.contains({ origins: ['https://live.dodopayments.com/*'] })) return { ok: false, message: 'Allow license verification from the License screen, then try again.' };
      return activateLicense(message.licenseKey);
    }
    case 'license.deactivate': return deactivateLicense();
    case 'conversation.save':
    case 'capture.active': return saveActiveConversation();
    case 'grok.capture': return captureGrok();
    case 'history.import': {
      const tab = await activeTab();
      const provider = tab?.url.hostname === 'chatgpt.com' ? 'chatgpt' : tab?.url.hostname === 'claude.ai' ? 'claude' : undefined;
      if (provider === 'claude' && !CLAUDE_ENABLED) return { ok: false, message: 'Claude is temporarily disabled in this testing build.' };
      if (!provider) return { ok: false, message: 'Open ChatGPT or Claude to import history.' };
      return startSync({ maxItems: 25, manual: true, provider });
    }
    case 'edits.list': {
      const result: Array<{ id: string; conversationKey: string }> = [];
      for (const job of await listJobs()) {
        if (job.state !== 'needs_review' || job.destinationId !== 'markdown') continue;
        const conversation = await readConversation(job.conversationKey);
        if (conversation?.revision === job.revision) result.push({ id: job.id, conversationKey: job.conversationKey });
      }
      return result;
    }
    case 'edits.resolve': return resolveEdit(message.jobId, message.choice);
    case 'queue.run': return retryDestinationQueue();
    case 'job.retry':
    case 'delivery.retry': {
      const job = (await listJobs()).find((item) => item.id === message.jobId);
      if (!job) return { ok: false, message: 'That delivery job is unavailable.' };
      if (job.state === 'needs_review' && job.destinationId === 'markdown') return { ok: false, message: 'Review this file before retrying, so your edits are preserved.' };
      if (job.state === 'running') return { ok: false, message: 'This delivery is already running.' };
      if (job.destinationId === 'notion') await clearNotionDeliveryIssue();
      await saveJob({ ...job, state: 'pending', attempts: 0, nextEligibleAt: null, errorCode: null, leaseOwner: null, leaseExpiresAt: null });
      return { ok: true, ...await runDeliveryQueue() };
    }
    case 'diagnostics.copy': return diagnosticsText();
    case 'samples.export': return exportSamplePayloads();
    case 'archive.clear': await pauseImports(); await clearArchive(); return { ok: true, message: 'The browser archive was cleared. Files and Notion pages remain unchanged.' };
    default: return { ok: false, message: 'This action is not available.' };
  }
}

export function registerArchiveCommands(): void {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedExtensionSender(sender) || !message || typeof message !== 'object') return;
    // These commands have dedicated validated listeners.
    if (message.action === 'provider.connect' || message.action === 'provider.disconnect' ||
      message.action === 'folder.saveHandle' || message.action === 'folder.writeTest') return;
    const parsed = parseTrustedCommand(message);
    if (!parsed.success) {
      sendResponse(message.action === 'settings.set' ? null : { ok: false, message: 'This action has invalid fields. Check the values and try again.' });
      return;
    }
    void handleCommand(parsed.data).then(sendResponse, () => {
      sendResponse(parsed.data.action === 'settings.set' ? null : { ok: false, message: 'Could not finish this action. Check connection and destination status, then try again.' });
    });
    return true;
  });
}
