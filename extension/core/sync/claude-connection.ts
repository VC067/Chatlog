import { z } from 'zod';
import { claudeSyncApi } from '../../providers/claude/api.ts';
import { fetchWithTabFallback, ProviderRequestError, type HostFetch, type ProviderAttemptTrace } from './transport.ts';
import { CLAUDE_ENABLED } from '../provider-features.ts';

const KEY = 'claudeConnectionCheck';
let generation = 0;
const stageSchema = z.enum(['site_access', 'tab', 'organizations', 'history', 'conversation']);
const codeSchema = z.enum(['ok', 'site_access', 'no_tab', 'blocked', 'needs_signin', 'rate_limited', 'unavailable', 'unreadable']);
const checkSchema = z.object({
  checkedAt: z.number().finite().min(0).max(8_640_000_000_000_000),
  stage: stageSchema, code: codeSchema, permission: z.boolean(),
  readyTabs: z.number().int().min(0).max(1000),
  source: z.enum(['check', 'import']).optional(),
  partial: z.boolean().optional(),
  attempts: z.array(z.object({
    stage: stageSchema,
    source: z.enum(['extension', 'tab']),
    outcome: z.enum(['response', 'failed', 'origin_changed', 'invalid']),
    status: z.number().int().min(100).max(599).nullable(),
    bodyKind: z.enum(['json', 'html', 'other']).nullable(),
    workspace: z.number().int().min(1).max(10000).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict()).max(60),
}).strict();
type CheckRecord = z.infer<typeof checkSchema>;
type Stage = z.infer<typeof stageSchema>;
const stageLabel: Record<Stage, string> = {
  site_access: 'site access', tab: 'open tab', organizations: 'account access', history: 'history list', conversation: 'conversation read',
};

function report(record: CheckRecord): string {
  return `${record.source === 'import' ? 'History import. ' : ''}Site access: ${record.permission ? 'allowed' : 'missing'}. Ready Claude tabs: ${record.readyTabs}. ` +
    record.attempts.map((attempt) => {
      const context = [attempt.workspace ? `workspace ${attempt.workspace}` : '', attempt.limit ? `limit ${attempt.limit}` : '', attempt.offset !== undefined ? `offset ${attempt.offset}` : ''].filter(Boolean);
      return `${stageLabel[attempt.stage]}${context.length ? ' (' + context.join(', ') + ')' : ''} / ${attempt.source}: ${attempt.status ?? attempt.outcome}${attempt.bodyKind ? ' ' + attempt.bodyKind : ''}`;
    }).join('; ');
}

function result(record: CheckRecord) {
  return { ok: record.code === 'ok', code: record.code, message: message(record), report: report(record), checkedAt: new Date(record.checkedAt).toISOString(), source: record.source ?? 'check' };
}

function message(record: CheckRecord): string {
  const at = stageLabel[record.stage];
  switch (record.code) {
    case 'ok': return record.partial
      ? 'Accessible Claude workspaces work. Some workspaces were unavailable; their history was not imported.'
      : record.source === 'import'
        ? 'Claude history requests succeeded. Saved counts are shown above; destination delivery is tracked separately.'
        : record.stage === 'history'
          ? 'Claude account and history access work. No eligible conversations were found in the checked workspaces.'
          : 'Claude account, history and conversation access work. Use Retry Claude in Capture & history to continue the saved import.';
    case 'site_access': return 'Claude site access is missing. Connect Claude before checking again.';
    case 'no_tab': return 'No ready Claude tab was found. Open Claude in this Chrome profile and let it finish loading.';
    case 'needs_signin': return `Claude requires sign-in for ${at}. Sign in to Claude in this browser profile.`;
    case 'blocked': return `Claude rejected ${at}. The report below identifies which request was denied.`;
    case 'rate_limited': return `Claude asked us to wait at ${at}. Leave the existing import waiting for its automatic retry.`;
    case 'unavailable': return `Could not complete ${at}. Claude or the network is temporarily unavailable.`;
    case 'unreadable': return `Claude returned an unexpected format at ${at}. Share this connection report so the adapter can be checked.`;
  }
}

async function recorder(source: 'check' | 'import', startGeneration = generation) {
  const record: CheckRecord = { checkedAt: Date.now(), stage: 'site_access', code: 'site_access', permission: false, readyTabs: 0, source, partial: false, attempts: [] };
  const workspaces = new Map<string, number>();
  try {
    record.permission = await browser.permissions.contains({ origins: ['https://claude.ai/*'] });
    const tabs = await browser.tabs.query({ url: 'https://claude.ai/*' });
    record.readyTabs = Math.min(1000, tabs.filter((tab) => tab.id != null && !tab.discarded && tab.status !== 'loading').length);
  } catch { /* Request outcome still identifies failures when browser metadata is unavailable. */ }
  const context = (url: string): Pick<CheckRecord['attempts'][number], 'stage' | 'workspace' | 'limit' | 'offset'> => {
    const target = new URL(url);
    const match = target.pathname.match(/^\/api\/organizations\/([^/]+)\/chat_conversations(?:\/([^/]+))?\/?$/);
    if (!match) return { stage: 'organizations' };
    if (!workspaces.has(match[1]!)) workspaces.set(match[1]!, Math.min(10000, workspaces.size + 1));
    const data: ReturnType<typeof context> = { stage: match[2] ? 'conversation' : 'history', workspace: workspaces.get(match[1]!) };
    for (const key of ['limit', 'offset'] as const) {
      const value = target.searchParams.get(key);
      if (value !== null && /^\d+$/.test(value)) {
        const number = Number(value);
        if (Number.isSafeInteger(number) && number >= (key === 'limit' ? 1 : 0) && (key !== 'limit' || number <= 500)) data[key] = number;
      }
    }
    return data;
  };
  const onAttempt = (url: string, attempt: ProviderAttemptTrace) => {
    const at = context(url);
    record.stage = at.stage;
    record.attempts.push({ ...attempt, ...at });
    if (record.attempts.length > 60) record.attempts.shift();
  };
  const done = async (code: CheckRecord['code'], partial = false) => {
    record.code = code;
    record.partial = partial;
    record.checkedAt = Date.now();
    const safe = checkSchema.parse(record);
    if (startGeneration === generation) {
      try { await browser.storage.local.set({ [KEY]: safe }); } catch { /* A report still works if local storage is unavailable. */ }
    }
    return result(safe);
  };
  return { record, onAttempt, done };
}

export async function createClaudeImportReport() {
  const trace = await recorder('import');
  return {
    onAttempt: trace.onAttempt,
    finish: async (error: string | null | undefined, partial = false) => {
      // A local pause/lease interruption is not a provider access result.
      if (!trace.record.attempts.length || ['paused', 'provider_disconnected', 'entitlement_inactive'].includes(error ?? '')) return;
      const code = codeSchema.safeParse(error);
      await trace.done(code.success ? code.data : error === 'skipped_unreadable' ? 'unreadable' : !error || ['trial_history_limit', 'claude_accounts_skipped'].includes(error) ? 'ok' : 'unavailable', partial);
    },
  };
}

async function probe(startGeneration: number) {
  const trace = await recorder('check', startGeneration);
  if (!trace.record.permission) return trace.done('site_access');
  if (!trace.record.readyTabs) { trace.record.stage = 'tab'; return trace.done('no_tab'); }
  const host: HostFetch = async (url) => {
    const response = await fetchWithTabFallback(url, 'https://claude.ai/*', {}, { onAttempt: (attempt) => trace.onAttempt(url, attempt) });
    if (response === 'no_tab') throw new Error('no_tab');
    return response;
  };
  let partial = false;
  try {
    const page = await claudeSyncApi.list(null, 25, host);
    if (page === 'needs_signin') return trace.done('needs_signin');
    partial = page.warning === 'claude_accounts_skipped';
    const item = page.items[0];
    if (item) {
      const conversation = await claudeSyncApi.get(item, host);
      if (conversation === 'needs_signin') return trace.done('needs_signin', partial);
      if (!conversation) return trace.done('unreadable', partial);
    }
    return trace.done('ok', partial);
  } catch (error) {
    return trace.done(error instanceof ProviderRequestError ? error.code : error instanceof Error && error.message === 'no_tab' ? 'no_tab' : 'unavailable', partial);
  }
}

let checking: ReturnType<typeof probe> | null = null;
export function checkClaudeConnection() {
  if (!CLAUDE_ENABLED) return Promise.resolve({
    ok: false, code: 'unavailable' as const,
    message: 'Claude is temporarily disabled in this testing build.',
    report: 'Claude access checks are disabled.', checkedAt: new Date().toISOString(), source: 'check' as const,
  });
  if (!checking) {
    const pending = probe(generation).finally(() => { if (checking === pending) checking = null; });
    checking = pending;
  }
  return checking;
}

export async function clearClaudeConnectionCheck(): Promise<void> {
  generation += 1;
  checking = null;
  await browser.storage.local.remove(KEY);
}

export async function readClaudeConnectionCheck() {
  const stored = await browser.storage.local.get(KEY);
  const parsed = checkSchema.safeParse(stored[KEY]);
  return parsed.success ? result(parsed.data) : null;
}

export async function readClaudeConnectionReport(): Promise<string | null> {
  return (await readClaudeConnectionCheck())?.report ?? null;
}
