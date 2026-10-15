import { conversationKey } from '../../core/contracts/conversation.ts';
import type { ArchivedConversation, ArchivedMessage } from '../../core/contracts/conversation.ts';
import { stableHash } from '../../core/archive/hash.ts';
import type { ContentBlock } from '../../core/contracts/content.ts';
import { stripUnsupportedBlocks } from './placeholders.ts';

type Provider = 'chatgpt' | 'claude';

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === 'string' && (record[key] as string).trim()) return (record[key] as string).trim();
  return null;
}

function providerUrl(value: string, provider: Provider): string | null {
  try {
    const origin = provider === 'claude' ? 'https://claude.ai' : 'https://chatgpt.com';
    const parsed = new URL(value, origin);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch { return null; }
}

function mediaFields(record: Record<string, unknown>): { mediaType: string | null; name: string | null } {
  return {
    mediaType: firstString(record, ['media_type', 'mime_type', 'content_type', 'file_type']),
    name: firstString(record, ['file_name', 'filename', 'name']),
  };
}

function imageBlocksFromPart(part: unknown, provider: Provider, role: ArchivedMessage['role']): ContentBlock[] {
  const record = recordOf(part);
  if (!record || (typeof record.text === 'string' && !record.type)) return [];
  const source = recordOf(record.source);
  const imageUrl = record.image_url;
  const imageUrlRecord = recordOf(imageUrl);
  const mediaRecord = source ?? record;
  const mediaType = firstString(mediaRecord, ['media_type', 'mime_type', 'content_type', 'file_type']) ?? firstString(record, ['media_type', 'mime_type', 'content_type', 'file_type']);
  const imageMediaType = mediaType === 'image_asset_pointer' ? null : mediaType;
  const imageKind = record.type === 'image' || imageUrl !== undefined || (mediaType?.startsWith('image/') ?? false) || mediaType === 'image_asset_pointer' || provider === 'claude' && record.file_kind === 'image';
  const fileKind = record.type === 'file' || record.type === 'attachment' || record.attachment === true;
  const refs: string[] = [];
  const sourceUrl = source && typeof source.url === 'string' ? source.url : null;
  if ((imageKind || fileKind) && sourceUrl) refs.push(sourceUrl);
  if (typeof imageUrl === 'string') refs.push(imageUrl);
  if (imageUrlRecord && typeof imageUrlRecord.url === 'string') refs.push(imageUrlRecord.url);
  if (imageKind || fileKind) {
    for (const key of ['download_url', 'file_url', 'url']) if (typeof record[key] === 'string') refs.push(record[key] as string);
  }
  if (provider === 'claude' && imageKind && refs.length === 0) {
    const preview = recordOf(record.preview_asset);
    const previewUrl = preview && typeof preview.url === 'string' ? preview.url : typeof record.preview_url === 'string' ? record.preview_url : null;
    if (previewUrl) refs.push(previewUrl);
  }
  const named = firstString(record, ['file_name', 'filename', 'name']) ?? (source ? firstString(source, ['file_name', 'filename', 'name']) : null);
  const base64Source = source && source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string' && source.media_type.startsWith('image/') ? source : null;
  const blocks: ContentBlock[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    const ref = providerUrl(raw, provider);
    if (!ref || seen.has(ref)) continue;
    const isImage = imageKind || mediaType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)(?:$|[?#])/i.test(ref);
    if (!isImage) continue;
    seen.add(ref);
    let fallback = 'image';
    try { fallback = decodeURIComponent(new URL(ref).pathname.split('/').filter(Boolean).at(-1) ?? 'image'); } catch { /* use fallback */ }
    blocks.push({ type: 'image', name: (named ?? fallback).slice(0, 80), sourceRef: ref, savedPath: null, ...(imageMediaType ? { mediaType: imageMediaType } : {}), origin: role === 'assistant' ? 'created' : 'uploaded' });
  }
  const assetPointer = (source && typeof source.asset_pointer === 'string' ? source.asset_pointer : null) ?? (typeof record.asset_pointer === 'string' ? record.asset_pointer : null);
  if ((imageKind || assetPointer) && assetPointer && !seen.has(assetPointer)) {
    seen.add(assetPointer);
    blocks.push({ type: 'image', name: (named ?? 'image').slice(0, 80), sourceRef: assetPointer, savedPath: null, ...(imageMediaType ? { mediaType: imageMediaType } : {}), origin: role === 'assistant' ? 'created' : 'uploaded' });
  }
  if (base64Source) {
    const encoded = base64Source.data as string;
    const normalized = encoded.replace(/\s/g, '');
    const valid = normalized.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(normalized) && normalized.length % 4 === 0;
    const decodedBytes = valid ? (normalized.length / 4) * 3 - (normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0) : Infinity;
    const ref = `data:${base64Source.media_type};base64,${normalized}`;
    if (valid && decodedBytes <= 8_000_000 && !seen.has(ref)) {
      blocks.push({ type: 'image', name: (named ?? 'image').slice(0, 80), sourceRef: ref, savedPath: null, mediaType: base64Source.media_type as string, origin: role === 'assistant' ? 'created' : 'uploaded' });
    }
  }
  if (provider === 'claude' && record.file_kind === 'image' && blocks.length === 0) {
    blocks.push({ type: 'image', name: (named ?? 'image').slice(0, 80), sourceRef: null, savedPath: null, ...(imageMediaType ? { mediaType: imageMediaType } : {}), origin: role === 'assistant' ? 'created' : 'uploaded' });
  }
  if (fileKind && !blocks.some((block) => block.type === 'image')) {
    const ref = refs.map((raw) => providerUrl(raw, provider)).find((value): value is string => value !== null) ?? null;
    const fields = mediaFields(record);
    const identity = ref ?? `${fields.name ?? 'attachment'}:${fields.mediaType ?? ''}`;
    if (!seen.has(identity)) blocks.push({ type: 'attachment', name: (fields.name ?? 'attachment').slice(0, 80), mediaType: fields.mediaType, sourceRef: ref });
  }
  return blocks;
}

function mediaBlocks(parts: unknown, provider: Provider, role: ArchivedMessage['role']): ContentBlock[] {
  return Array.isArray(parts) ? parts.flatMap((part) => imageBlocksFromPart(part, provider, role)) : [];
}

function attachmentBlocks(parts: unknown, provider: Provider, role: ArchivedMessage['role']): ContentBlock[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part): ContentBlock[] => {
    const record = recordOf(part);
    if (!record) return [];
    const images = imageBlocksFromPart(record, provider, role);
    if (images.length) return images;
    const fields = mediaFields(record);
    const ref = ['download_url', 'file_url', 'url'].map((key) => record[key]).find((value): value is string => typeof value === 'string');
    return [{ type: 'attachment', name: (fields.name ?? 'attachment').slice(0, 80), mediaType: fields.mediaType, sourceRef: ref ? providerUrl(ref, provider) : null }];
  });
}

