import { ingestDraft } from '../archive/ingest.ts';
import { readConversation } from '../archive/repository.ts';
import { conversationKey } from '../contracts/conversation.ts';
import type { ArchivedConversation } from '../contracts/conversation.ts';
import { readSettings } from '../settings.ts';
import { runDeliveryQueue } from '../queue/runner.ts';
import { accessTokenFromSession, chatGptSyncApi } from '../../providers/chatgpt/api.ts';
import { claudeSyncApi, readVisibleClaudeChat } from '../../providers/claude/api.ts';
import { type ListedChat, type SyncApi } from './engine.ts';
import { fetchWithTabFallback, ProviderRequestError, type HostFetch, type HostResponse } from './transport.ts';
import { createClaudeImportReport } from './claude-connection.ts';
import { CLAUDE_ENABLED } from '../provider-features.ts';
import type { SyncProviderStatus } from './types.ts';
import { getEntitlementStatus } from '../licensing/policy.ts';
import { recordCaptureHealth } from './capture-health.ts';
import { enrichVisibleClaudeImages } from '../../providers/claude/visible-images.ts';
import { admitHistory, claimImport, checkpointImport, readImportSessions, setImportPause, resetImportFailure, persistCapture, readScheduledCaptures, finishCapture, discardDisconnectedCaptures } from './persistence.ts';
export { readImportSessions } from './persistence.ts';

const STATUS_KEY = 'syncStatus';
const PAUSE_KEY = 'syncPaused';
const INBOX_KEY = 'pendingChats';
const CHECKED_KEY = 'inboxCheckedAt';

export interface PendingChat {
  provider: 'chatgpt' | 'claude';
  id: string;
  accountScope: string;
  title: string;
  updatedAt: string | null;
  projectName: string | null;
  projectSlug: string | null;
}

function hostFor(provider: 'chatgpt' | 'claude', onAttempt?: Awaited<ReturnType<typeof createClaudeImportReport>>['onAttempt']): HostFetch {
  const query = provider === 'chatgpt' ? 'https://chatgpt.com/*' : 'https://claude.ai/*';
  let token: Promise<string | null> | null = null;
  return async (url: string): Promise<HostResponse> => {
    if (provider === 'claude' && !CLAUDE_ENABLED) throw new ProviderRequestError('blocked');
    const headers: Record<string, string> = {};
    if (provider === 'chatgpt') {
      token ??= readChatGptToken(query);
      const accessToken = await token;
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
    }
    const result = await fetchWithTabFallback(url, query, headers, { onAttempt: onAttempt ? (attempt) => onAttempt(url, attempt) : undefined });
    if (result === 'no_tab') {
      return { ok: false, status: 401, body: '' };
    }
    return result;
  };
}
export const getProviderHostFetch = hostFor;

async function readChatGptToken(query: string): Promise<string | null> {
  const result = await fetchWithTabFallback('https://chatgpt.com/api/auth/session', query);
  if (result === 'no_tab' || !result.ok) {
    return null;
  }
  return accessTokenFromSession(result.body);
}

function connectedApis(connected: unknown, provider?: 'chatgpt' | 'claude'): SyncApi[] {
  const list = Array.isArray(connected) ? connected : [];
  const apis: SyncApi[] = [];
  if (list.includes('chatgpt') && provider !== 'claude') {
    apis.push(chatGptSyncApi);
  }
  if (CLAUDE_ENABLED && list.includes('claude') && provider !== 'chatgpt') {
    apis.push(claudeSyncApi);
  }
  return apis;
}

export async function readInbox(): Promise<{ chats: PendingChat[]; checkedAt: string | null }> {
  const stored = await browser.storage.local.get([INBOX_KEY, CHECKED_KEY]);
  const chats = Array.isArray(stored[INBOX_KEY]) ? (stored[INBOX_KEY] as PendingChat[]) : [];
  return {
    chats: chats.filter((chat) => chat && (chat.provider === 'chatgpt' || CLAUDE_ENABLED && chat.provider === 'claude') && typeof chat.id === 'string'),
    checkedAt: typeof stored[CHECKED_KEY] === 'string' ? stored[CHECKED_KEY] : null,
  };
}

async function providerConnected(provider: 'chatgpt' | 'claude'): Promise<boolean> {
  if (provider === 'claude' && !CLAUDE_ENABLED) return false;
  const stored = await browser.storage.local.get('connectedProviders');
  return Array.isArray(stored.connectedProviders) && stored.connectedProviders.includes(provider);
}

