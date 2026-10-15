import { beforeEach, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import { buildConversation } from '../fixtures/factories.ts';
import { openVaultDb } from '../../core/storage/db.ts';
import { admitHistory, claimImport, checkpointImport, readImportSessions, persistCapture, setImportPause } from '../../core/sync/persistence.ts';
import { runSync, startSync, resumeImports, resetProviderFailure, recoverSyncWork, readSyncStatus, syncOne, runScheduledCaptures } from '../../core/sync/run.ts';
import { ProviderRequestError } from '../../core/sync/transport.ts';

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), claudeList: vi.fn(), claudeGet: vi.fn(), claudeVisible: vi.fn(), settings: { autoSync: true }, entitlement: { canImportHistory: true, autoCaptureAllowed: true, historyLimit: 25 as number | null } }));
vi.mock('../../providers/chatgpt/api.ts', () => ({ accessTokenFromSession: () => null, chatGptSyncApi: { provider: 'chatgpt', list: mocks.list, get: mocks.get } }));
vi.mock('../../providers/claude/api.ts', () => ({ claudeSyncApi: { provider: 'claude', list: mocks.claudeList, get: mocks.claudeGet }, readVisibleClaudeChat: mocks.claudeVisible }));
vi.mock('../../core/licensing/policy.ts', () => ({ getEntitlementStatus: async () => mocks.entitlement }));
vi.mock('../../core/settings.ts', () => ({ readSettings: async () => mocks.settings }));
vi.mock('../../core/queue/runner.ts', () => ({ runDeliveryQueue: async () => ({ blocked: 0 }) }));
vi.mock('../../core/archive/ingest.ts', () => ({ ingestDraft: async (draft: { provider: 'chatgpt' | 'claude'; sourceId: string; title: string; accountScope: string }) => {
  const db = await openVaultDb();
  await db.put('conversations', buildConversation({ provider: draft.provider, accountScope: draft.accountScope, sourceId: draft.sourceId, title: draft.title })); db.close();
  return 'saved';
} }));
const item = { id: 'pending', title: 'Pending', accountScope: 'default', updatedAt: null, projectName: null, projectSlug: null };
let values: Record<string, unknown>;
beforeEach(async () => {
  vi.restoreAllMocks(); mocks.list.mockReset(); mocks.get.mockReset(); mocks.claudeList.mockReset(); mocks.claudeGet.mockReset(); mocks.claudeVisible.mockReset(); mocks.settings.autoSync = true; mocks.entitlement.canImportHistory = true; mocks.entitlement.historyLimit = 25;
  await deleteDB('vaultdraft');
  values = { connectedProviders: ['chatgpt'], trialStartedAt: Date.now() - 60_000 };
  vi.stubGlobal('browser', { storage: { local: {
    get: async () => ({ ...values }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); },
  } } });
});

it('resumes the saved pending page after sign-in without rediscovering or skipping it', async () => {
  mocks.list.mockResolvedValue({ items: [item], nextCursor: null });
  mocks.get.mockResolvedValueOnce('needs_signin').mockResolvedValue(buildConversation({ sourceId: item.id }));
  const first = await runSync({ maxItems: null, manual: true });
  expect(first[0]?.state).toBe('needs_signin');
  expect((await readImportSessions())[0]?.checkpoint?.pending).toHaveLength(1);
  await resumeImports('chatgpt');
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect((await readImportSessions())[0]).toMatchObject({ state: 'completed', completedCount: 1 });
});

it('recovers abandoned pending work and prevents simultaneous run invocations', async () => {
  const session = (await claimImport('chatgpt', { maxItems: 25, manual: true }))!;
  session.checkpoint = { cursor: null, pending: [item], exhausted: true };
  session.discoveredCount = 1;
  await checkpointImport(session, true);
  mocks.get.mockResolvedValue(buildConversation({ sourceId: item.id }));
  await Promise.all([recoverSyncWork(), runSync({ maxItems: 25, manual: true })]);
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.list).not.toHaveBeenCalled();
  expect((await readImportSessions())[0]?.state).toBe('completed');
});

it('keeps a rate-limited item until the persisted retry date and then recovers it', async () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.list.mockResolvedValue({ items: [item], nextCursor: null });
  mocks.get.mockRejectedValueOnce(new ProviderRequestError('rate_limited', now + 120_000)).mockResolvedValue(buildConversation({ sourceId: item.id }));
  await runSync({ maxItems: 25, manual: true });
  await resumeImports('chatgpt');
  await recoverSyncWork();
  expect(mocks.get).toHaveBeenCalledTimes(1);
  now += 121_000;
  await recoverSyncWork();
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect((await readImportSessions())[0]?.state).toBe('completed');
});