export function providerDate(value: unknown): string | null {
  const date = typeof value === 'number' ? new Date(value < 10_000_000_000 ? value * 1000 : value) : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

interface ArtifactSnapshot { name: string; mediaType: string | null; language: string | null; content: string }

function artifactBlocks(parts: unknown, snapshots: Map<string, ArtifactSnapshot>): { blocks: ContentBlock[]; recognized: Set<unknown> } {
  const blocks: ContentBlock[] = [];
  const recognized = new Set<unknown>();
  if (!Array.isArray(parts)) return { blocks, recognized };
  for (const part of parts) {
    const record = recordOf(part);
    if (!record) continue;
    const input = recordOf(record.input);
    const direct = record.type === 'artifact';
    const tool = record.type === 'tool_use' && record.name === 'artifacts';
    if (!direct && !tool) continue;
    recognized.add(part);
    const values = direct ? record : input;
    if (!values) {
      blocks.push({ type: 'unsupported', code: 'provider_content_unverified', description: 'Not saved: artifacts block. Open the original conversation to view it.' });
      continue;
    }
    const command = tool ? values.command : 'create';
    const sourceId = firstString(values, ['id', 'identifier', 'artifact_id']);
    const prior = sourceId ? snapshots.get(sourceId) : undefined;
    const name = firstString(values, ['title', 'name']) ?? prior?.name ?? sourceId;
    const explicitMime = firstString(values, ['media_type', 'mime_type', 'content_type', 'file_type']) ?? (typeof values.type === 'string' && values.type.includes('/') ? values.type : null);
    const mediaType = explicitMime ?? prior?.mediaType ?? null;
    const inferredLanguage = mediaType === 'text/html' ? 'html' : mediaType === 'image/svg+xml' ? 'svg' : mediaType === 'text/markdown' ? 'markdown' : null;
    const language = firstString(values, ['language']) ?? prior?.language ?? inferredLanguage;
    let content = typeof values.content === 'string' ? values.content : null;
    if (tool && command === 'update' && content === null && typeof values.old_str === 'string' && values.old_str.length > 0 && typeof values.new_str === 'string' && sourceId) {
      if (prior !== undefined) {
        const first = prior.content.indexOf(values.old_str);
        if (first >= 0 && first === prior.content.lastIndexOf(values.old_str)) content = prior.content.slice(0, first) + values.new_str + prior.content.slice(first + values.old_str.length);
      }
    }
    if (!sourceId || !name || !content || (tool && !['create', 'rewrite', 'update'].includes(String(command)))) {
      blocks.push({ type: 'unsupported', code: 'provider_content_unverified', description: 'Not saved: artifacts operation. Open the original conversation to view it.' });
      continue;
    }
    const snapshot = { name, mediaType, language, content };
    snapshots.set(sourceId, snapshot);
    blocks.push({ type: 'artifact', sourceId, name: name.slice(0, 120), mediaType, language, content, savedPath: null });
  }
  return { blocks, recognized };
}

function unsupportedContent(parts: unknown, provider: Provider, role: ArchivedMessage['role'], recognized = new Set<unknown>()): ContentBlock[] {
  return Array.isArray(parts) ? parts.flatMap((part) => {
    if (!part || typeof part !== 'object' || recognized.has(part) || ('text' in part && typeof part.text === 'string') || imageBlocksFromPart(part, provider, role).length > 0) return [];
    const rawType = 'type' in part && typeof part.type === 'string' ? part.type : '';
    const typeName = /^[a-z0-9_-]{1,40}$/i.test(rawType) ? rawType : 'unrecognized';
    return [{ type: 'unsupported' as const, code: 'provider_content_unverified', description: `Not saved: ${typeName} block. Open the original conversation to view it.` }];
  }) : [];
}

function roleOf(value: string): ArchivedMessage['role'] | null {
  if (value === 'user' || value === 'human') return 'user';
  if (value === 'assistant' || value === 'assistant_text') return 'assistant';
  if (value === 'system') return 'system';
  if (value === 'tool') return 'tool';
  return null;
}

function message(role: ArchivedMessage['role'], text: string, sourceId: string | null): ArchivedMessage {
  return {
    sourceId,
    role,
    blocks: [{ type: 'text', text }],
    createdAt: null,
    model: null,
    parentId: null,
    branchId: null,
  };
}

function chatGptPartText(content: { parts?: unknown; text?: unknown } | undefined): string {
  if (!content) {
    return '';
  }
  if (typeof content.text === 'string' && content.text.trim()) {
    return content.text.trim();
  }
  if (!Array.isArray(content.parts)) {
    return '';
  }
  return content.parts
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim();
}

function retainedText(messages: ArchivedMessage[]): string {
  return messages.map((item) => item.blocks.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'artifact') return `${block.name}\n${block.content}`;
    if (block.type === 'image' || block.type === 'file' || block.type === 'attachment') return block.name;
    return '';
  }).filter(Boolean).join('\n')).join('\n');
}

