import { beforeEach, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import { buildConversation } from '../fixtures/factories.ts';
import { openVaultDb } from '../../core/storage/db.ts';
import { readImportSessions } from '../../core/sync/persistence.ts';
import { checkClaudeConnection, readClaudeConnectionCheck } from '../../core/sync/claude-connection.ts';
import { resumeImports, runSync } from '../../core/sync/run.ts';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  entitlement: { canImportHistory: true, autoCaptureAllowed: true, historyLimit: 25 as number | null },
}));
vi.mock('../../core/sync/transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/sync/transport.ts')>();
  return { ...actual, fetchWithTabFallback: mocks.request };
});
vi.mock('../../core/licensing/policy.ts', () => ({ getEntitlementStatus: async () => mocks.entitlement }));
vi.mock('../../core/settings.ts', () => ({ readSettings: async () => ({ autoSync: true, saveCowork: false }) }));
vi.mock('../../core/queue/runner.ts', () => ({ runDeliveryQueue: async () => ({ blocked: 0 }) }));
vi.mock('../../core/archive/ingest.ts', () => ({ ingestDraft: async (draft: { provider: 'chatgpt' | 'claude'; accountScope: string; sourceId: string; title: string }) => {
  const db = await openVaultDb();
  await db.put('conversations', buildConversation({ provider: draft.provider, accountScope: draft.accountScope, sourceId: draft.sourceId, title: draft.title }));
  db.close();
  return 'saved';
} }));

let values: Record<string, unknown>;
beforeEach(async () => {
  vi.restoreAllMocks();
  mocks.request.mockReset();
  mocks.entitlement.canImportHistory = true;
  mocks.entitlement.historyLimit = 25;
  await deleteDB('vaultdraft');
  values = { connectedProviders: ['claude'], trialStartedAt: Date.now() - 60_000 };
  vi.stubGlobal('browser', {
    permissions: { contains: async () => true },
    tabs: { query: async () => [{ id: 1, status: 'complete', discarded: false }] },
    storage: { local: {
      get: async () => ({ ...values }),
      set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); },
      remove: async (key: string) => { delete values[key]; },
    } },
  });
});

const response = (status: number, body: unknown, retryAfter?: string) => ({ ok: status >= 200 && status < 300, status, body: typeof body === 'string' ? body : JSON.stringify(body), retryAfter });
const chatPayload = (id: string, text: string) => ({ uuid: id, name: `Private title ${id}`, chat_messages: [{ sender: 'assistant', text, created_at: '2026-10-05T00:00:00.000Z' }] });
function route(handler: (url: string) => ReturnType<typeof response>) {
  mocks.request.mockImplementation(async (url: string, _query: string, _headers: unknown, options: { onAttempt: (event: unknown) => void }) => {
    const result = handler(url);
    options.onAttempt({ source: 'extension', outcome: 'response', status: result.status, bodyKind: result.body.trim().startsWith('<') ? 'html' : 'json' });
    return result;
  });
}

it('saves readable workspace history, checkpoints the partial warning, and retries denied workspaces without duplicating saved chats', async () => {
  let retryB = false;
  route((url) => {
    if (url.endsWith('/api/organizations')) return response(200, [
      { uuid: 'private-workspace-a', capabilities: ['chat'] },
      { uuid: 'private-workspace-b', capabilities: ['chat'] },
    ]);
    if (url.includes('/private-workspace-a/chat_conversations?')) return response(200, [{ uuid: 'private-chat-a', name: 'Private title A', updated_at: '2026-10-05T00:00:00.000Z' }]);
    if (url.includes('/private-workspace-b/chat_conversations?')) return retryB ? response(200, [{ uuid: 'private-chat-b', name: 'Private title B', updated_at: '2026-10-05T00:00:00.000Z' }]) : response(403, { error: 'private denial' });
    if (url.includes('/private-workspace-a/chat_conversations/private-chat-a')) return response(200, chatPayload('private-chat-a', 'private transcript A'));
    if (url.includes('/private-workspace-b/chat_conversations/private-chat-b')) return response(200, chatPayload('private-chat-b', 'private transcript B'));
    return response(404, {});
  });
  const first = await runSync({ maxItems: null, manual: true, provider: 'claude' });
  expect(first[0]).toMatchObject({ state: 'ok', savedCount: 1, error: 'claude_accounts_skipped' });
  expect((await readImportSessions())[0]).toMatchObject({ state: 'completed', completedCount: 1, warning: 'claude_accounts_skipped' });
  const db = await openVaultDb();
  expect(await db.get('conversations', 'claude:private-workspace-a:private-chat-a')).toBeDefined();
  expect(await db.get('conversations', 'claude:private-workspace-b:private-chat-b')).toBeUndefined();
  db.close();

  retryB = true;
  await resumeImports('claude');
  expect((await readImportSessions())[0]).toMatchObject({ state: 'completed', completedCount: 1, error: null });
  const recovered = await openVaultDb();
  expect(await recovered.count('conversations')).toBe(2);
  expect(await recovered.get('conversations', 'claude:private-workspace-a:private-chat-a')).toBeDefined();
  expect(await recovered.get('conversations', 'claude:private-workspace-b:private-chat-b')).toBeDefined();
  recovered.close();
  expect(mocks.request.mock.calls.filter(([url]) => String(url).includes('/private-workspace-a/chat_conversations/private-chat-a'))).toHaveLength(1);
});