it('pauses a blocked Claude first save and immediately retries the same session after refresh', async () => {
  values.connectedProviders = ['claude'];
  mocks.claudeList.mockRejectedValueOnce(new ProviderRequestError('blocked', Date.now() + 300_000))
    .mockResolvedValue({ items: [item], nextCursor: null });
  mocks.claudeGet.mockResolvedValue(buildConversation({ provider: 'claude', accountScope: item.accountScope, sourceId: item.id }));
  await runSync({ maxItems: 25, manual: true, provider: 'claude' });
  const stopped = (await readImportSessions())[0]!;
  expect(stopped).toMatchObject({ state: 'paused', error: 'blocked', discoveredCount: 0, completedCount: 0, nextEligibleAt: null, leaseOwner: null });
  await recoverSyncWork();
  expect(mocks.claudeList).toHaveBeenCalledTimes(1);
  await resumeImports('claude');
  expect(mocks.claudeList).toHaveBeenCalledTimes(2);
  expect((await readImportSessions())[0]).toMatchObject({ id: stopped.id, maxItems: 25, state: 'completed', completedCount: 1 });
});

it.each(['paused', 'failed', 'running'] as const)('retries a legacy %s blocked checkpoint without rediscovery or duplicate saves', async (state) => {
  const session = (await claimImport('chatgpt', { maxItems: 25, manual: true }))!;
  session.state = state;
  session.error = 'blocked';
  session.nextEligibleAt = new Date(Date.now() + 300_000).toISOString();
  session.checkpoint = { cursor: 'next-page', pending: [item], exhausted: false };
  session.discoveredCount = 2;
  session.completedCount = 1;
  await checkpointImport(session, true);
  const db = await openVaultDb();
  await db.put('conversations', buildConversation({ accountScope: item.accountScope, sourceId: 'already-saved' }));
  db.close();
  mocks.get.mockResolvedValue(buildConversation({ accountScope: item.accountScope, sourceId: item.id }));
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  await resumeImports('chatgpt');
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(mocks.list.mock.calls[0]?.[0]).toBe('next-page');
  expect((await readImportSessions())[0]).toMatchObject({ state: 'completed', discoveredCount: 2, completedCount: 2, maxItems: 25 });
  const archive = await openVaultDb();
  expect(await archive.count('conversations')).toBe(2);
  archive.close();
});

it('preserves a future lease during explicit retry and resumes only after it expires', async () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const session = (await claimImport('chatgpt', { maxItems: 25, manual: true }))!;
  session.state = 'paused'; session.error = 'blocked';
  session.nextEligibleAt = new Date(now + 300_000).toISOString();
  session.checkpoint = { cursor: null, pending: [item], exhausted: true };
  session.discoveredCount = 1;
  await checkpointImport(session);
  mocks.get.mockResolvedValue(buildConversation({ accountScope: item.accountScope, sourceId: item.id }));
  await resumeImports('chatgpt');
  expect(mocks.get).not.toHaveBeenCalled();
  expect((await readImportSessions())[0]).toMatchObject({ leaseOwner: session.leaseOwner, leaseExpiresAt: session.leaseExpiresAt, nextEligibleAt: null });
  now += 61_000;
  await recoverSyncWork();
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(await checkpointImport(session)).toBe(false);
  expect((await readImportSessions())[0]?.state).toBe('completed');
});

it.each(['unreadable', 'blocked'] as const)('waits for explicit retry of %s provider responses', async (code) => {
  mocks.list.mockRejectedValueOnce(new ProviderRequestError(code)).mockResolvedValue({ items: [], nextCursor: null });
  await runSync({ maxItems: 25, manual: true });
  expect((await readImportSessions())[0]).toMatchObject({ state: 'paused', error: code });
  await recoverSyncWork();
  expect(mocks.list).toHaveBeenCalledTimes(1);
  await resumeImports('chatgpt');
  expect((await readImportSessions())[0]?.state).toBe('completed');
});

