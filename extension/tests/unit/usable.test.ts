import { deleteDB } from 'idb';
import { beforeEach, expect, it, vi } from 'vitest';
import { stableHash } from '../../core/archive/hash.ts';
import { ingestDraft } from '../../core/archive/ingest.ts';
import { claimJob, readConversation, saveJob } from '../../core/archive/repository.ts';
import { trialDaysLeft } from '../../core/licensing/policy.ts';
import { decideFileWrite } from '../../destinations/markdown/conflict.ts';
import { markdownRelativePath, sanitizePathSegment } from '../../destinations/markdown/paths.ts';
import { titleFromText } from '../../providers/shared/extract.ts';
import { conversationFromChatGpt } from '../../providers/shared/normalize.ts';
import { buildConversation } from '../fixtures/factories.ts';

beforeEach(async () => {
  await deleteDB('vaultdraft');
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
  });
});

it('uses the first non-empty line as a title', () => {
  expect(titleFromText('First line\nsecond')).toBe('First line');
});

it('builds a safe markdown path', () => {
  const conversation = buildConversation({
    title: 'CON: bad/name?',
    sourceId: 'id:1',
  });
  expect(sanitizePathSegment('CON')).toBe('conversation');
  expect(markdownRelativePath(conversation)).toContain('chatgpt/');
  expect(markdownRelativePath(conversation)).not.toContain('?');
  expect(markdownRelativePath(conversation)).not.toContain(':');
});

it('keeps a file when its text no longer matches the last export', () => {
  expect(decideFileWrite(null, null, 'next')).toBe('write');
  const previous = 'previous';
  expect(decideFileWrite(previous, stableHash(previous), 'next')).toBe('write');
  expect(decideFileWrite('edited by hand', stableHash(previous), 'next')).toBe('keep-edits');
  expect(decideFileWrite('next', stableHash(previous), 'next')).toBe('skip');
});

it('counts a 14 day trial', () => {
  const started = Date.parse('2026-10-01T00:00:00.000Z');
  expect(trialDaysLeft(started, started)).toBe(14);
  expect(trialDaysLeft(started, started + 14 * 24 * 60 * 60 * 1000)).toBe(0);
});

it('saves a manual draft and claims its job once', async () => {
  const outcome = await ingestDraft({
    provider: 'chatgpt',
    accountScope: 'default',
    sourceId: 'conv-9',
    sourceUrl: 'https://chatgpt.com/c/conv-9',
    title: 'Notes',
    text: 'Remember the migration',
    completeness: 'unknown',
    warning: null,
    manual: true,
  });
  expect(outcome).toBe('saved');
  const saved = await readConversation('chatgpt:default:conv-9');
  expect(saved?.title).toBe('Notes');
  const jobId = `markdown:${saved?.key}:${saved?.revision}`;
  await saveJob({
    id: jobId,
    conversationKey: saved?.key ?? '',
    revision: saved?.revision ?? 1,
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
  const now = new Date().toISOString();
  const claimed = await claimJob(jobId, now, new Date(Date.now() + 30_000).toISOString());
  expect(claimed?.state).toBe('running');
  expect(await claimJob(jobId, now, new Date(Date.now() + 30_000).toISOString())).toBeNull();
});

it('keeps saving chats when no license is stored', async () => {
  const first = await ingestDraft({
    provider: 'chatgpt',
    accountScope: 'default',
    sourceId: 'open-1',
    sourceUrl: 'https://chatgpt.com/c/open-1',
    title: 'First',
    text: 'First transcript',
    completeness: 'unknown',
    warning: null,
    manual: false,
  });
  const second = await ingestDraft({
    provider: 'chatgpt',
    accountScope: 'default',
    sourceId: 'open-2',
    sourceUrl: 'https://chatgpt.com/c/open-2',
    title: 'Second',
    text: 'Second transcript',
    completeness: 'unknown',
    warning: null,
    manual: false,
  });
  expect(first).toBe('saved');
  expect(second).toBe('saved');
});

it('reads a ChatGPT history mapping', () => {
  const conversation = conversationFromChatGpt(
    {
      id: 'abc',
      title: 'Mapping',
      mapping: {
        a: {
          message: {
            author: { role: 'user' },
            content: { parts: ['Question'] },
          },
        },
        b: {
          message: {
            author: { role: 'assistant' },
            content: { parts: ['Answer'] },
          },
        },
      },
    },
    'https://chatgpt.com/c/abc',
  );
  expect(conversation?.messages).toHaveLength(2);
  expect(conversation?.title).toBe('Mapping');
});

it('reads ChatGPT text stored as objects', () => {
  const conversation = conversationFromChatGpt(
    {
      conversation_id: 'abc',
      title: 'Objects',
      mapping: {
        a: {
          message: {
            author: { role: 'user' },
            content: { parts: [{ text: 'Question' }] },
          },
        },
      },
    },
    'https://chatgpt.com/c/abc',
  );
  expect(conversation?.sourceId).toBe('abc');
  expect(conversation?.messages[0]?.blocks[0]).toEqual({ type: 'text', text: 'Question' });
});