function dedupeReferences(blocks: ContentBlock[]): ContentBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    if ((block.type !== 'image' && block.type !== 'file' && block.type !== 'attachment') || !block.sourceRef) return true;
    if (seen.has(block.sourceRef)) return false;
    seen.add(block.sourceRef);
    return true;
  });
}

interface ChatGptNode {
  parent?: unknown;
  message?: {
    id?: unknown;
    author?: { role?: string };
    content?: { parts?: unknown; text?: unknown };
    create_time?: unknown;
    metadata?: { is_visually_hidden_from_conversation?: boolean; model_slug?: unknown };
  };
}

function orderedChatGptNodes(mapping: Record<string, ChatGptNode>, currentNode: unknown): ChatGptNode[] {
  const start = typeof currentNode === 'string' ? currentNode : null;
  const linked = Object.values(mapping).some((node) => typeof node.parent === 'string');
  if (!start && !linked) {
    return Object.values(mapping);
  }
  const parents = new Set(
    Object.values(mapping)
      .map((node) => node.parent)
      .filter((parent): parent is string => typeof parent === 'string'),
  );
  const leaves = Object.keys(mapping).filter((id) => !parents.has(id));
  const root = start && mapping[start] ? start : leaves[leaves.length - 1];
  const chain: ChatGptNode[] = [];
  const seen = new Set<string>();
  let cursor = root;
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    const node = mapping[cursor];
    if (!node) {
      break;
    }
    chain.push(node);
    cursor = typeof node.parent === 'string' ? node.parent : undefined;
  }
  return chain.reverse();
}