async function automaticCaptureAllowed(provider: 'chatgpt' | 'claude'): Promise<boolean> {
  return await providerConnected(provider) && (await readSettings()).autoSync && (await getEntitlementStatus()).autoCaptureAllowed;
}

export async function discoverPending(limit: number): Promise<{ chats: PendingChat[]; notice: string | null; checkedAt: string }> {
  const entitlement = await getEntitlementStatus();
  if (!entitlement.canImportHistory) return { chats: [], notice: 'History importing is paused because your trial or license is inactive.', checkedAt: new Date().toISOString() };
  const cap = Math.min(entitlement.historyLimit ?? 500, Math.max(1, Math.round(limit) || 5));
  const stored = await browser.storage.local.get('connectedProviders');
  const apis = connectedApis(stored.connectedProviders);
  const chats: PendingChat[] = [];
  let signedOut = false;
  let failure: string | null = null;
  for (const api of apis) {
    let cursor: string | null = null;
    let found = 0;
    const seen = new Set<string>();
    try {
      do {
        const page = await api.list(cursor, cap - found, hostFor(api.provider));
        if (page === 'needs_signin') { signedOut = true; break; }
        if (page.warning) failure = 'Accessible Claude history was checked. Some Claude workspaces were unavailable; their chats were not included.';
        for (const item of page.items) {
          const key = conversationKey(api.provider, item.accountScope, item.id);
          if (seen.has(key)) continue;
          seen.add(key);
          if (await readConversation(key)) continue;
          chats.push(pendingFrom(api.provider, item)); found += 1;
          if (found >= cap) break;
        }
        if (page.nextCursor && page.nextCursor === cursor) throw new ProviderRequestError('unreadable');
        cursor = page.nextCursor;
      } while (cursor && found < cap);
    } catch (error) { failure = error instanceof ProviderRequestError ? `Provider request: ${error.code}. Try again later.` : 'The provider request failed. Try again later.'; }
  }
  const checkedAt = new Date().toISOString();
  await browser.storage.local.set({ [INBOX_KEY]: chats, [CHECKED_KEY]: checkedAt });
  const notice =
    apis.length === 0
      ? 'Connect ChatGPT or Claude in Settings.'
      : chats.length === 0 && signedOut
        ? 'Sign in to ChatGPT or Claude in this browser, then check again.'
        : failure;
  return { chats, notice, checkedAt };
}

function pendingFrom(provider: 'chatgpt' | 'claude', item: ListedChat): PendingChat {
  return {
    provider,
    id: item.id,
    accountScope: item.accountScope,
    title: item.title,
    updatedAt: item.updatedAt,
    projectName: item.projectName,
    projectSlug: item.projectSlug,
  };
}

export async function savePending(chat: PendingChat): Promise<{ ok: boolean; message: string }> {
  if (chat.provider === 'claude' && !CLAUDE_ENABLED) return { ok: false, message: 'Claude is temporarily disabled in this testing build.' };
  const entitlement = await getEntitlementStatus();
  if (!entitlement.canImportHistory) return { ok: false, message: 'History importing is paused because your trial or license is inactive.' };
  const api = chat.provider === 'chatgpt' ? chatGptSyncApi : claudeSyncApi;
  let outcome: 'saved' | 'needs_signin' | 'unreadable' = 'unreadable';
  try {
    const conversation = await api.get(chat, hostFor(chat.provider));
    if (conversation === 'needs_signin') outcome = 'needs_signin';
    else if (conversation) {
      if (!await admitHistory(chat.provider, chat, entitlement.historyLimit)) return { ok: false, message: 'Your trial includes 25 unique historical chats per provider. Activate a license to import more.' };
      await saveConversation(conversation, true); outcome = 'saved';
    }
  } catch (error) { return { ok: false, message: error instanceof ProviderRequestError ? `Provider request: ${error.code}. Try again later.` : 'The provider request failed. Try again later.' }; }
  if (outcome === 'needs_signin') {
    return { ok: false, message: `Sign in to ${chat.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} in this browser, then try that chat again.` };
  }
  const saved = await readConversation(conversationKey(chat.provider, chat.accountScope, chat.id));
  if (outcome !== 'saved' || !saved) {
    return { ok: false, message: 'The provider sent this chat in a form Chatlog could not read.' };
  }
  const inbox = await readInbox();
  await browser.storage.local.set({
    [INBOX_KEY]: inbox.chats.filter((item) => item.provider !== chat.provider || item.accountScope !== chat.accountScope || item.id !== chat.id),
  });
  const delivery = await runDeliveryQueue();
  if (delivery.blocked > 0) {
    return { ok: true, message: 'Saved. Allow the folder in Settings so the Markdown file can be written.' };
  }
  return { ok: true, message: 'Saved to your archive. Destination delivery is tracked separately.' };
}

