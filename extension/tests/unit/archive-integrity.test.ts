import { deleteDB } from 'idb';
import { beforeEach, expect, it, vi } from 'vitest';
import { ingestDraft } from '../../core/archive/ingest.ts';
import { clearArchive, listRecentConversations, readConversation, listJobs, readDelivery, commitConversationWithJobs, claimJob, finishClaimedJob, saveDelivery, saveJob } from '../../core/archive/repository.ts';
import { openVaultDb } from '../../core/storage/db.ts';
import { buildConversation } from '../fixtures/factories.ts';

beforeEach(async () => {
  await deleteDB('vaultdraft');
  const store: Record<string, unknown> = {};
  vi.stubGlobal('browser', { storage: { local: {
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => { Object.assign(store, values); },
  } } });
});

it('stores a revision and all destination jobs together and deduplicates concurrent saves', async () => {
  const input = buildConversation();
  const result = await Promise.all([commitConversationWithJobs(input, ['markdown', 'notion']), commitConversationWithJobs(input, ['markdown', 'notion'])]);
  expect(result.filter((row) => row.changed)).toHaveLength(1);
  expect(await listJobs()).toHaveLength(2);
  expect((await readConversation(input.key))?.revision).toBe(1);
});
it('keeps JSON-like titles and legitimate HTML transcripts without startup deletion', async () => {
  const input = buildConversation({ title: '[Research] JSON schema', messages: [{ sourceId: 'm1', role: 'assistant', blocks: [{ type: 'text', text: '<!DOCTYPE html>\nA legitimate code example' }], createdAt: null, model: null, parentId: null, branchId: null }] });
  await commitConversationWithJobs(input, []);
  expect(await listRecentConversations()).toHaveLength(1);
  expect(await readConversation(input.key)).not.toBeNull();
});
it('preserves attachment-only messages and notices a metadata-only change', async () => {
  const draft = { provider: 'chatgpt' as const, accountScope: 'default', sourceId: 'asset', sourceUrl: 'https://chatgpt.com/c/asset', title: 'First title', text: '', completeness: 'partial' as const, warning: null, manual: true, messages: [{ sourceId: 'm1', role: 'assistant' as const, blocks: [{ type: 'image' as const, name: 'diagram.png', sourceRef: null, savedPath: null }], createdAt: null, model: null, parentId: null, branchId: null }] };
  expect(await ingestDraft(draft)).toBe('saved');
  expect(await ingestDraft({ ...draft, title: 'Renamed' })).toBe('saved');
  const saved = await readConversation('chatgpt:default:asset');
  expect(saved?.messages[0]?.blocks[0]?.type).toBe('image');
  expect(saved?.revision).toBe(2); expect(saved?.createdAt).toBeNull();
});
it('clears transcripts/pending captures but retains safe export references and quota ledger', async () => {
  const input = buildConversation(); await commitConversationWithJobs(input, ['markdown']);
  await saveDelivery({ id: input.key + '\nmarkdown', conversationKey: input.key, destinationId: 'markdown', revision: 1, externalId: 'chatgpt/note.md', contentHash: 'file-hash' });
  const db = await openVaultDb();
  await db.put('metadata', { key: 'capture-signal:' + input.key, value: 'private queued content' });
  await db.put('metadata', { key: 'history-ledger:chatgpt', value: JSON.stringify([input.key]) }); db.close();
  await clearArchive();
  expect(await readConversation(input.key)).toBeNull(); expect(await listJobs()).toHaveLength(0);
  expect((await readDelivery(input.key, 'markdown'))?.externalId).toBe('chatgpt/note.md');
  const after = await openVaultDb();
  expect(await after.get('metadata', 'capture-signal:' + input.key)).toBeUndefined();
  expect(await after.get('metadata', 'history-ledger:chatgpt')).toBeDefined(); after.close();
});
it('fences a stale delivery callback after its lease is stolen', async () => {
  const input = buildConversation(); await commitConversationWithJobs(input, ['markdown']);
  const job = (await listJobs())[0]!;
  const first = await claimJob(job.id, '2026-10-10T00:00:00.000Z', '2026-10-10T00:01:00.000Z');
  const second = await claimJob(job.id, '2026-10-10T00:02:00.000Z', '2026-10-10T00:03:00.000Z');
  expect(first?.leaseOwner).not.toBe(second?.leaseOwner);
  expect(await finishClaimedJob(first!, { state: 'completed' })).toBe(false);
  expect(await finishClaimedJob(second!, { state: 'completed' })).toBe(true);
});
it('does not claim a delayed retry before its persisted eligibility time', async () => {
  const input = buildConversation(); await commitConversationWithJobs(input, ['markdown']);
  const job = (await listJobs())[0]!;
  await saveJob({ ...job, state: 'retry_wait', nextEligibleAt: '2026-10-11T00:00:00.000Z' });
  expect(await claimJob(job.id, '2026-10-10T00:00:00.000Z', '2026-10-10T00:01:00.000Z')).toBeNull();
});
