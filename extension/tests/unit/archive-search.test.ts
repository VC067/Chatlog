import { beforeEach, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { openVaultDb } from '../../core/storage/db.ts';
import { buildConversation } from '../fixtures/factories.ts';
import { listArchiveRows, searchArchive } from '../../core/search/index.ts';
import { deliveryJobSchema } from '../../core/contracts/jobs.ts';
beforeEach(async () => { await deleteDB('vaultdraft'); });
it('finds code at the end of a long conversation with no successful Markdown delivery', async () => {
  const conversation = buildConversation();
  conversation.messages[0]!.blocks = [{ type: 'text', text: 'ordinary '.repeat(30_000) }, { type: 'code', language: 'ts', code: 'const deepUniqueSymbol = 42;' }];
  const database = await openVaultDb();
  await database.put('conversations', conversation); database.close();
  const rows = await searchArchive({ query: 'deepUniqueSymbol' });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.preview).toContain('deepUniqueSymbol');
  expect(rows[0]!.destinations?.markdown).toBe('not_configured');
  expect(await listArchiveRows()).toHaveLength(1);
});
it('reports kept edits, superseded jobs and missing destination pointers without claiming saved', async () => {
  const database = await openVaultDb();
  const conversation = buildConversation({ revision: 2 });
  await database.put('conversations', conversation);
  const job = deliveryJobSchema.parse({
    id: 'markdown-status', conversationKey: conversation.key, destinationId: 'markdown', revision: 2,
    operation: 'upsert', state: 'completed', attempts: 1, nextEligibleAt: null, leaseOwner: null,
    leaseExpiresAt: null, checkpoint: null, errorCode: 'kept_user_edits',
  });
  await database.put('jobs', job);
  await database.put('deliveries', { id: `${conversation.key}\nmarkdown`, conversationKey: conversation.key, destinationId: 'markdown', externalId: 'chatgpt/note.md', revision: 1, contentHash: 'older-note' });
  expect((await listArchiveRows())[0]!.destinations?.markdown).toBe('kept_edits');
  await database.put('jobs', { ...job, errorCode: 'superseded' });
  expect((await listArchiveRows())[0]!.destinations?.markdown).toBe('superseded');
  await database.put('jobs', { ...job, errorCode: null });
  expect((await listArchiveRows())[0]!.destinations?.markdown).toBe('unavailable');
  await database.delete('deliveries', `${conversation.key}\nmarkdown`);
  expect((await listArchiveRows())[0]!.destinations?.markdown).toBe('unavailable');
  await database.put('deliveries', { id: `${conversation.key}\nmarkdown`, conversationKey: conversation.key, destinationId: 'markdown', externalId: 'chatgpt/note.md', revision: 2, contentHash: 'latest-note' });
  expect((await listArchiveRows())[0]!.destinations?.markdown).toBe('saved');
  database.close();
});
it('includes Notion-only archive records and refreshes after changes and deletion', async () => {
  const database = await openVaultDb();
  const conversation = buildConversation({ provider: 'claude', capturedAt: '2026-10-06T00:00:00.000Z' });
  await database.put('conversations', conversation);
  await database.put('conversations', buildConversation());
  await database.put('deliveries', { id: `${conversation.key}\nnotion`, conversationKey: conversation.key, destinationId: 'notion', externalId: 'page', revision: 1, contentHash: 'hash-1' });
  expect((await listArchiveRows())[0]!.destinations?.notion).toBe('saved');
  expect(await searchArchive({ query: 'Hello', provider: 'claude' })).toHaveLength(1);
  await database.put('conversations', { ...conversation, title: 'Fresh unique edited title' });
  expect(await searchArchive({ query: 'unique edited' })).toHaveLength(1);
  await database.delete('conversations', conversation.key);
  expect(await searchArchive({ query: 'unique edited' })).toHaveLength(0);
  database.close();
});
