import { z } from 'zod';

const baseCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('provider.connect'),
    provider: z.enum(['chatgpt', 'claude', 'grok']),
  }).strict(),
  z.object({
    action: z.literal('provider.disconnect'),
    provider: z.enum(['chatgpt', 'claude', 'grok']),
  }).strict(),
  z.object({ action: z.literal('capture.active') }).strict(),
  z.object({
    action: z.literal('import.start'),
    provider: z.enum(['chatgpt', 'claude']),
  }).strict(),
  z.object({
    action: z.literal('import.pause'),
    importId: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal('import.resume'),
    importId: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal('destination.configure'),
    destinationId: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal('delivery.retry'),
    jobId: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal('license.activate'),
    licenseKey: z.string().min(1),
  }).strict(),
  z.object({ action: z.literal('license.deactivate') }).strict(),
  z.object({ action: z.literal('archive.clear') }).strict(),
]);

const noArgs = <T extends string>(action: T) => z.object({ action: z.literal(action) }).strict();
const historyProvider = z.enum(['chatgpt', 'claude']).optional();
const archiveProvider = z.enum(['chatgpt', 'claude', 'grok']).optional();
export const trustedCommandSchema = z.discriminatedUnion('action', [
  ...baseCommandSchema.options,
  noArgs('status.get'), noArgs('settings.get'),
  z.object({ action: z.literal('provider.check'), provider: z.literal('claude') }).strict(),
  z.object({ action: z.literal('provider.reset'), provider: z.literal('claude') }).strict(),
  z.object({ action: z.literal('settings.set'), patch: z.record(z.unknown()) }).strict(),
  z.object({ action: z.literal('archive.list'), provider: archiveProvider }).strict(),
  z.object({ action: z.literal('archive.search'), query: z.string().max(2000), provider: archiveProvider }).strict(),
  z.object({ action: z.literal('archive.get'), key: z.string().min(1).max(2000) }).strict(),
  z.object({ action: z.literal('archive.read'), key: z.string().min(1).max(2000) }).strict(),
  noArgs('inbox.read'), noArgs('inbox.refresh'),
  z.object({ action: z.literal('inbox.save'), chat: z.object({
    provider: z.enum(['chatgpt', 'claude']), id: z.string().min(1).max(1000),
    accountScope: z.string().min(1).max(1000), title: z.string().max(2000),
    updatedAt: z.string().nullable(), projectName: z.string().nullable().optional(),
    projectSlug: z.string().nullable().optional(),
  }).strict() }).strict(),
  z.object({ action: z.literal('sync.run'), limit: z.number().int().min(1).max(500).optional(),
    full: z.boolean().optional(), provider: historyProvider }).strict(),
  z.object({ action: z.literal('sync.pause'), provider: historyProvider }).strict(),
  z.object({ action: z.literal('sync.resume'), provider: historyProvider }).strict(),
  noArgs('import.status'), noArgs('conversation.save'), noArgs('grok.capture'), noArgs('history.import'),
  z.object({ action: z.literal('notion.save'), token: z.string().min(1).max(2000),
    databaseId: z.string().min(1).max(2000), createProperties: z.boolean().optional(),
    parentType: z.enum(['database_id', 'data_source_id']).optional() }).strict(),
  noArgs('notion.disconnect'), noArgs('notion.status'), noArgs('license.status'),
  noArgs('edits.list'),
  z.object({ action: z.literal('edits.resolve'), jobId: z.string().min(1).max(3000),
    choice: z.enum(['keep', 'replace', 'copy']) }).strict(),
  noArgs('queue.run'),
  z.object({ action: z.literal('job.retry'), jobId: z.string().min(1).max(3000) }).strict(),
  noArgs('diagnostics.copy'), noArgs('samples.export'),
]);

export type TrustedCommand = z.infer<typeof trustedCommandSchema>;

export function parseTrustedCommand(input: unknown) {
  return trustedCommandSchema.safeParse(input);
}
