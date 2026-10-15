import { archivedConversationSchema, conversationKey } from '../../core/contracts/conversation.ts';
import type { ArchivedConversation } from '../../core/contracts/conversation.ts';

export function buildConversation(
  overrides: Partial<ArchivedConversation> = {},
): ArchivedConversation {
  const provider = overrides.provider ?? 'chatgpt';
  const accountScope = overrides.accountScope ?? 'acct-1';
  const sourceId = overrides.sourceId ?? 'conv-1';
  const parsed = archivedConversationSchema.parse({
    key: conversationKey(provider, accountScope, sourceId),
    provider,
    accountScope,
    sourceId,
    sourceUrl: 'https://chatgpt.com/c/conv-1',
    title: 'Fixture conversation',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:01:00.000Z',
    capturedAt: '2026-10-05T00:02:00.000Z',
    messages: [
      {
        sourceId: 'msg-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Hello' }],
        createdAt: '2026-10-05T00:00:00.000Z',
        model: null,
        parentId: null,
        branchId: null,
      },
    ],
    warnings: [],
    completeness: 'complete',
    revision: 1,
    contentHash: 'hash-1',
    ...overrides,
  });
  return parsed;
}
