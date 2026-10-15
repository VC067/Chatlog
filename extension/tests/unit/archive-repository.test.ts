import { openDB, deleteDB } from 'idb';
import { beforeEach, expect, it } from 'vitest';
import {
  listConversations,
  readConversation,
  readJob,
  saveConversationAndJob,
  upsertConversation,
} from '../../core/archive/repository.ts';
import { openVaultDb } from '../../core/storage/db.ts';
import { buildConversation } from '../fixtures/factories.ts';

beforeEach(async () => {
  await deleteDB('vaultdraft');
});

it('updates the same conversation and keeps a separate account', async () => {
  const first = await upsertConversation(buildConversation());
  const same = await upsertConversation(
    buildConversation({ capturedAt: '2026-10-06T00:00:00.000Z' }),
  );
  const changed = await upsertConversation(
    buildConversation({ contentHash: 'hash-2', title: 'Updated' }),
  );
  await upsertConversation(
    buildConversation({
      accountScope: 'acct-2',
      key: 'chatgpt:acct-2:conv-1',
      contentHash: 'hash-9',
    }),
  );

  expect(first.revision).toBe(1);
  expect(same.revision).toBe(1);
  expect(same.title).toBe('Fixture conversation');
  expect(changed.revision).toBe(2);
  expect(changed.title).toBe('Updated');
  await expect(listConversations('chatgpt', 'acct-1')).resolves.toHaveLength(1);
  await expect(listConversations('chatgpt', 'acct-2')).resolves.toHaveLength(1);
});

it('rolls back a conversation when the paired job write is interrupted', async () => {
  const conversation = buildConversation();
  const database = await openVaultDb();
  try {
    const tx = database.transaction(['conversations', 'jobs'], 'readwrite');
    const write = tx.objectStore('conversations').put(conversation);
    tx.abort();
    const settled = await Promise.allSettled([write, tx.done]);
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
  } finally {
    database.close();
  }
  await expect(readConversation(conversation.key)).resolves.toBeNull();
});

it('stores a conversation and job together', async () => {
  const conversation = buildConversation();
  await saveConversationAndJob(conversation, {
    id: 'job-1',
    conversationKey: conversation.key,
    revision: conversation.revision,
    destinationId: 'markdown',
    operation: 'upsert',
    state: 'pending',
    attempts: 0,
    nextEligibleAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpoint: null,
    errorCode: null,
  });
  expect((await readConversation(conversation.key))?.key).toBe(conversation.key);
  expect((await readJob('job-1'))?.destinationId).toBe('markdown');
});

it('keeps a version 1 folder handle after the archive upgrade', async () => {
  const version1 = await openDB('vaultdraft', 1, {
    upgrade(database) {
      database.createObjectStore('handles');
    },
  });
  await version1.put('handles', { kind: 'directory' }, 'markdown-root');
  version1.close();

  const upgraded = await openVaultDb();
  await expect(upgraded.get('handles', 'markdown-root')).resolves.toEqual({
    kind: 'directory',
  });
  expect(upgraded.objectStoreNames.contains('conversations')).toBe(true);
  expect(upgraded.objectStoreNames.contains('jobs')).toBe(true);
  upgraded.close();
});