async function saveConversation(conversation: ArchivedConversation, history = false, manual = false): Promise<void> {
  const outcome = await ingestDraft({
    provider: conversation.provider,
    accountScope: conversation.accountScope,
    sourceId: conversation.sourceId,
    sourceUrl: conversation.sourceUrl,
    title: conversation.title,
    text: '',
    messages: conversation.messages,
    replace: true,
    completeness: conversation.completeness,
    warning: conversation.warnings[0]?.description ?? null,
    manual: history || manual,
    captureKind: history ? 'history' : manual ? 'manual' : 'automatic',
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    warnings: conversation.warnings,
    projectName: conversation.projectName,
    projectSlug: conversation.projectSlug,
  });
  if (outcome !== 'saved' && outcome !== 'unchanged') throw new Error('archive_write_not_accepted');
}

async function remember(next: SyncProviderStatus): Promise<void> {
  const stored = await browser.storage.local.get(STATUS_KEY);
  const current = Array.isArray(stored[STATUS_KEY]) ? (stored[STATUS_KEY] as SyncProviderStatus[]) : [];
  const rest = current.filter((item) => item.provider !== next.provider);
  await browser.storage.local.set({ [STATUS_KEY]: [...rest, next] });
}

export async function readSyncStatus(): Promise<SyncProviderStatus[]> {
  const stored = await browser.storage.local.get(STATUS_KEY);
  const statuses = Array.isArray(stored[STATUS_KEY]) ? (stored[STATUS_KEY] as SyncProviderStatus[]) : [];
  for (const session of await readImportSessions()) {
    if (session.provider === 'claude' && !CLAUDE_ENABLED) continue;
    const prior = statuses.find((item) => item.provider === session.provider);
    const quietError = session.error === 'paused' || session.error === 'trial_history_limit' || session.error === 'skipped_unreadable' || session.error === 'claude_accounts_skipped';
    const next: SyncProviderStatus = { provider: session.provider, state: session.state === 'running' ? session.error ? 'error' : 'running' : session.error === 'needs_signin' ? 'needs_signin' : session.error && !quietError ? 'error' : 'ok', lastRunAt: prior?.lastRunAt ?? null, discoveredCount: session.discoveredCount, savedCount: session.completedCount, error: session.error ?? (session.state === 'paused' ? 'paused' : null) };
    const index = statuses.findIndex((item) => item.provider === session.provider);
    if (index >= 0) statuses[index] = next; else statuses.push(next);
  }
  return statuses.filter((item) => CLAUDE_ENABLED || item.provider !== 'claude');
}

/** Persist work before returning to a popup; startup/alarm recovery owns unfinished work. */
export async function startSync(options: { maxItems: number | null; manual?: boolean; provider?: 'chatgpt' | 'claude' }): Promise<SyncProviderStatus[]> {
  const entitlement = await getEntitlementStatus();
  const settings = await readSettings();
  if (!entitlement.canImportHistory || (!options.manual && (!settings.autoSync || !entitlement.autoCaptureAllowed))) return readSyncStatus();
  const stored = await browser.storage.local.get('connectedProviders');
  const selected: Array<'chatgpt' | 'claude'> = [];
  for (const api of connectedApis(stored.connectedProviders, options.provider)) {
    const maxItems = options.maxItems === null ? entitlement.historyLimit : Math.max(1, Math.floor(Math.min(options.maxItems, entitlement.historyLimit ?? Infinity)) || 1);
    const session = await claimImport(api.provider, { ...options, maxItems });
    if (!session) continue;
    await checkpointImport(session, true);
    await remember({ provider: api.provider, state: 'running', lastRunAt: new Date().toISOString(), discoveredCount: session.discoveredCount, savedCount: session.completedCount, error: null });
    selected.push(api.provider);
  }
  const statuses = await readSyncStatus();
  for (const provider of selected) void runSync({ ...options, provider }).catch(async () => {
    await remember({ provider, state: 'error', lastRunAt: new Date().toISOString(), discoveredCount: 0, savedCount: 0, error: 'import_interrupted' });
  });
  return statuses;
}