it('does not start automatic imports with autoSync off or inactive history entitlement', async () => {
  mocks.settings.autoSync = false;
  await runSync({ maxItems: 25 });
  expect(mocks.list).not.toHaveBeenCalled();
  mocks.entitlement.canImportHistory = false;
  await runSync({ maxItems: null, manual: true });
  expect(mocks.list).not.toHaveBeenCalled();
});

it('keeps automatic new chats available after all 25 historical slots are used', async () => {
  for (let index = 0; index < 25; index += 1) await admitHistory('chatgpt', { ...item, id: `old-${index}` }, 25);
  mocks.list.mockResolvedValue({ items: [item], nextCursor: null });
  mocks.get.mockResolvedValue(buildConversation({ sourceId: item.id, accountScope: 'default', createdAt: new Date().toISOString() }));
  await runSync({ maxItems: 25 });
  const db = await openVaultDb();
  expect(await db.get('conversations', 'chatgpt:default:pending')).toBeDefined();
  const ledger = await db.get('metadata', 'history-ledger:chatgpt');
  expect(JSON.parse(ledger!.value)).toHaveLength(25);
  db.close();
});

it.each(['chatgpt', 'claude'] as const)('saves %s capture signals and manual open chats after the history allowance is full', async (provider) => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  values.connectedProviders = [provider];
  for (let index = 0; index < 25; index += 1) await admitHistory(provider, { ...item, id: `history-${index}` }, 25);
  const getter = provider === 'claude' ? mocks.claudeGet : mocks.get;
  getter.mockImplementation(async ({ id }: { id: string }) => buildConversation({ provider, accountScope: 'default', sourceId: id, createdAt: new Date().toISOString() }));
  await persistCapture({ provider, accountScope: 'default', conversationId: 'new-auto' });
  now += 5100;
  await runScheduledCaptures();
  expect(await syncOne(provider, 'default', 'new-manual', { manual: true })).toBe('saved');
  const db = await openVaultDb();
  const [automatic, manual, ledger, metadata] = await Promise.all([
    db.get('conversations', `${provider}:default:new-auto`),
    db.get('conversations', `${provider}:default:new-manual`),
    db.get('metadata', `history-ledger:${provider}`), db.getAll('metadata'),
  ]);
  db.close();
  expect(automatic).toBeDefined();
  expect(manual).toBeDefined();
  expect(JSON.parse(ledger!.value)).toHaveLength(25);
  expect(metadata.filter((record) => record.key.startsWith('capture-signal:'))).toHaveLength(0);
});

it('returns durable running status to the popup before provider work finishes', async () => {
  let complete!: (value: ReturnType<typeof buildConversation>) => void;
  mocks.list.mockResolvedValue({ items: [item], nextCursor: null });
  mocks.get.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const status = await startSync({ maxItems: 25, manual: true });
  expect(status[0]?.state).toBe('running');
  expect((await readImportSessions())[0]?.state).toBe('running');
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  complete(buildConversation({ sourceId: item.id, accountScope: 'default' }));
  await vi.waitFor(async () => expect((await readSyncStatus())[0]?.state).toBe('ok'));
});

it('resolves a visible Claude signal to its real workspace and respects the history cap for old automatic chats', async () => {
  values.connectedProviders = ['claude'];
  for (let index = 0; index < 25; index += 1) await admitHistory('claude', { ...item, id: `history-${index}` }, 25);
  mocks.claudeVisible.mockResolvedValue(buildConversation({ provider: 'claude', sourceId: 'visible-new', accountScope: 'actual-workspace', createdAt: new Date().toISOString() }));
  expect(await syncOne('claude', '__visible__', 'visible-new')).toBe('saved');
  mocks.claudeVisible.mockResolvedValue(buildConversation({ provider: 'claude', sourceId: 'visible-old', accountScope: 'actual-workspace', createdAt: new Date(Date.now() - 86400000).toISOString() }));
  expect(await syncOne('claude', '__visible__', 'visible-old')).toBe('history_limit');
  const db = await openVaultDb();
  const saved = await db.get('conversations', 'claude:actual-workspace:visible-new');
  const skipped = await db.get('conversations', 'claude:actual-workspace:visible-old');
  db.close();
  expect(saved).toBeDefined();
  expect(skipped).toBeUndefined();
  expect(values['capture-health:claude']).toMatchObject({ outcome: 'history_limit' });
});