export function conversationFromChatGpt(json: unknown, pageUrl: string): ArchivedConversation | null {
  if (!json || typeof json !== 'object') {
    return null;
  }
  const wrapped = json as { conversation?: unknown };
  const record = (
    wrapped.conversation && typeof wrapped.conversation === 'object' ? wrapped.conversation : json
  ) as {
    id?: unknown;
    conversation_id?: unknown;
    title?: unknown;
    mapping?: Record<string, ChatGptNode>;
    current_node?: unknown;
    linear_conversation?: ChatGptNode[];
    create_time?: unknown;
    update_time?: unknown;
  };
  const id = typeof record.id === 'string' ? record.id : typeof record.conversation_id === 'string' ? record.conversation_id : '';
  if (!id) {
    return null;
  }
  const nodes = Array.isArray(record.linear_conversation)
    ? record.linear_conversation
    : orderedChatGptNodes(record.mapping ?? {}, record.current_node);
  const messages: ArchivedMessage[] = [];
  for (const node of nodes) {
    if (node.message?.metadata?.is_visually_hidden_from_conversation) {
      continue;
    }
    const role = roleOf(node.message?.author?.role ?? '');
    const text = stripUnsupportedBlocks(chatGptPartText(node.message?.content));
    const images = mediaBlocks(node.message?.content?.parts, 'chatgpt', role ?? 'user');
    const missing = unsupportedContent(node.message?.content?.parts, 'chatgpt', role ?? 'user');
    if (!role || role === 'system' || role === 'tool' || (!text && images.length === 0 && missing.length === 0)) {
      continue;
    }
    const entry = message(role, text, typeof node.message?.id === 'string' ? node.message.id : null);
    entry.blocks = dedupeReferences([...(text ? entry.blocks : []), ...images, ...missing]);
    entry.createdAt = providerDate(node.message?.create_time);
    entry.parentId = typeof node.parent === 'string' ? node.parent : null;
    entry.branchId = typeof record.current_node === 'string' ? record.current_node : null;
    entry.model = typeof node.message?.metadata?.model_slug === 'string' ? node.message.metadata.model_slug : null;
    messages.push(entry);
  }
  if (messages.length === 0) {
    return null;
  }
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : 'Untitled';
  const now = new Date().toISOString();
  const text = retainedText(messages);
  return {
    key: conversationKey('chatgpt', 'default', id),
    provider: 'chatgpt',
    accountScope: 'default',
    sourceId: id,
    sourceUrl: pageUrl.startsWith('https://chatgpt.com/c/') ? pageUrl : `https://chatgpt.com/c/${id}`,
    title: title.slice(0, 80),
    createdAt: providerDate(record.create_time),
    updatedAt: providerDate(record.update_time),
    capturedAt: now,
    messages,
    warnings: messages.flatMap((entry) => entry.blocks.flatMap((block, blockIndex) => block.type === 'unsupported' ? [{ code: block.code, description: block.description, messageId: entry.sourceId, blockIndex }] : [])),
    completeness: messages.some((entry) => entry.blocks.some((block) => block.type === 'unsupported')) ? 'partial' : 'unknown',
    revision: 1,
    contentHash: stableHash(text || title),
    projectName: null,
    projectSlug: null,
  };
}

