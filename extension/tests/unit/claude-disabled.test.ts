import { beforeEach, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import { buildConversation } from '../fixtures/factories.ts';
import { openVaultDb } from '../../core/storage/db.ts';
import { admitHistory, claimImport, checkpointImport, persistCapture } from '../../core/sync/persistence.ts';

const mocks = vi.hoisted(() => ({ chatgptList: vi.fn(), chatgptGet: vi.fn(), claudeList: vi.fn(), claudeGet: vi.fn(), transport: vi.fn(), settings: { autoSync: true } }));
vi.mock('../../core/provider-features.ts', () => ({ CLAUDE_ENABLED: false }));
vi.mock('../../providers/chatgpt/api.ts', () => ({ accessTokenFromSession: () => null, chatGptSyncApi: { provider: 'chatgpt', list: mocks.chatgptList, get: mocks.chatgptGet } }));
vi.mock('../../providers/claude/api.ts', () => ({ claudeSyncApi: { provider: 'claude', list: mocks.claudeList, get: mocks.claudeGet } }));
vi.mock('../../core/sync/transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/sync/transport.ts')>();
  return { ...actual, fetchWithTabFallback: mocks.transport };
});
vi.mock('../../core/licensing/policy.ts', () => ({ getEntitlementStatus: async () => ({ canImportHistory: true, autoCaptureAllowed: true, historyLimit: 25 }) }));
vi.mock('../../core/settings.ts', () => ({ readSettings: async () => mocks.settings }));
vi.mock('../../core/queue/runner.ts', () => ({ runDeliveryQueue: async () => ({ blocked: 0 }) }));
vi.mock('../../core/archive/ingest.ts', async () => {
  const { openVaultDb } = await import('../../core/storage/db.ts');
  const { buildConversation } = await import('../fixtures/factories.ts');
  return { ingestDraft: async (draft: { provider: 'chatgpt' | 'claude'; sourceId: string; title: string; accountScope: string }) => {
    const db = await openVaultDb();
    await db.put('conversations', buildConversation({ provider: draft.provider, accountScope: draft.accountScope, sourceId: draft.sourceId, title: draft.title }));
    db.close();
    return 'saved';
  } };
});

let values: Record<string, unknown>;
let registered: Array<{ id: string; matches: string[] }>;
let listener: (message: unknown, sender: { id: string; url?: string; tab?: { url?: string } }, response: (value: unknown) => void) => boolean | void;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  mocks.chatgptList.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  mocks.chatgptGet.mockReset().mockResolvedValue(buildConversation({ sourceId: 'chatgpt-manual', accountScope: 'acct-1' }));
  mocks.claudeList.mockReset(); mocks.claudeGet.mockReset();
  mocks.transport.mockReset().mockImplementation(async (url: string) => { if (url.includes('claude.ai')) throw new Error('Claude transport was attempted'); return { ok: true, status: 200, body: '{}' }; });
  mocks.settings.autoSync = true;
  await deleteDB('vaultdraft');
  registered = [];
  values = { connectedProviders: ['chatgpt', 'claude'], syncStatus: [{ provider: 'claude', state: 'error', lastRunAt: null, discoveredCount: 3, savedCount: 1, error: 'blocked' }], pendingChats: [{ provider: 'claude', id: 'pending-chat', accountScope: 'workspace', title: 'Pending', updatedAt: null, projectName: null, projectSlug: null }], destinationSettings: { notion: 'destination-reference' }, trialStartedAt: 123456 };
  fetchMock = vi.fn(async (input: RequestInfo | URL) => { if (String(input).includes('claude.ai')) throw new Error('Claude fetch was attempted'); throw new Error('Unexpected fetch'); });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('browser', {
    runtime: { id: 'test-extension', getURL: () => 'chrome-extension://test-extension/', onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() }, onMessage: { addListener: (value: typeof listener) => { listener = value; } } },
    scripting: { unregisterContentScripts: vi.fn(async () => undefined), registerContentScripts: vi.fn(async (scripts: Array<{ id: string; matches: string[] }>) => { registered = scripts; }) },
    storage: { local: { get: async (keys?: string | string[]) => {
      if (!keys) return { ...values };
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => key in values).map((key) => [key, values[key]]));
    }, set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); }, remove: async (key: string) => { delete values[key]; } }, session: { set: vi.fn(async () => undefined) } },
    tabs: { query: vi.fn(async () => []) },
    permissions: { contains: vi.fn(async () => true) },
  });
});