export async function runSync(options: {
  maxItems: number | null;
  manual?: boolean;
  provider?: 'chatgpt' | 'claude';
}): Promise<SyncProviderStatus[]> {
  const settings = await readSettings();
  const entitlement = await getEntitlementStatus();
  if (!entitlement.canImportHistory || (!options.manual && (!settings.autoSync || !entitlement.autoCaptureAllowed))) {
    await setImportPause(true, options.provider);
    return readSyncStatus();
  }
  const stored = await browser.storage.local.get('connectedProviders');
  const apis = connectedApis(stored.connectedProviders, options.provider);
  const results: SyncProviderStatus[] = [];
  for (const api of apis) {
    const requested = options.maxItems !== null && (!Number.isFinite(options.maxItems) || options.maxItems <= 0) ? 1 : options.maxItems === null ? null : Math.floor(options.maxItems);
    const session = await claimImport(api.provider, { ...options, maxItems: entitlement.historyLimit === null ? requested : Math.min(requested ?? entitlement.historyLimit, entitlement.historyLimit) });
    if (!session) continue;
    const running: SyncProviderStatus = {
      provider: api.provider,
      state: 'running',
      lastRunAt: new Date().toISOString(),
      discoveredCount: session.discoveredCount,
      savedCount: session.completedCount,
      error: null,
    };
    await remember(running);
    const claudeReport = api.provider === 'claude' ? await createClaudeImportReport() : null;
    const request = hostFor(api.provider, claudeReport?.onAttempt);
    const host: HostFetch = async (url) => {
      if (!await checkpointImport(session) || session.state !== 'running') throw new Error('import_lease_lost_or_paused');
      return request(url);
    };
    session.checkpoint ??= { cursor: null, pending: [], exhausted: false };
    session.checkpoint.pending ??= [];
    let signin = false;
    try {
      while (session.state === 'running') {
        const flags = await browser.storage.local.get(PAUSE_KEY);
        const access = await getEntitlementStatus();
        if (flags[PAUSE_KEY] === true || !access.canImportHistory || !await providerConnected(api.provider) || (!session.manual && !(await readSettings()).autoSync)) { session.state = 'paused'; session.error = !access.canImportHistory ? 'entitlement_inactive' : 'paused'; break; }
        if (!await checkpointImport(session) || session.state !== 'running') break;
        if (session.maxItems !== null && session.maxItems !== undefined && session.discoveredCount >= session.maxItems && session.checkpoint.pending.length === 0) { session.state = 'completed'; break; }
        if (session.checkpoint.pending.length === 0) {
          if (session.checkpoint.exhausted) { session.state = 'completed'; break; }
          const remaining = session.maxItems == null ? 25 : Math.min(25, session.maxItems - session.discoveredCount);
          const page = await api.list(session.checkpoint.cursor, Math.max(1, remaining), host);
          if (page === 'needs_signin') { session.state = 'paused'; session.error = 'needs_signin'; signin = true; break; }
          if (page.warning) session.warning = page.warning;
          if (page.nextCursor && page.nextCursor === session.checkpoint.cursor) throw new ProviderRequestError('unreadable');
          session.checkpoint.pending = page.items;
          session.checkpoint.cursor = page.nextCursor;
          session.checkpoint.exhausted = page.nextCursor === null;
          session.discoveredCount += page.items.length;
          if (!await checkpointImport(session) || session.state !== 'running') break;
          continue;
        }
        const item = session.checkpoint.pending[0]!;
        const existing = await readConversation(conversationKey(api.provider, item.accountScope, item.id));
        if (!existing?.updatedAt || !item.updatedAt || existing.updatedAt < item.updatedAt) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          const conversation = await api.get(item, host);
          if (!await checkpointImport(session) || session.state !== 'running') break;
          if (!await providerConnected(api.provider)) { session.state = 'paused'; session.error = 'provider_disconnected'; break; }
          if (conversation === 'needs_signin') { session.state = 'paused'; session.error = 'needs_signin'; signin = true; break; }
          if (!conversation) {
            session.skippedCount = (session.skippedCount ?? 0) + 1;
            const skippedIds = session.skippedIds ?? [];
            if (skippedIds.length < 20) skippedIds.push(item.id);
            session.skippedIds = skippedIds;
            session.checkpoint.pending.shift();
            if (!await checkpointImport(session)) break;
            continue;
          }
          const trial = await browser.storage.local.get('trialStartedAt');
          const live = !session.manual && conversation.createdAt !== null && typeof trial.trialStartedAt === 'number' && Date.parse(conversation.createdAt) >= trial.trialStartedAt;
          if (!await checkpointImport(session) || session.state !== 'running') break;
          if (!live && !await admitHistory(api.provider, item, access.historyLimit)) { session.state = 'completed'; session.error = 'trial_history_limit'; break; }
          if (!await checkpointImport(session) || session.state !== 'running') break;
          await saveConversation(conversation, !live);
          session.completedCount += 1;
        }
        session.checkpoint.pending.shift();
        if (!await checkpointImport(session)) break;
      }
      if ((session.skippedCount ?? 0) > 0 && !session.error && session.state === 'completed') session.error = 'skipped_unreadable';
      if (session.warning && !session.error && session.state === 'completed') session.error = session.warning;
    } catch (error) {
      if (session.state === 'running') {
        session.error = error instanceof ProviderRequestError ? error.code : 'provider_request_failed';
        if (session.error === 'blocked' || session.error === 'unreadable') {
          session.state = 'paused';
          session.nextEligibleAt = null;
        } else {
          session.nextEligibleAt = new Date(error instanceof ProviderRequestError && error.retryAt ? error.retryAt : Date.now() + 60_000).toISOString();
        }
      }
    } finally {
      await checkpointImport(session, true);
      try { await claudeReport?.finish(session.error, Boolean(session.warning)); } catch { /* Access reports never interrupt saved imports. */ }
    }
    const quietError = session.error === 'paused' || session.error === 'trial_history_limit' || session.error === 'skipped_unreadable' || session.error === 'claude_accounts_skipped';
    const result: SyncProviderStatus = { ...running, state: signin ? 'needs_signin' : session.error && !quietError ? 'error' : 'ok', discoveredCount: session.discoveredCount, savedCount: session.completedCount, error: session.error ?? null };
    await remember(result);
    results.push(result);
  }
  await runDeliveryQueue();
  return results;
}