export function conversationFromClaude(json: unknown, pageUrl: string): ArchivedConversation | null {
  if (!json || typeof json !== 'object') {
    return null;
  }
  const record = json as {
    uuid?: unknown;
    name?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    current_leaf_message_uuid?: unknown;
    chat_messages?: { sender?: string; text?: string; content?: unknown; attachments?: unknown; files?: unknown; uuid?: string; created_at?: unknown; parent_message_uuid?: unknown; model?: unknown }[];
  };
  if (typeof record.uuid !== 'string' || !Array.isArray(record.chat_messages)) {
    return null;
  }
  const messages: ArchivedMessage[] = [];
  const artifactSnapshots = new Map<string, ArtifactSnapshot>();
  let selected = record.chat_messages;
  if (typeof record.current_leaf_message_uuid === 'string') {
    const byId = new Map(record.chat_messages.map((item) => [item.uuid, item]));
    const chain: typeof selected = [];
    const seen = new Set<string>();
    let cursor: string | null = record.current_leaf_message_uuid;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor); const item = byId.get(cursor); if (!item) break;
      chain.push(item); cursor = typeof item.parent_message_uuid === 'string' ? item.parent_message_uuid : null;
    }
    if (chain.length) selected = chain.reverse();
  }
  for (const item of selected) {
    const role = roleOf(item.sender ?? '');
    const raw =
      typeof item.text === 'string' && item.text.trim()
        ? item.text.trim()
        : Array.isArray(item.content)
          ? item.content
              .map((block) =>
                block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
                  ? block.text
                  : '',
              )
              .filter((part) => part.trim().length > 0)
              .join('\n')
              .trim()
          : '';
    const text = stripUnsupportedBlocks(raw);
    const media = mediaBlocks(item.content, 'claude', role ?? 'user');
    const artifacts = artifactBlocks(item.content, artifactSnapshots);
    const attachments = [...attachmentBlocks(item.attachments, 'claude', role ?? 'user'), ...attachmentBlocks(item.files, 'claude', role ?? 'user')];
    const missing = unsupportedContent(item.content, 'claude', role ?? 'user', artifacts.recognized);
    if (!role || (!text && media.length === 0 && artifacts.blocks.length === 0 && attachments.length === 0 && missing.length === 0)) {
      continue;
    }
    const entry = message(role, text, typeof item.uuid === 'string' ? item.uuid : null);
    entry.blocks = dedupeReferences([...(text ? entry.blocks : []), ...media, ...attachments, ...artifacts.blocks, ...missing]);
    entry.createdAt = providerDate(item.created_at);
    entry.parentId = typeof item.parent_message_uuid === 'string' ? item.parent_message_uuid : null;
    entry.branchId = typeof record.current_leaf_message_uuid === 'string' ? record.current_leaf_message_uuid : null;
    entry.model = typeof item.model === 'string' ? item.model : null;
    messages.push(entry);
  }
  if (messages.length === 0) {
    return null;
  }
  const title = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Untitled';
  const now = new Date().toISOString();
  const text = retainedText(messages);
  return {
    key: conversationKey('claude', 'default', record.uuid),
    provider: 'claude',
    accountScope: 'default',
    sourceId: record.uuid,
    sourceUrl: pageUrl,
    title: title.slice(0, 80),
    createdAt: providerDate(record.created_at),
    updatedAt: providerDate(record.updated_at),
    capturedAt: now,
    messages,
    warnings: messages.flatMap((entry) => entry.blocks.flatMap((block, blockIndex) => block.type === 'unsupported' ? [{ code: block.code, description: block.description, messageId: entry.sourceId, blockIndex }] : [])),
    completeness: messages.some((entry) => entry.blocks.some((block) => block.type === 'unsupported')) ? 'partial' : 'unknown',
    revision: 1,
    contentHash: stableHash(text || title),
    projectName: null,
    projectSlug: null,
  };
}