it('gates Claude provider work while preserving archived data, checkpoints, and ChatGPT behavior', async () => {
  const { runSync, startSync, resumeImports, startResumeImports, recoverSyncWork, syncOne, getProviderHostFetch, savePending, readInbox, discoverPending } = await import('../../core/sync/run.ts');
  const { readImportSessions } = await import('../../core/sync/persistence.ts');
  const { registerCapture, connectProvider } = await import('../../providers/shared/register.ts');

  const db = await openVaultDb();
  const archived = buildConversation({ provider: 'claude', accountScope: 'workspace', sourceId: 'archived' });
  await db.put('conversations', archived);
  await admitHistory('claude', { id: archived.sourceId, title: archived.title, accountScope: archived.accountScope, updatedAt: archived.updatedAt, projectName: null, projectSlug: null }, 25);
  const session = (await claimImport('claude', { maxItems: 25, manual: true }))!;
  session.state = 'paused'; session.error = 'blocked'; session.checkpoint = { cursor: 'next', pending: [{ id: 'pending-chat', title: 'Pending', accountScope: 'workspace', updatedAt: null, projectName: null, projectSlug: null }], exhausted: false }; session.discoveredCount = 2; session.completedCount = 1;
  await checkpointImport(session, true);
  await persistCapture({ provider: 'claude', accountScope: 'workspace', conversationId: 'capture-pending' });
  await db.put('destinations', { id: 'notion-ref', kind: 'notion', label: 'Saved destination', enabled: true });
  await db.put('deliveries', { id: 'notion-ref:claude:workspace:archived', conversationKey: archived.key, destinationId: 'notion-ref', revision: 1, externalId: 'page-ref', contentHash: archived.contentHash });
  db.close();

  await expect(connectProvider('claude')).rejects.toThrow('Claude is temporarily disabled in this testing build.');
  registerCapture();
  await vi.waitFor(() => expect(registered.length).toBeGreaterThan(0));
  expect(registered.flatMap((script) => script.matches)).toEqual(['https://chatgpt.com/*', 'https://chatgpt.com/*']);

  const before = await openVaultDb();
  const beforeState = { conversations: await before.getAll('conversations'), metadata: await before.getAll('metadata'), imports: await before.getAll('imports'), destinations: await before.getAll('destinations'), deliveries: await before.getAll('deliveries') };
  before.close();
  expect((await runSync({ maxItems: null, manual: true, provider: 'claude' })).map((row) => row.provider)).toEqual([]);
  await startSync({ maxItems: null, manual: true, provider: 'claude' });
  await resumeImports('claude');
  await startResumeImports('claude');
  await recoverSyncWork();
  expect(await syncOne('claude', 'workspace', 'capture-pending', { manual: true })).toBe('unreadable');
  const hostFetch = getProviderHostFetch('claude');
  await expect(hostFetch('https://claude.ai/api/organizations')).rejects.toMatchObject({ code: 'blocked' });
  expect(await savePending({ provider: 'claude', id: 'pending-chat', accountScope: 'workspace', title: 'Pending', updatedAt: null, projectName: null, projectSlug: null })).toMatchObject({ ok: false, message: 'Claude is temporarily disabled in this testing build.' });
  expect((await readInbox()).chats).toEqual([]);
  await discoverPending(5);
  expect(mocks.claudeList).not.toHaveBeenCalled(); expect(mocks.claudeGet).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  const afterDisabled = await openVaultDb();
  expect({ conversations: await afterDisabled.getAll('conversations'), metadata: await afterDisabled.getAll('metadata'), imports: await afterDisabled.getAll('imports'), destinations: await afterDisabled.getAll('destinations'), deliveries: await afterDisabled.getAll('deliveries') }).toEqual(beforeState);
  afterDisabled.close();

  const response = vi.fn();
  listener({ source: 'vaultdraft-main', type: 'CAPTURE_SIGNAL', provider: 'claude', pageOrigin: 'https://claude.ai', url: 'https://claude.ai/api/organizations/workspace/chat_conversations/new-chat', accountScope: 'workspace', conversationId: 'new-chat' }, { id: 'test-extension', url: 'https://claude.ai/chat/new-chat', tab: { url: 'https://claude.ai/chat/new-chat' } }, response);
  await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ ok: false, reason: 'capture_paused' }));
  expect(registered.flatMap((script) => script.matches)).not.toContain('https://claude.ai/*');

  expect((await runSync({ maxItems: null, manual: true })).map((row) => row.provider)).toEqual(['chatgpt']);
  expect(mocks.chatgptList).toHaveBeenCalled();
  expect(await syncOne('chatgpt', 'acct-1', 'chatgpt-manual', { manual: true })).toBe('saved');
  expect(mocks.chatgptGet).toHaveBeenCalled();
  const imports = await readImportSessions();
  expect(imports.filter((row) => row.provider === 'claude')).toEqual(beforeState.imports);
  expect(imports.find((row) => row.id === 'history:chatgpt')).toMatchObject({ state: 'completed' });

  const after = await openVaultDb();
  expect(await after.get('conversations', archived.key)).toEqual(archived);
  expect(await after.get('conversations', 'chatgpt:acct-1:chatgpt-manual')).toEqual(buildConversation({ sourceId: 'chatgpt-manual', accountScope: 'acct-1' }));
  expect(await after.get('metadata', 'history-ledger:claude')).toEqual(beforeState.metadata.find((item) => item.key === 'history-ledger:claude'));
  expect(await after.get('metadata', 'capture-signal:claude:workspace:capture-pending')).toEqual(beforeState.metadata.find((item) => item.key === 'capture-signal:claude:workspace:capture-pending'));
  expect((await after.getAll('imports')).filter((row) => row.provider === 'claude')).toEqual(beforeState.imports);
  expect(await after.getAll('destinations')).toEqual(beforeState.destinations);
  expect(await after.getAll('deliveries')).toEqual(beforeState.deliveries);
  after.close();
  expect(values.trialStartedAt).toBe(123456);
  expect(values.destinationSettings).toEqual({ notion: 'destination-reference' });
});
