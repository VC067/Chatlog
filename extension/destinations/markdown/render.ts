import type { ArchivedConversation, ArchivedMessage } from '../../core/contracts/conversation.ts';
import type { ContentBlock, CaptureWarning } from '../../core/contracts/content.ts';
import { stripUnsupportedBlocks } from '../../providers/shared/placeholders.ts';
import { markdownRelativePath, relativeNoteLink } from './paths.ts';

function yamlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function fenceFor(code: string): string {
  const matches = code.match(/`{3,}/g) ?? [];
  const longest = matches.reduce((max, fence) => Math.max(max, fence.length), 2);
  return '`'.repeat(longest + 1);
}

export interface NoteOptions {
  providerLabel?: string;
  includeSources?: boolean;
  saveCreatedFiles?: boolean;
  saveUploadedFiles?: boolean;
  saveCodeGallery?: boolean;
  folderDiskPath?: string;
  notePath?: string;
}

function renderBlock(block: ContentBlock, options: NoteOptions): string {
  if (block.type === 'text') {
    const cleaned = stripUnsupportedBlocks(block.text);
    return cleaned ? cleaned.replaceAll('<', '&lt;') : '';
  }
  if (block.type === 'code') {
    if (/not supported on your current device/i.test(block.code) && !stripUnsupportedBlocks(block.code)) return '';
    const fence = fenceFor(block.code);
    const language = block.language ?? '';
    return `${fence}${language}\n${block.code}\n${fence}`;
  }
  if (block.type === 'citation') {
    const title = block.title ?? block.url;
    return `> ${title}\n> ${block.url}`;
  }
  if (block.type === 'attachment') {
    const media = block.mediaType ? ` (${block.mediaType})` : '';
    if (options.saveUploadedFiles === false) {
      return `Attachment: ${block.name}${media}`;
    }
    const source = block.sourceRef && !block.sourceRef.startsWith('data:') ? `\n\nSource: ${block.sourceRef}` : '';
    return `Attachment: ${block.name}${media}${source}\n\n> The original attachment could not be copied. Open the conversation in ${options.providerLabel ?? 'the provider'} to access it.`;
  }
  if (block.type === 'table') {
    if (block.header.length === 0) {
      return '';
    }
    const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', '<br>');
    const header = `| ${block.header.map(cell).join(' | ')} |`;
    const rule = `| ${block.header.map(() => '---').join(' | ')} |`;
    const rows = block.rows.map((row) => `| ${row.map(cell).join(' | ')} |`);
    return [header, rule, ...rows].join('\n');
  }
  if (block.type === 'math') {
    return block.display ? `$$\n${block.tex}\n$$` : `$${block.tex}$`;
  }
  if (block.type === 'image') {
    const saveFiles = block.origin === 'uploaded' ? options.saveUploadedFiles : options.saveCreatedFiles;
    const link = block.savedPath && options.notePath ? relativeNoteLink(options.notePath, block.savedPath) : block.savedPath;
    if (link) {
      return `![${block.name.replaceAll('[', '\\[').replaceAll(']', '\\]')}](${link})`;
    }
    if (saveFiles === false) {
      return `Image: ${block.name}`;
    }
    return `> [!missing]\n> Image: ${block.name} could not be saved`;
  }
  if (block.type === 'artifact') {
    const fence = fenceFor(block.content);
    const language = block.language && /^[a-z0-9_+#.-]{1,40}$/i.test(block.language) ? block.language : '';
    const source = `${block.name}\n\n${fence}${language}\n${block.content}\n${fence}`;
    if (block.savedPath) {
      const link = options.notePath ? relativeNoteLink(options.notePath, block.savedPath) : block.savedPath;
      if (link) return `${source}\n\n[Open saved artifact](${link})`;
    }
    if (options.saveCodeGallery === true) return `${source}\n\n> [!missing]\n> Saved artifact backup could not be found.`;
    return source;
  }
  if (block.type === 'file') {
    const link = block.savedPath && options.notePath ? relativeNoteLink(options.notePath, block.savedPath) : block.savedPath;
    if (link) {
      return `[${block.name.replaceAll('[', '\\[').replaceAll(']', '\\]')}](${link})`;
    }
    if (options.saveCreatedFiles === false) {
      return `File: ${block.name}`;
    }
    return `> [!missing]\n> File: ${block.name} could not be saved`;
  }
  return `> [!WARNING]\n> ${block.description}`;
}

function renderWarning(warning: CaptureWarning): string {
  return `> [!WARNING]\n> ${warning.description}`;
}

function speaker(role: ArchivedMessage['role'], provider: ArchivedConversation['provider']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') {
    if (provider === 'claude') return 'Claude';
    if (provider === 'grok') return 'Grok';
    return 'ChatGPT';
  }
  if (role === 'system') return 'System';
  return 'Tool';
}

export function renderMessageMarkdown(message: ArchivedMessage, options: NoteOptions = {}): string {
  return message.blocks.map((block) => renderBlock(block, options)).filter((part) => part.trim().length > 0).join('\n\n');
}

export function renderConversationMarkdown(conversation: ArchivedConversation, options: NoteOptions = {}): string {
  options = { ...options, providerLabel: conversation.provider === 'claude' ? 'Claude' : conversation.provider === 'chatgpt' ? 'ChatGPT' : 'Grok', notePath: options.notePath ?? markdownRelativePath(conversation) };
  const lines = [
    '---',
    'type: conversation',
    `source: ${conversation.provider}`,
    `title: ${yamlString(conversation.title)}`,
    `aliases: [${yamlString(conversation.title)}]`,
    `tags: [capture/${conversation.provider}]`,
    `created: ${conversation.createdAt ?? ''}`,
    `updated: ${conversation.updatedAt ?? ''}`,
    `synced: ${conversation.capturedAt}`,
    `url: ${yamlString(conversation.sourceUrl)}`,
    `conversation_id: ${yamlString(conversation.sourceId)}`,
    `message_count: ${conversation.messages.length}`,
    'capture_version: 1',
    `content_hash: ${yamlString(conversation.contentHash.length === 64 ? `sha256:${conversation.contentHash}` : conversation.contentHash)}`,
  ];
  if (options.folderDiskPath?.trim()) {
    lines.push(`vault_path: ${yamlString(options.folderDiskPath.trim())}`);
  }
  lines.push('---', '');
  const sources: Array<{ title: string | null; url: string }> = [];
  for (const message of conversation.messages) {
    lines.push(`**${speaker(message.role, conversation.provider)}**`, '');
    for (const block of message.blocks) {
      if (block.type === 'citation') sources.push({ title: block.title, url: block.url });
      lines.push(renderBlock(block, options), '');
    }
  }
  if (options.includeSources && sources.length > 0) {
    lines.push('## Sources', '');
    for (const source of sources) {
      lines.push(`- ${source.title ?? source.url}: ${source.url}`);
    }
    lines.push('');
  }
  for (const warning of conversation.warnings) {
    lines.push(renderWarning(warning), '');
  }
  return lines.join('\n');
}
