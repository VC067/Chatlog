import { z } from 'zod';
import { archivedMessageSchema, captureWarningSchema } from './content.ts';

export const providerSchema = z.enum(['chatgpt', 'claude', 'grok']);

export const archivedConversationSchema = z.object({
  key: z.string().min(1),
  provider: providerSchema,
  accountScope: z.string().min(1),
  sourceId: z.string().min(1),
  sourceUrl: z.string().url(),
  title: z.string(),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
  capturedAt: z.string().datetime(),
  messages: z.array(archivedMessageSchema),
  warnings: z.array(captureWarningSchema),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  revision: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  projectName: z.string().nullable().default(null),
  projectSlug: z.string().nullable().default(null),
});

export type Provider = z.infer<typeof providerSchema>;
export type ArchivedConversation = z.infer<typeof archivedConversationSchema>;
export type { ArchivedMessage } from './content.ts';

export function conversationKey(
  provider: Provider,
  accountScope: string,
  sourceId: string,
): string {
  return `${provider}:${accountScope}:${sourceId}`;
}
