import { readDelivery, saveDelivery } from '../../core/archive/repository.ts';
import { readSettings } from '../../core/settings.ts';
import { readRootHandle } from './handle-store.ts';
import { readFolderAccess } from './permission.ts';
import { markdownRelativePath } from './paths.ts';
import { sha256Hex, stableHash } from '../../core/archive/hash.ts';
import type { ArchivedConversation } from '../../core/contracts/conversation.ts';
import { openVaultDb } from '../../core/storage/db.ts';

export type MarkdownWriteStatus = 'written' | 'skipped' | 'blocked' | 'kept-edits';

function storedMarkdownPath(value: string | null | undefined): string | null {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes(':')) {
    return null;
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  const provider = parts[0];
  const fileName = parts.at(-1);
  if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'grok') {
    return null;
  }
  if (!fileName?.endsWith('.md') || parts.length < 2) {
    return null;
  }
  return value;
}

async function readText(handle: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const fileHandle = await handle.getFileHandle(name);
    return await (await fileHandle.getFile()).text();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw new Error('The existing note could not be read. It was not overwritten.');
  }
}

async function writeText(
  handle: FileSystemDirectoryHandle,
  name: string,
  text: string,
): Promise<void> {
  const fileHandle = await handle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function firstFreeName(directory: FileSystemDirectoryHandle, fileName: string): Promise<string> {
  const stem = fileName.replace(/\.md$/, '');
  let candidate = fileName;
  for (let index = 2; index < 10_000; index += 1) {
    try {
      await directory.getFileHandle(candidate);
      candidate = `${stem}-${index}.md`;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return candidate;
      throw error;
    }
  }
  throw new Error('No available note filename was found. Existing files were preserved.');
}

export async function resolveMarkdownNotePath(conversation: ArchivedConversation, options?: { projects?: boolean }): Promise<string> {
  const mapping = await readDelivery(conversation.key, 'markdown');
  return storedMarkdownPath(mapping?.externalId) ?? markdownRelativePath(conversation, options);
}

export async function deliverMarkdown(
  conversation: ArchivedConversation,
  markdown: string,
  options?: { replaceEdits?: boolean },
): Promise<MarkdownWriteStatus> {
  const root = await readRootHandle();
  const access = await readFolderAccess(root);
  if (!root || access !== 'granted') {
    return 'blocked';
  }
  const settings = await readSettings();
  const mapping = await readDelivery(conversation.key, 'markdown');
  const remembered = storedMarkdownPath(mapping?.externalId);
  const parts = (remembered ?? markdownRelativePath(conversation, { projects: settings.saveClaudeProjects })).split('/');
  let fileName = parts.pop();
  if (!fileName || parts.length === 0) {
    return 'blocked';
  }
  let directory = root;
  for (const segment of parts) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
  if (!remembered) {
    fileName = await firstFreeName(directory, fileName);
  }
  const relative = `${parts.join('/')}/${fileName}`;
  if (!remembered) {
    // Persist the selected path before the filesystem commit so a restart resumes the same note.
    await saveDelivery({ id: `${conversation.key}\nmarkdown`, conversationKey: conversation.key, destinationId: 'markdown', revision: 0, externalId: relative, contentHash: '' });
  }
  const current = await readText(directory, fileName);
  const nextHash = await sha256Hex(markdown);
  const currentHash = current === null ? null : await sha256Hex(current);
  const legacyMatch =
    current !== null &&
    mapping?.contentHash != null &&
    mapping.contentHash.length < 64 &&
    stableHash(current) === mapping.contentHash;
  const decision =
    current === null
      ? 'write'
      : currentHash === nextHash
        ? 'skip'
        : currentHash === mapping?.contentHash || legacyMatch
          ? 'write'
          : options?.replaceEdits
          ? 'write'
          : 'keep-edits';
  if (decision === 'skip') {
    await saveDelivery({ id: `${conversation.key}\nmarkdown`, conversationKey: conversation.key, destinationId: 'markdown', revision: conversation.revision, externalId: relative, contentHash: nextHash });
    return 'skipped';
  }
  if (decision === 'keep-edits') {
    const database = await openVaultDb();
    let previous: { path?: string; hash?: string; revision?: number } | null = null;
    try {
      const record = await database.get('metadata', `markdown-incoming:${conversation.key}`);
      if (record) { try { previous = JSON.parse(record.value) as { path?: string; hash?: string; revision?: number }; } catch { /* Ignore an invalid old checkpoint. */ } }
    } finally { database.close(); }
    if (previous?.hash === nextHash && previous.revision === conversation.revision && storedMarkdownPath(previous.path) && previous.path!.split('/').slice(0, -1).join('/') === parts.join('/')) {
      const previousText = await readText(directory, previous.path!.split('/').at(-1)!);
      if (previousText !== null && await sha256Hex(previousText) === nextHash) return 'kept-edits';
    }
  }
  const targetName = decision === 'keep-edits'
    ? await firstFreeName(directory, fileName.replace(/\.md$/, `.incoming-${conversation.revision}-${nextHash.slice(0, 12)}.md`))
    : fileName;
  await writeText(directory, targetName, markdown);
  if (decision === 'keep-edits') {
    const database = await openVaultDb();
    try {
      await database.put('metadata', { key: `markdown-incoming:${conversation.key}`, value: JSON.stringify({ path: `${parts.join('/')}/${targetName}`, hash: nextHash, revision: conversation.revision }) });
    } finally { database.close(); }
  }
  if (decision === 'write') {
    await saveDelivery({
      id: `${conversation.key}\nmarkdown`,
      conversationKey: conversation.key,
      destinationId: 'markdown',
      revision: conversation.revision,
      externalId: relative,
      contentHash: nextHash,
    });
  }
  return decision === 'keep-edits' ? 'kept-edits' : 'written';
}

export async function acceptIncomingMarkdown(conversation: ArchivedConversation): Promise<MarkdownWriteStatus> {
  const database = await openVaultDb();
  let incoming: { path: string; hash: string; revision: number };
  try {
    const record = await database.get('metadata', `markdown-incoming:${conversation.key}`);
    if (!record) return 'blocked';
    incoming = JSON.parse(record.value) as typeof incoming;
  } finally { database.close(); }
  if (!storedMarkdownPath(incoming.path) || incoming.revision !== conversation.revision) return 'blocked';
  const root = await readRootHandle();
  if (!root || await readFolderAccess(root) !== 'granted') return 'blocked';
  const parts = incoming.path.split('/');
  const name = parts.pop()!;
  let directory = root;
  for (const segment of parts) directory = await directory.getDirectoryHandle(segment);
  const text = await readText(directory, name);
  if (text === null || await sha256Hex(text) !== incoming.hash) return 'kept-edits';
  await saveDelivery({ id: `${conversation.key}\nmarkdown`, conversationKey: conversation.key, destinationId: 'markdown', revision: incoming.revision, externalId: incoming.path, contentHash: incoming.hash });
  return 'written';
}