it('discards disconnected signals even before they are due and when autoSync is off', async () => {
  await persistCapture({ provider: 'chatgpt', accountScope: 'default', conversationId: 'pending' });
  values.connectedProviders = []; mocks.settings.autoSync = false;
  await runScheduledCaptures();
  const db = await openVaultDb();
  expect((await db.getAll('metadata')).filter((record) => record.key.startsWith('capture-signal:'))).toHaveLength(0);
  db.close(); expect(mocks.get).not.toHaveBeenCalled();
});

it('rechecks disconnect before automatic fetch and again after the request', async () => {
  values.connectedProviders = [];
  expect(await syncOne('chatgpt', 'default', 'pending')).toBe('unreadable');
  expect(mocks.get).not.toHaveBeenCalled();
  values.connectedProviders = ['chatgpt'];
  mocks.get.mockImplementation(async () => { values.connectedProviders = []; return buildConversation({ sourceId: 'pending', accountScope: 'default' }); });
  expect(await syncOne('chatgpt', 'default', 'pending')).toBe('unreadable');
  const db = await openVaultDb(); expect(await db.count('conversations')).toBe(0); db.close();
});

it('retains explicit active-tab manual saving after disconnect or entitlement inactivity', async () => {
  values.connectedProviders = []; mocks.settings.autoSync = false; mocks.entitlement.autoCaptureAllowed = false;
  mocks.get.mockResolvedValue(buildConversation({ sourceId: 'pending', accountScope: 'default' }));
  expect(await syncOne('chatgpt', 'default', 'pending', { manual: true })).toBe('saved');
  mocks.entitlement.autoCaptureAllowed = true;
});

it.each(['clear', 'pause', 'reset'])('does not save a fetched import after %s invalidates its checkpoint', async (operation) => {
  mocks.list.mockResolvedValue({ items: [item], nextCursor: null });
  mocks.get.mockImplementation(async () => {
    if (operation === 'clear') { const db = await openVaultDb(); await db.clear('imports'); db.close(); }
    else if (operation === 'reset') await resetProviderFailure('chatgpt');
    else await setImportPause(true, 'chatgpt');
    return buildConversation({ sourceId: item.id, accountScope: 'default' });
  });
  await runSync({ maxItems: 25, manual: true });
  const db = await openVaultDb();
  expect(await db.count('conversations')).toBe(0);
  expect(await db.get('metadata', 'history-ledger:chatgpt')).toBeUndefined();
  if (operation === 'clear') expect(await db.count('imports')).toBe(0);
  db.close();
});

it.each(['running', 'paused', 'failed'] as const)('resets only temporary provider failure while preserving a %s import and saved history', async (state) => {
  const session = (await claimImport('claude', { maxItems: 25, manual: true }))!;
  session.state = state;
  session.error = 'blocked';
  session.nextEligibleAt = new Date(Date.now() + 300_000).toISOString();
  session.discoveredCount = 2; session.completedCount = 1;
  session.checkpoint = { cursor: 'next-page', pending: [item], exhausted: false };
  await checkpointImport(session);
  const checkpoint = structuredClone(session.checkpoint);
  await admitHistory('claude', { ...item, id: 'saved' }, 25);
  const db = await openVaultDb();
  const saved = buildConversation({ provider: 'claude', accountScope: item.accountScope, sourceId: 'saved' });
  await db.put('conversations', saved);
  const metadata = await db.getAll('metadata'); db.close();
  const other = { provider: 'chatgpt', state: 'error', lastRunAt: null, discoveredCount: 0, savedCount: 0, error: 'unavailable' };
  values.syncStatus = [other, { ...other, provider: 'claude', error: 'blocked' }];
  values.destinationSettings = { folder: 'archive' };
  const localBefore = structuredClone(values);
  await resetProviderFailure('claude');
  expect((await readImportSessions())[0]).toMatchObject({
    id: session.id, state: 'paused', error: 'paused', nextEligibleAt: null,
    checkpoint, maxItems: 25, discoveredCount: 2, completedCount: 1,
    leaseOwner: session.leaseOwner, leaseExpiresAt: session.leaseExpiresAt,
  });
  expect(values).toEqual({ ...localBefore, syncStatus: [other] });
  const archive = await openVaultDb();
  expect(await archive.getAll('conversations')).toEqual([saved]);
  expect(await archive.getAll('metadata')).toEqual(metadata); archive.close();
  await recoverSyncWork();
  expect(mocks.claudeList).not.toHaveBeenCalled(); expect(mocks.claudeGet).not.toHaveBeenCalled();
  expect((await readSyncStatus()).find((status) => status.provider === 'claude')).toMatchObject({ state: 'ok', error: 'paused', discoveredCount: 2, savedCount: 1 });
});