it('keeps a blocked pending conversation available for explicit retry', async () => {
  let readable = false;
  route((url) => {
    if (url.endsWith('/api/organizations')) return response(200, [{ uuid: 'workspace' }]);
    if (url.includes('/chat_conversations?')) return response(200, [{ uuid: 'pending-chat', name: 'Private title', updated_at: '2026-10-05T00:00:00.000Z' }]);
    if (url.includes('/chat_conversations/pending-chat')) return readable ? response(200, chatPayload('pending-chat', 'private transcript')) : response(403, { error: 'private denial' });
    return response(404, {});
  });
  const first = await runSync({ maxItems: null, manual: true, provider: 'claude' });
  expect(first[0]).toMatchObject({ state: 'error', error: 'blocked' });
  expect((await readImportSessions())[0]).toMatchObject({ state: 'paused', error: 'blocked', checkpoint: { pending: [{ id: 'pending-chat', accountScope: 'workspace' }] } });
  readable = true;
  await resumeImports('claude');
  expect((await readImportSessions())[0]).toMatchObject({ state: 'completed', completedCount: 1 });
  const db = await openVaultDb();
  expect(await db.get('conversations', 'claude:workspace:pending-chat')).toBeDefined();
  db.close();
});

it('checks and imports chat organizations while skipping an API-only organization', async () => {
  route((url) => {
    if (url.endsWith('/api/organizations')) return response(200, [
      { uuid: 'chat-workspace', capabilities: ['chat'] },
      { uuid: 'api-workspace', capabilities: ['api'] },
    ]);
    if (url.includes('/chat-workspace/chat_conversations?')) return response(200, [{ uuid: 'chat-id', name: 'Chat title', updated_at: '2026-10-05T00:00:00.000Z' }]);
    if (url.includes('/chat-workspace/chat_conversations/chat-id')) return response(200, chatPayload('chat-id', 'chat transcript'));
    return response(404, {});
  });
  expect(await checkClaudeConnection()).toMatchObject({ ok: true });
  const imported = (await runSync({ maxItems: null, manual: true, provider: 'claude' }))[0];
  expect(imported).toMatchObject({ state: 'ok', savedCount: 1, error: null });
  const session = (await readImportSessions())[0];
  expect(session).toMatchObject({ state: 'completed' });
  expect(session?.warning).toBeUndefined();
  const db = await openVaultDb();
  expect(await db.get('conversations', 'claude:chat-workspace:chat-id')).toBeDefined();
  db.close();
  expect(mocks.request.mock.calls.some(([url]) => String(url).includes('/api-workspace/chat_conversations'))).toBe(false);
  expect(mocks.request.mock.calls.some(([url]) => String(url).includes('/api-workspace/chat_conversations/'))).toBe(false);
});

it('fails an all-API-only organization selection as unreadable without requesting history', async () => {
  route((url) => url.endsWith('/api/organizations')
    ? response(200, [{ uuid: 'api-workspace', capabilities: ['api'] }])
    : response(404, {}));
  expect(await checkClaudeConnection()).toMatchObject({ ok: false, code: 'unreadable' });
  const imported = await runSync({ maxItems: null, manual: true, provider: 'claude' });
  expect(imported[0]).toMatchObject({ state: 'error', error: 'unreadable' });
  expect(mocks.request.mock.calls.some(([url]) => String(url).includes('/chat_conversations'))).toBe(false);
});

it('replaces an older successful check with the last real import failure without private data', async () => {
  let failImport = false;
  route((url) => url.endsWith('/api/organizations')
    ? response(200, [{ uuid: 'private-workspace' }])
    : url.includes('/chat_conversations?') ? failImport ? response(403, { title: 'private title', body: 'private response' }) : response(200, [{ uuid: 'private-chat', name: 'private title' }])
      : response(200, chatPayload('private-chat', 'private response')));
  expect((await checkClaudeConnection()).ok).toBe(true);
  expect((await readClaudeConnectionCheck())?.source).toBe('check');
  failImport = true;
  const imported = await runSync({ maxItems: null, manual: true, provider: 'claude' });
  expect(imported[0]).toMatchObject({ state: 'error', error: 'blocked' });
  const result = await readClaudeConnectionCheck();
  expect(result).toMatchObject({ source: 'import', code: 'blocked' });
  for (const privateValue of ['private-workspace', 'private title', 'private response']) {
    expect(JSON.stringify(values)).not.toContain(privateValue);
    expect(JSON.stringify(result)).not.toContain(privateValue);
  }
});
