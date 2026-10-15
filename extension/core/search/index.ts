import MiniSearch from 'minisearch';
import { archivedConversationSchema, type ArchivedConversation, type Provider } from '../contracts/conversation.ts';
import type { ContentBlock } from '../contracts/content.ts';
import { openVaultDb, type DeliveryMapping } from '../storage/db.ts';
import type { DeliveryJob } from '../contracts/jobs.ts';

export interface ArchiveRow {
  key: string;
  title: string;
  provider: Provider;
  capturedAt: string;
  updatedAt: string | null;
  preview: string;
  completeness: ArchivedConversation['completeness'];
  warningsCount: number;
  destinations?: { markdown: string; notion: string };
}
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text;
    case 'code': return `${block.language ?? ''}\n${block.code}`;
    case 'artifact': return `${block.name}\n${block.content}`;
    case 'citation': return `${block.title ?? ''}\n${block.url}`;
    case 'table': return [block.header, ...block.rows].map((row) => row.join(' ')).join('\n');
    case 'math': return block.tex;
    case 'unsupported': return block.description;
    default: return `${block.name}\n${block.sourceRef ?? ''}`;
  }
}
export function searchableConversationText(conversation: ArchivedConversation): string {
  return [conversation.title, conversation.sourceUrl, conversation.projectName ?? '', ...conversation.messages.flatMap((message) => message.blocks.map(blockText)), ...conversation.warnings.map((warning) => warning.description)].join('\n');
}
function normalize(value: string): string { return value.normalize('NFKC').toLocaleLowerCase(); }
function snippet(text: string, query = ''): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const matches = terms.map((term) => normalize(compact).indexOf(term)).filter((index) => index >= 0);
  const start = matches.length ? Math.max(0, Math.min(...matches) - 70) : 0;
  return `${start ? '…' : ''}${compact.slice(start, start + 240)}${start + 240 < compact.length ? '…' : ''}`;
}
function destinationState(conversation: ArchivedConversation, destination: string, mappings: DeliveryMapping[], jobs: DeliveryJob[]): string {
  const mapping = mappings.find((item) => item.conversationKey === conversation.key && item.destinationId === destination);
  const job = jobs.filter((item) => item.conversationKey === conversation.key && item.destinationId === destination).sort((a, b) => b.revision - a.revision)[0];
  if (job && job.revision >= conversation.revision) {
    if (job.state === 'completed') {
      if (job.errorCode === 'kept_user_edits') return 'kept_edits';
      if (job.errorCode === 'superseded' || job.revision !== conversation.revision) return 'superseded';
      if (job.errorCode === 'delivery_unavailable' || !mapping?.externalId || mapping.revision !== conversation.revision) return 'unavailable';
      return job.errorCode ? 'needs_review' : 'saved';
    }
    if (job.state === 'running' || job.state === 'pending' || job.state === 'retry_wait') return 'pending';
    return job.state;
  }
  if (mapping?.externalId && mapping.revision === conversation.revision) return 'saved';
  if (mapping?.revision && mapping.revision > conversation.revision) return 'superseded';
  return mapping ? mapping.externalId ? 'pending' : 'unavailable' : 'not_configured';
}
async function loadArchive(query = '', provider?: Provider): Promise<ArchiveRow[]> {
  const database = await openVaultDb();
  let conversations: ArchivedConversation[];
  let mappings: DeliveryMapping[];
  let jobs: DeliveryJob[];
  try {
    const tx = database.transaction(['conversations', 'deliveries', 'jobs'], 'readonly');
    const values = await Promise.all([tx.objectStore('conversations').getAll(), tx.objectStore('deliveries').getAll(), tx.objectStore('jobs').getAll()]);
    await tx.done;
    conversations = values[0].flatMap((row) => { const parsed = archivedConversationSchema.safeParse(row); return parsed.success ? [parsed.data] : []; });
    mappings = values[1];
    jobs = values[2];
  } finally { database.close(); }
  const texts = new Map(conversations.map((conversation) => [conversation.key, searchableConversationText(conversation)]));
  const index = new MiniSearch<{ key: string; title: string; text: string }>({ idField: 'key', fields: ['title', 'text'], searchOptions: { prefix: true, combineWith: 'AND' } });
  index.addAll(conversations.map((conversation) => ({ key: conversation.key, title: conversation.title, text: texts.get(conversation.key)! })));
  const trimmed = query.trim();
  const hits = new Set(trimmed ? index.search(trimmed).map((hit) => hit.id as string) : []);
  const terms = normalize(trimmed).split(/\s+/).filter(Boolean);
  return conversations.filter((conversation) => {
    if (provider && conversation.provider !== provider) return false;
    const text = normalize(texts.get(conversation.key)!);
    return !trimmed || hits.has(conversation.key) || terms.every((term) => text.includes(term));
  }).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || a.key.localeCompare(b.key)).map((conversation) => ({
    key: conversation.key, title: conversation.title, provider: conversation.provider, capturedAt: conversation.capturedAt,
    updatedAt: conversation.updatedAt, preview: snippet(texts.get(conversation.key)!, trimmed), completeness: conversation.completeness,
    warningsCount: conversation.warnings.length,
    destinations: { markdown: destinationState(conversation, 'markdown', mappings, jobs), notion: destinationState(conversation, 'notion', mappings, jobs) },
  }));
}
export function listArchiveRows(): Promise<ArchiveRow[]> { return loadArchive(); }
export function searchArchive(input: { query: string; provider?: Provider }): Promise<ArchiveRow[]> { return loadArchive(input.query, input.provider); }
