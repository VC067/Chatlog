import type { ArchivedConversation } from '../../core/contracts/conversation.ts';
import type { ContentBlock } from '../../core/contracts/content.ts';
import { stripUnsupportedBlocks } from '../../providers/shared/placeholders.ts';

export type NotionBlock = { object: 'block'; type: string; [key: string]: unknown };
export function splitText(value: string, size = 1800): string[] {
  const characters = Array.from(value);
  const parts: string[] = [];
  let current = '';
  for (const character of characters) {
    if (current.length + character.length > size) { parts.push(current); current = ''; }
    current += character;
  }
  if (current) parts.push(current);
  return parts.length ? parts : [''];
}
export function richText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  return splitText(text).map((content) => ({ type: 'text', text: { content } }));
}
export function textBlock(type: string, text: string): NotionBlock[] {
  return splitText(text).map((content) => ({ object: 'block', type, [type]: { rich_text: richText(content) } }));
}
const CODE_LANGUAGES = new Set(['bash', 'c', 'c++', 'c#', 'css', 'go', 'html', 'java', 'javascript', 'json', 'kotlin', 'latex', 'lua', 'markdown', 'mermaid', 'php', 'python', 'r', 'ruby', 'rust', 'sass', 'scala', 'shell', 'sql', 'swift', 'typescript', 'xml', 'yaml']);
function codeBlocks(code: string, language: string | null): NotionBlock[] {
  const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', md: 'markdown', yml: 'yaml' };
  const normalized = aliases[language ?? ''] ?? language ?? 'plain text';
  const supported = CODE_LANGUAGES.has(normalized) ? normalized : 'plain text';
  return splitText(code).map((part) => ({ object: 'block', type: 'code', code: { rich_text: richText(part), language: supported } }));
}
function renderBlock(block: ContentBlock): NotionBlock[] {
  if (block.type === 'text') {
    const cleaned = stripUnsupportedBlocks(block.text);
    return cleaned ? textBlock('paragraph', cleaned) : [];
  }
  if (block.type === 'code') {
    if (/not supported on your current device/i.test(block.code) && !stripUnsupportedBlocks(block.code)) return [];
    return codeBlocks(block.code, block.language);
  }
  if (block.type === 'artifact') {
    return [...textBlock('paragraph', block.name), ...codeBlocks(block.content, block.language)];
  }
  if (block.type === 'citation') return textBlock('quote', `${block.title ?? 'Source'}\n${block.url}`);
  if (block.type === 'math') {
    return block.tex.length <= 1000 ? [{ object: 'block', type: 'equation', equation: { expression: block.tex } }]
      : [...textBlock('quote', 'Equation exceeds Notion’s equation limit; full LaTeX follows.'), ...codeBlocks(block.tex, 'latex')];
  }
  if (block.type === 'table') {
    const escape = (cell: string) => cell.replaceAll('|', '\\|').replaceAll('\n', '<br>');
    const table = [block.header, block.header.map(() => '---'), ...block.rows].map((row) => `| ${row.map(escape).join(' | ')} |`).join('\n');
    return [...textBlock('paragraph', 'Table (Markdown representation)'), ...codeBlocks(table, 'markdown')];
  }
  if (block.type === 'unsupported') return textBlock('quote', `Unsupported content: ${block.description}`);
  const sourceRef = block.sourceRef?.startsWith('data:') ? 'Inline image source' : block.sourceRef;
  return textBlock('quote', `${block.type === 'attachment' ? 'Attachment' : block.type === 'image' ? 'Image' : 'File'}: ${block.name}\nBinary file is not uploaded to Notion. ${sourceRef ? `Original reference: ${sourceRef}` : 'Original reference unavailable.'}`);
}
export function renderNotionBlocks(conversation: ArchivedConversation): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  for (const message of conversation.messages) {
    blocks.push(...textBlock('heading_2', message.role === 'user' ? 'You' : message.role === 'assistant' ? conversation.provider : message.role));
    for (const block of message.blocks) blocks.push(...renderBlock(block));
  }
  for (const warning of conversation.warnings) blocks.push(...textBlock('quote', `Capture warning: ${warning.description}`));
  return blocks;
}
export function batchNotionBlocks(blocks: NotionBlock[]): NotionBlock[][] {
  const batches: NotionBlock[][] = [];
  let current: NotionBlock[] = [];
  let bytes = 0;
  for (const block of blocks) {
    const length = new TextEncoder().encode(JSON.stringify(block)).length;
    if (length > 400_000) throw new Error('A Notion block exceeds the request size limit.');
    if (current.length >= 80 || bytes + length > 400_000) { batches.push(current); current = []; bytes = 0; }
    current.push(block); bytes += length;
  }
  if (current.length) batches.push(current);
  return batches;
}
