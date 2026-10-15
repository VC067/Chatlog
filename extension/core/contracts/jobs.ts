import { z } from 'zod';

export const jobStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'retry_wait',
  'blocked',
  'needs_review',
  'failed',
]);

export const deliveryJobSchema = z.object({
  id: z.string().min(1),
  conversationKey: z.string().min(1),
  revision: z.number().int().nonnegative(),
  destinationId: z.string().min(1),
  operation: z.literal('upsert'),
  state: jobStateSchema,
  attempts: z.number().int().nonnegative(),
  nextEligibleAt: z.string().datetime().nullable(),
  leaseOwner: z.string().min(1).nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  checkpoint: z
    .object({
      step: z.string().min(1),
      cursor: z.string().nullable(),
    })
    .nullable(),
  errorCode: z.string().min(1).nullable(),
});

export const importSessionSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(['chatgpt', 'claude']),
  accountScope: z.string().min(1),
  state: z.enum(['running', 'paused', 'cancelled', 'completed', 'failed']),
  discoveredCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  checkpoint: z
    .object({
      cursor: z.string().nullable(),
      pending: z.array(z.object({
        id: z.string(), title: z.string(), accountScope: z.string(),
        updatedAt: z.string().nullable(), projectName: z.string().nullable(), projectSlug: z.string().nullable(),
      })).optional(),
      exhausted: z.boolean().optional(),
    })
    .nullable(),
  maxItems: z.number().int().positive().nullable().optional(),
  manual: z.boolean().optional(),
  leaseOwner: z.string().nullable().optional(),
  leaseExpiresAt: z.string().nullable().optional(),
  nextEligibleAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  warning: z.enum(['claude_accounts_skipped']).optional(),
  skippedCount: z.number().int().nonnegative().optional(),
  skippedIds: z.array(z.string()).max(20).optional(),
});

export const destinationRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['markdown', 'notion']),
  label: z.string().min(1),
  enabled: z.boolean(),
});

export type JobState = z.infer<typeof jobStateSchema>;
export type DeliveryJob = z.infer<typeof deliveryJobSchema>;
export type ImportSession = z.infer<typeof importSessionSchema>;
export type DestinationRecord = z.infer<typeof destinationRecordSchema>;