export async function syncOne(
  provider: 'chatgpt' | 'claude',
  accountScope: string,
  conversationId: string,
  options: { manual?: boolean } = {},
): Promise<'saved' | 'needs_signin' | 'unreadable' | 'history_limit'> {
  if (provider === 'claude' && !CLAUDE_ENABLED) return 'unreadable';
  if (!options.manual && !await automaticCaptureAllowed(provider)) return 'unreadable';
  const api = provider === 'chatgpt' ? chatGptSyncApi : claudeSyncApi;
  const conversation = provider === 'claude' && accountScope === '__visible__'
    ? await readVisibleClaudeChat(conversationId, hostFor(provider))
    : await api.get(
    {
      id: conversationId,
      title: 'Untitled',
      updatedAt: null,
      accountScope,
      projectName: null,
      projectSlug: null,
    },
    hostFor(provider),
  );
  if (!conversation || conversation === 'needs_signin') {
    await recordCaptureHealth(provider, conversation === 'needs_signin' ? 'needs_signin' : 'unreadable');
    return conversation === 'needs_signin' ? 'needs_signin' : 'unreadable';
  }
  if (!options.manual && !await automaticCaptureAllowed(provider)) return 'unreadable';
  if (!options.manual && conversation.createdAt) {
    const trial = await browser.storage.local.get('trialStartedAt');
    if (typeof trial.trialStartedAt === 'number' && Date.parse(conversation.createdAt) < trial.trialStartedAt &&
      !await admitHistory(provider, { id: conversation.sourceId, accountScope: conversation.accountScope, title: conversation.title, updatedAt: conversation.updatedAt, projectName: conversation.projectName, projectSlug: conversation.projectSlug }, (await getEntitlementStatus()).historyLimit)) {
      await recordCaptureHealth(provider, 'history_limit');
      return 'history_limit';
    }
  }
  await saveConversation(await enrichVisibleClaudeImages(conversation), false, options.manual);
  await recordCaptureHealth(provider, 'saved');
  await runDeliveryQueue();
  return 'saved';
}

let captureTimer: ReturnType<typeof setTimeout> | null = null;
let captureRunning = false;

export function scheduleSyncOne(
  provider: 'chatgpt' | 'claude',
  accountScope: string,
  conversationId: string,
): void {
  void queueCaptureSignal(provider, accountScope, conversationId).catch(() => {
    // Async callers should use queueCaptureSignal to report a failed durable write.
  });
}

