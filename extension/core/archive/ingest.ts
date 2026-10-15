import { conversationKey, type ArchivedMessage } from '../contracts/conversation.ts';
import { archivedMessageSchema, captureWarningSchema, type CaptureWarning } from '../contracts/content.ts';
import { commitConversationWithJobs, readConversation } from './repository.ts';
import { sha256Hex } from './hash.ts';
import { readNotionConfig } from '../../destinations/notion/config.ts';
import { readSettings } from '../settings.ts';
import { getEntitlementStatus } from '../licensing/policy.ts';

export interface IngestDraft {
  provider: 'chatgpt' | 'claude' | 'grok';
  accountScope: string;
  sourceId: string;
  sourceUrl: string;
  title: string | null;
  text: string;
  messages?: ArchivedMessage[];
  replace?: boolean;
  completeness: 'complete' | 'partial' | 'unknown';
  warning: string | null;
  warnings?: CaptureWarning[];
  manual: boolean;
  captureKind?: 'automatic' | 'history' | 'manual';
  createdAt?: string | null;
  updatedAt?: string | null;
  projectName?: string | null;
  projectSlug?: string | null;
}

function messageText(entry: ArchivedMessage): string {
  return entry.blocks.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'code') return block.code;
    if (block.type === 'artifact') return `${block.name}\n${block.content}`;
    if (block.type === 'math') return block.tex;
    if (block.type === 'table') return JSON.stringify([block.header, block.rows]);
    if (block.type === 'citation') return block.title ?? block.url;
    if (block.type === 'unsupported') return block.description;
    return block.name;
  }).join('\n');
}

function mergeMessages(existing: ArchivedMessage[], incoming: ArchivedMessage[]): ArchivedMessage[] {
  const next = [...existing];
  for (const entry of incoming) {
    if (entry.sourceId) {
      const index = next.findIndex((item) => item.sourceId === entry.sourceId);
      if (index >= 0) next[index] = entry;
      else next.push(entry);
      continue;
    }
    const last = next.at(-1);
    const text = messageText(entry);
    const previous = last ? messageText(last) : '';
    if (last && last.role === entry.role &&
      (text === previous || text.startsWith(previous) || previous.startsWith(text))) {
      if (text.length >= previous.length) next[next.length - 1] = entry;
    } else next.push(entry);
  }
  return next;
}

const inFlight = new Map<string, Promise<unknown>>();

export function ingestDraft(draft: IngestDraft): Promise<'saved' | 'unchanged' | 'paused' | 'ignored'> {
  const key = conversationKey(draft.provider, draft.accountScope, draft.sourceId);
  const previous = inFlight.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => ingest(draft)).finally(() => {
    if (inFlight.get(key) === current) inFlight.delete(key);
  });
  inFlight.set(key, current);
  return current;
}

async function ingest(draft: IngestDraft): Promise<'saved' | 'unchanged' | 'paused' | 'ignored'> {
  const settings = await readSettings();
  const kind = draft.captureKind ?? (draft.manual ? 'manual' : 'automatic');
  if (kind === 'automatic' && (!settings.autoSync || !(await getEntitlementStatus()).autoCaptureAllowed)) return 'paused';
  if (kind === 'history' && !(await getEntitlementStatus()).canImportHistory) return 'paused';
  if (!draft.sourceId.trim() || !draft.accountScope.trim()) return 'ignored';
  const key = conversationKey(draft.provider, draft.accountScope, draft.sourceId);
  const existing = await readConversation(key);
  const provided = (draft.messages ?? []).map((message) => archivedMessageSchema.parse(message))
    .filter((message) => messageText(message).trim().length > 0);
  const text = draft.text.trim();
  const incoming: ArchivedMessage[] = provided.length > 0 ? provided : text ? [{
    sourceId: null, role: 'assistant', blocks: [{ type: 'text', text }],
    createdAt: null, model: null, parentId: null, branchId: null,
  }] : [];
  if (incoming.length === 0) return 'ignored';
  const messages = draft.replace === false && existing ? mergeMessages(existing.messages, incoming) : incoming;
  const now = new Date().toISOString();
  const title = draft.title?.trim() || existing?.title || 'Untitled';
  const createdAt = draft.createdAt === undefined ? existing?.createdAt ?? null : draft.createdAt;
  const updatedAt = draft.updatedAt === undefined ? existing?.updatedAt ?? null : draft.updatedAt;
  const suppliedWarnings = draft.warnings ?? (draft.warning ? [{
    code: 'partial', description: draft.warning, messageId: null, blockIndex: null,
  }] : []);
  const warnings = captureWarningSchema.array().parse(
    draft.replace === false && existing ? [...existing.warnings, ...suppliedWarnings] : suppliedWarnings,
  ).filter((warning, index, all) => all.findIndex((item) =>
    item.code === warning.code && item.description === warning.description &&
    item.messageId === warning.messageId && item.blockIndex === warning.blockIndex) === index);
  const projectName = draft.projectName === undefined ? existing?.projectName ?? null : draft.projectName;
  const projectSlug = draft.projectSlug === undefined ? existing?.projectSlug ?? null : draft.projectSlug;
  // Observation times do not affect the revision; metadata and every content block do.
  const contentHash = await sha256Hex(JSON.stringify({
    title, sourceUrl: draft.sourceUrl, createdAt, updatedAt, messages, warnings,
    completeness: draft.completeness, projectName, projectSlug,
  }));
  const destinations: string[] = settings.markdownEnabled ? ['markdown'] : [];
  if (await readNotionConfig()) destinations.push('notion');
  const result = await commitConversationWithJobs({
    key, provider: draft.provider, accountScope: draft.accountScope, sourceId: draft.sourceId,
    sourceUrl: draft.sourceUrl, title, createdAt, updatedAt,
    capturedAt: existing?.capturedAt ?? now, messages, warnings,
    completeness: draft.completeness, revision: existing?.revision ?? 1, contentHash,
    projectName, projectSlug,
  }, destinations);
  return result.changed ? 'saved' : 'unchanged';
}