it('does not restore stale errors when an in-flight worker checkpoints after reset', async () => {
  const session = (await claimImport('chatgpt', { maxItems: 25, manual: true }))!;
  session.error = 'blocked'; session.nextEligibleAt = new Date(Date.now() + 300_000).toISOString();
  await checkpointImport(session);
  await resetProviderFailure('chatgpt');
  expect(await checkpointImport(session, true)).toBe(true);
  expect((await readImportSessions())[0]).toMatchObject({ state: 'paused', error: 'paused', nextEligibleAt: null });
});

it('preserves a provider rate-limit date during reset and subsequent retry', async () => {
  const retryAt = Date.now() + 120_000;
  mocks.list.mockResolvedValue({ items: [item], nextCursor: null });
  mocks.get.mockRejectedValue(new ProviderRequestError('rate_limited', retryAt));
  await runSync({ maxItems: 25, manual: true });
  await resetProviderFailure('chatgpt');
  expect((await readImportSessions())[0]).toMatchObject({ state: 'paused', error: 'rate_limited', nextEligibleAt: new Date(retryAt).toISOString(), checkpoint: { pending: [item] } });
  await resumeImports('chatgpt'); await recoverSyncWork();
  expect(mocks.get).toHaveBeenCalledOnce();
});

it('skips one unreadable chat and continues the import', async () => {
  const second = { ...item, id: 'next' };
  mocks.list.mockResolvedValue({ items: [item, second], nextCursor: null });
  mocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce(buildConversation({ sourceId: second.id, accountScope: 'default' }));
  const result = await runSync({ maxItems: 5, manual: true });
  expect(result[0]).toMatchObject({ state: 'ok', savedCount: 1, error: 'skipped_unreadable' });
  expect((await readImportSessions())[0]).toMatchObject({ state: 'completed', completedCount: 1, skippedCount: 1, skippedIds: [item.id] });
});

it('saves a chat created during the trial without using the history cap', async () => {
  mocks.entitlement.historyLimit = 1;
  const historical = { ...item, id: 'old' };
  const live = { ...item, id: 'new' };
  const createdAt = new Date().toISOString();
  mocks.list.mockResolvedValueOnce({ items: [historical], nextCursor: null }).mockResolvedValueOnce({ items: [live], nextCursor: null });
  mocks.get.mockResolvedValueOnce(buildConversation({ sourceId: 'old', accountScope: 'default' })).mockResolvedValueOnce(buildConversation({ sourceId: 'new', accountScope: 'default', createdAt, updatedAt: createdAt }));
  await runSync({ maxItems: 5, manual: true });
  const result = await runSync({ maxItems: 5, manual: false });
  expect(result[0]).toMatchObject({ state: 'ok', savedCount: 1, error: null });
});

it('stops history backfill at the trial cap', async () => {
  mocks.entitlement.historyLimit = 1;
  const first = { ...item, id: 'old' };
  const second = { ...item, id: 'older' };
  mocks.list.mockResolvedValueOnce({ items: [first], nextCursor: null }).mockResolvedValueOnce({ items: [second], nextCursor: null });
  mocks.get.mockResolvedValueOnce(buildConversation({ sourceId: 'old', accountScope: 'default' })).mockResolvedValueOnce(buildConversation({ sourceId: 'older', accountScope: 'default' }));
  await runSync({ maxItems: 5, manual: true });
  const result = await runSync({ maxItems: 5, manual: true });
  expect(result[0]).toMatchObject({ state: 'ok', savedCount: 0, error: 'trial_history_limit' });
});

it('honors a new rate limit returned by a request that was in flight during reset', async () => {
  const retryAt = Date.now() + 120_000;
  mocks.list.mockResolvedValue({ items: [item], nextCursor: null });
  mocks.get.mockImplementation(async () => {
    await resetProviderFailure('chatgpt');
    throw new ProviderRequestError('rate_limited', retryAt);
  });
  await runSync({ maxItems: 25, manual: true });
  expect((await readImportSessions())[0]).toMatchObject({ state: 'paused', error: 'rate_limited', nextEligibleAt: new Date(retryAt).toISOString() });
  const db = await openVaultDb(); expect(await db.count('conversations')).toBe(0); db.close();
});
