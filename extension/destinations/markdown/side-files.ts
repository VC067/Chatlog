import type { ArchivedConversation } from '../../core/contracts/conversation.ts';
import type { Settings } from '../../core/settings.ts';
import { sha256Hex } from '../../core/archive/hash.ts';
import { readRootHandle } from './handle-store.ts';
import { readFolderAccess } from './permission.ts';
import { sanitizePathSegment } from './paths.ts';

const MAX_BYTES = 8_000_000;
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
function safeName(value: string): string {
  const extension = value.match(/\.([a-z0-9]{1,12})$/i)?.[0] ?? '';
  const base = extension ? value.slice(0, -extension.length) : value;
  return `${sanitizePathSegment(base).replaceAll(' ', '-')}${extension}`;
}
async function bytesHash(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function boundedBytes(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new Error('File exceeds the 8 MB download limit.');
  if (!response.body) throw new Error('File response has no readable body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error('File exceeds the 8 MB download limit.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (!length) throw new Error('File response was empty.');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function writePreservingBytes(root: FileSystemDirectoryHandle, folder: string, fileName: string, bytes: Uint8Array): Promise<string> {
  let directory = root;
  for (const segment of folder.split('/')) directory = await directory.getDirectoryHandle(segment, { create: true });
  const hash = await bytesHash(bytes);
  const extension = fileName.match(/\.[a-z0-9]{1,12}$/i)?.[0] ?? '';
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  let candidate = `${stem}-${hash.slice(0, 16)}${extension}`;
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    try {
      const existing = await directory.getFileHandle(candidate);
      const current = new Uint8Array(await (await existing.getFile()).arrayBuffer());
      if (await bytesHash(current) === hash) return `${folder}/${candidate}`;
      candidate = `${stem}-${hash.slice(0, 16)}-${suffix + 1}${extension}`;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
      const handle = await directory.getFileHandle(candidate, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Blob([new Uint8Array(bytes).buffer]));
      await writable.close();
      return `${folder}/${candidate}`;
    }
  }
  throw new Error('No free side-file name was found. Existing files were preserved.');
}
function extensionFor(language: string | null): string {
  const extensions: Record<string, string> = { html: 'html', svg: 'svg', css: 'css', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', json: 'json', py: 'py', python: 'py' };
  return extensions[language ?? ''] ?? 'txt';
}
function inlineImage(ref: string): { bytes: Uint8Array; mediaType: string } {
  if (ref.length > Math.ceil(MAX_BYTES / 3) * 4 + 100) throw new Error('File exceeds the 8 MB download limit.');
  const match = ref.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || !IMAGE_EXTENSIONS[match[1]!.toLowerCase()]) throw new Error('Inline image format is not supported.');
  const decoded = atob(match[2]!);
  if (!decoded.length) throw new Error('File response was empty.');
  if (decoded.length > MAX_BYTES) throw new Error('File exceeds the 8 MB download limit.');
  return { bytes: Uint8Array.from(decoded, (char) => char.charCodeAt(0)), mediaType: match[1]!.toLowerCase() };
}
function mediaFileName(name: string, mediaType: string | null): string {
  const extension = mediaType ? IMAGE_EXTENSIONS[mediaType] : undefined;
  const safe = safeName(name);
  return extension ? `${safe.replace(/\.[a-z0-9]{1,12}$/i, '')}.${extension}` : safe;
}
function artifactExtension(mediaType: string | null, language: string | null): string {
  if (mediaType === 'text/html') return 'html';
  if (mediaType === 'image/svg+xml') return 'svg';
  if (mediaType === 'text/markdown') return 'md';
  return extensionFor(language);
}
export async function writeSideFiles(conversation: ArchivedConversation, settings: Settings): Promise<ArchivedConversation> {
  const root = await readRootHandle();
  if (!root || await readFolderAccess(root) !== 'granted') return conversation;
  const next = structuredClone(conversation);
  const identity = (await sha256Hex(conversation.key)).slice(0, 24);
  for (const message of next.messages) {
    for (let index = 0; index < message.blocks.length; index += 1) {
      const block = message.blocks[index]!;
      if (block.type === 'artifact') {
        if (!settings.saveCodeGallery || conversation.provider !== 'claude') continue;
        try {
          const bytes = new TextEncoder().encode(block.content);
          if (bytes.length > MAX_BYTES) throw new Error('Artifact exceeds the 8 MB file limit.');
          const artifactId = (await sha256Hex(block.sourceId)).slice(0, 12);
          const extension = artifactExtension(block.mediaType, block.language);
          const name = `${sanitizePathSegment(block.name).replaceAll(' ', '-')}-${artifactId}.${extension}`;
          block.savedPath = await writePreservingBytes(root, `claude/artifacts/${identity}`, name, bytes);
        } catch {
          block.savedPath = null;
          next.warnings.push({ code: 'artifact_unavailable', description: 'The artifact side file could not be saved; its full source remains in the note.', messageId: message.sourceId, blockIndex: index });
        }
        continue;
      }
      const uploaded = block.type === 'attachment' || block.type === 'image' && block.origin === 'uploaded';
      const created = block.type === 'image' || block.type === 'file';
      if ((!created && !uploaded) || (uploaded ? !settings.saveUploadedFiles : !settings.saveCreatedFiles)) continue;
      const ref = block.sourceRef;
      let reason = 'No downloadable source was supplied.';
      if (ref) {
        try {
          let bytes: Uint8Array;
          let mediaType: string | null = 'mediaType' in block ? block.mediaType ?? null : null;
          if (ref.startsWith('data:') && block.type === 'image') {
            const decoded = inlineImage(ref);
            bytes = decoded.bytes; mediaType = decoded.mediaType;
          } else {
            const url = new URL(ref);
            if (url.protocol !== 'https:' || url.origin !== `https://${conversation.provider === 'chatgpt' ? 'chatgpt.com' : conversation.provider === 'claude' ? 'claude.ai' : 'grok.com'}` || url.username || url.password) {
              throw new Error('This file source is not supported for authenticated downloads.');
            }
            const response = await fetch(url, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(20_000) });
            if (!response.ok) throw new Error('File access was rejected or expired.');
            const responseType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
            if (responseType === 'text/html' || responseType === 'application/json') throw new Error('The provider returned a page instead of the file.');
            if (block.type === 'image' && !responseType.startsWith('image/') && responseType !== 'application/octet-stream') throw new Error('The provider did not return an image.');
            mediaType = responseType || mediaType;
            bytes = await boundedBytes(response);
          }
          const savedPath = await writePreservingBytes(root, `${conversation.provider}/files/${identity}`, mediaFileName(block.name, mediaType), bytes);
          if (block.type === 'attachment') {
            message.blocks[index] = { type: 'file', name: block.name, mediaType: block.mediaType, sourceRef: block.sourceRef, savedPath };
          } else block.savedPath = savedPath;
          continue;
        } catch (error) { reason = error instanceof Error && ['File exceeds the 8 MB download limit.', 'File access was rejected or expired.', 'File response was empty.', 'This file source is not supported for authenticated downloads.', 'The provider returned a page instead of the file.', 'The provider did not return an image.', 'Inline image format is not supported.'].includes(error.message) ? error.message : 'Download or folder write failed; existing side files were preserved.'; }
      }
      if (block.type === 'image' || block.type === 'file') block.savedPath = null;
      next.warnings.push({ code: 'file_unavailable', description: `${block.name}: ${reason}`, messageId: message.sourceId, blockIndex: index });
    }
  }
  if (settings.saveCodeGallery && conversation.provider === 'claude') {
    let index = 0;
    for (const message of conversation.messages) {
      for (const block of message.blocks) {
        if (block.type !== 'code' || block.code.trim().length < 40) continue;
        index += 1;
        try {
          await writePreservingBytes(root, `claude/artifacts/${identity}`, `${index}.${extensionFor(block.language)}`, new TextEncoder().encode(block.code));
        } catch {
          next.warnings.push({ code: 'code_export_unavailable', description: 'A code export side file could not be saved; its full code remains in the note.', messageId: message.sourceId, blockIndex: null });
        }
      }
    }
  }
  return next;
}