export async function queueCaptureSignal(provider: 'chatgpt' | 'claude', accountScope: string, conversationId: string, source: 'fetch' | 'visible' = 'fetch'): Promise<void> {
  if (provider === 'claude' && !CLAUDE_ENABLED) return;
  await persistCapture({ provider, accountScope, conversationId });
  await recordCaptureHealth(provider, 'queued', source);
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => { captureTimer = null; void runScheduledCaptures(); }, 5100);
}

export async function runScheduledCaptures(): Promise<void> {
  if (captureRunning) return;
  captureRunning = true;
  try {
    const stored = await browser.storage.local.get('connectedProviders');
    await discardDisconnectedCaptures(Array.isArray(stored.connectedProviders) ? stored.connectedProviders.filter((item): item is string => typeof item === 'string') : []);
    if (!(await readSettings()).autoSync || !(await getEntitlementStatus()).autoCaptureAllowed) return;
    for (const { key, signal } of await readScheduledCaptures()) {
      if (signal.provider === 'claude' && !CLAUDE_ENABLED) continue;
      if (signal.dueAt > Date.now()) continue;
      if (!await providerConnected(signal.provider)) { await finishCapture(key, signal, true); continue; }
      try {
        const result = await syncOne(signal.provider, signal.accountScope, signal.conversationId);
        await finishCapture(key, signal, result === 'saved' || result === 'history_limit');
      } catch (error) {
        await recordCaptureHealth(signal.provider, error instanceof ProviderRequestError && ['blocked', 'rate_limited'].includes(error.code) ? error.code as 'blocked' | 'rate_limited' : 'unavailable');
        await finishCapture(key, signal, false, error instanceof ProviderRequestError ? error.retryAt ?? undefined : undefined);
      }
    }
  } finally { captureRunning = false; }
}

export async function pauseImports(provider?: 'chatgpt' | 'claude'): Promise<void> {
  if (provider === 'claude' && !CLAUDE_ENABLED) return;
  await setImportPause(true, !CLAUDE_ENABLED && !provider ? 'chatgpt' : provider);
}
export async function resetProviderFailure(provider: 'chatgpt' | 'claude'): Promise<void> {
  await resetImportFailure(provider);
  const stored = await browser.storage.local.get(STATUS_KEY);
  const statuses = Array.isArray(stored[STATUS_KEY]) ? (stored[STATUS_KEY] as SyncProviderStatus[]) : [];
  await browser.storage.local.set({ [STATUS_KEY]: statuses.filter((item) => item.provider !== provider) });
}
export async function resumeImports(provider?: 'chatgpt' | 'claude'): Promise<SyncProviderStatus[]> {
  if (provider === 'claude' && !CLAUDE_ENABLED) return readSyncStatus();
  await browser.storage.local.set({ [PAUSE_KEY]: false });
  await setImportPause(false, !CLAUDE_ENABLED && !provider ? 'chatgpt' : provider);
  return runSync({ maxItems: null, manual: true, provider });
}
export async function startResumeImports(provider?: 'chatgpt' | 'claude'): Promise<SyncProviderStatus[]> {
  if (provider === 'claude' && !CLAUDE_ENABLED) return readSyncStatus();
  await browser.storage.local.set({ [PAUSE_KEY]: false });
  await setImportPause(false, !CLAUDE_ENABLED && !provider ? 'chatgpt' : provider);
  return startSync({ maxItems: null, manual: true, provider });
}
export async function recoverSyncWork(): Promise<void> {
  await runScheduledCaptures();
  for (const session of await readImportSessions()) {
    if (session.provider === 'claude' && !CLAUDE_ENABLED) continue;
    // Older versions left human-action failures running. Stop automatic retries
    // of those checkpoints until the user refreshes/signs in and retries.
    if (session.state === 'running' && ['needs_signin', 'blocked', 'unreadable', 'unreadable_conversation'].includes(session.error ?? '')) {
      await setImportPause(true, session.provider);
      continue;
    }
    if (session.state === 'running' && (!session.leaseExpiresAt || Date.parse(session.leaseExpiresAt) <= Date.now()) && (!session.nextEligibleAt || Date.parse(session.nextEligibleAt) <= Date.now())) {
      await runSync({ maxItems: session.maxItems ?? null, manual: session.manual, provider: session.provider });
    }
  }
}
