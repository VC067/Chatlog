import { expect, it } from 'vitest';
import { AppError, errorCodes } from '../../core/errors/app-error.ts';
import { archivedConversationSchema } from '../../core/contracts/conversation.ts';
import { conversationKey } from '../../core/contracts/conversation.ts';
import { importSessionSchema } from '../../core/contracts/jobs.ts';
import { parseTrustedCommand } from '../../core/contracts/messages.ts';
import { buildConversation } from '../fixtures/factories.ts';
import { createClock } from '../helpers/clock.ts';

it('parses a valid conversation', () => {
  const conversation = buildConversation();
  expect(conversation.key).toBe('chatgpt:acct-1:conv-1');
  expect(conversation.messages[0]?.blocks[0]).toEqual({
    type: 'text',
    text: 'Hello',
  });
});

it('keeps the conversation key independent from capturedAt', () => {
  const first = buildConversation();
  const second = buildConversation({ capturedAt: '2026-10-06T00:00:00.000Z' });
  expect(first.key).toBe(second.key);
  expect(conversationKey('claude', 'org-1', 'thread-1')).toBe(
    'claude:org-1:thread-1',
  );
});

it('rejects an invalid role, provider, and empty source id', () => {
  const conversation = buildConversation();
  expect(
    archivedConversationSchema.safeParse({
      ...conversation,
      messages: [{ ...conversation.messages[0], role: 'narrator' }],
    }).success,
  ).toBe(false);
  expect(
    archivedConversationSchema.safeParse({
      ...conversation,
      provider: 'gemini',
    }).success,
  ).toBe(false);
  expect(
    archivedConversationSchema.safeParse({
      ...conversation,
      sourceId: '',
    }).success,
  ).toBe(false);
});

it('strips additive conversation fields', () => {
  const conversation = buildConversation();
  const parsed = archivedConversationSchema.parse({
    ...conversation,
    providerMeta: { experiment: true },
  });
  expect(parsed).not.toHaveProperty('providerMeta');
});

it('parses trusted commands and rejects extra fields', () => {
  expect(parseTrustedCommand({ action: 'archive.clear' }).success).toBe(true);
  expect(parseTrustedCommand({ action: 'archive.clear', extra: true }).success).toBe(
    false,
  );
});

it('rejects a grok history import', () => {
  expect(
    importSessionSchema.safeParse({
      id: 'imp-1',
      provider: 'grok',
      accountScope: 'acct-1',
      state: 'running',
      discoveredCount: 0,
      completedCount: 0,
      checkpoint: null,
    }).success,
  ).toBe(false);
});

it('advances the fake clock', () => {
  const clock = createClock('2026-10-05T00:00:00.000Z');
  expect(clock.now()).toBe('2026-10-05T00:00:00.000Z');
  clock.advance(1500);
  expect(clock.now()).toBe('2026-10-05T00:00:01.500Z');
});

it('fills project fields when an older archive row omits them', () => {
  const conversation = buildConversation();
  const stored = { ...conversation };
  delete (stored as { projectName?: string | null }).projectName;
  delete (stored as { projectSlug?: string | null }).projectSlug;
  const parsed = archivedConversationSchema.parse(stored);
  expect(parsed.projectName).toBeNull();
  expect(parsed.projectSlug).toBeNull();
});

it('accepts table, math, image, and file blocks', () => {
  const conversation = buildConversation({
    messages: [
      {
        sourceId: null,
        role: 'assistant',
        blocks: [
          { type: 'table', header: ['A'], rows: [['1']] },
          { type: 'math', tex: 'E=mc^2', display: true },
          { type: 'image', name: 'shot.png', sourceRef: null, savedPath: null },
          { type: 'file', name: 'note.html', mediaType: 'text/html', sourceRef: null, savedPath: 'chatgpt/files/note/note.html' },
        ],
        createdAt: null,
        model: null,
        parentId: null,
        branchId: null,
      },
    ],
  });
  expect(conversation.messages[0]?.blocks).toHaveLength(4);
});

it('exposes stable error codes', () => {
  const error = new AppError(errorCodes.oversizedPayload, 'too large');
  expect(error.code).toBe('oversized_payload');
  expect(error).toBeInstanceOf(Error);
});
