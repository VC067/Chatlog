import { z } from 'zod';

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('code'),
    language: z.string().nullable(),
    code: z.string(),
  }),
  z.object({
    type: z.literal('citation'),
    url: z.string().url(),
    title: z.string().nullable(),
  }),
  z.object({
    type: z.literal('attachment'),
    name: z.string().min(1),
    mediaType: z.string().nullable(),
    sourceRef: z.string().nullable(),
  }),
  z.object({
    type: z.literal('unsupported'),
    code: z.string().min(1),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('table'),
    header: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }),
  z.object({
    type: z.literal('math'),
    tex: z.string(),
    display: z.boolean(),
  }),
  z.object({
    type: z.literal('image'),
    name: z.string().min(1),
    sourceRef: z.string().nullable(),
    savedPath: z.string().nullable(),
    mediaType: z.string().nullable().optional(),
    origin: z.enum(['uploaded', 'created']).optional(),
  }),
  z.object({
    type: z.literal('artifact'),
    sourceId: z.string().min(1),
    name: z.string().min(1),
    mediaType: z.string().nullable(),
    language: z.string().nullable(),
    content: z.string().min(1),
    savedPath: z.string().nullable(),
  }),
  z.object({
    type: z.literal('file'),
    name: z.string().min(1),
    mediaType: z.string().nullable(),
    sourceRef: z.string().nullable(),
    savedPath: z.string().nullable(),
  }),
]);

export const archivedMessageSchema = z.object({
  sourceId: z.string().min(1).nullable(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  blocks: z.array(contentBlockSchema),
  createdAt: z.string().datetime().nullable(),
  model: z.string().min(1).nullable(),
  parentId: z.string().min(1).nullable(),
  branchId: z.string().min(1).nullable(),
});

export const captureWarningSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1),
  messageId: z.string().min(1).nullable(),
  blockIndex: z.number().int().nonnegative().nullable(),
});

export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ArchivedMessage = z.infer<typeof archivedMessageSchema>;
export type CaptureWarning = z.infer<typeof captureWarningSchema>;
