import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import { buildConversation } from '../fixtures/factories.ts';
import { deliverMarkdown, acceptIncomingMarkdown, resolveMarkdownNotePath } from '../../destinations/markdown/deliver.ts';
import { renderConversationMarkdown } from '../../destinations/markdown/render.ts';
import { relativeNoteLink, sanitizePathSegment } from '../../destinations/markdown/paths.ts';
import { writeSideFiles } from '../../destinations/markdown/side-files.ts';
import { settingsSchema } from '../../core/settings.ts';
import { readDelivery } from '../../core/archive/repository.ts';

class MemoryDirectory {
  directories = new Map<string, MemoryDirectory>();
  files = new Map<string, Uint8Array>();
  unreadable = new Set<string>();
  async queryPermission() { return 'granted' as const; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.directories.has(name)) {
      if (!options?.create) throw new DOMException('Missing directory', 'NotFoundError');
      this.directories.set(name, new MemoryDirectory());
    }
    return this.directories.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (this.unreadable.has(name)) throw new DOMException('Read denied', 'NotAllowedError');
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('Missing file', 'NotFoundError');
      this.files.set(name, new Uint8Array());
    }
    return {
      getFile: async () => new Blob([new Uint8Array(this.files.get(name)!).buffer]),
      createWritable: async () => {
        let pending = this.files.get(name)!;
        return {
          write: async (value: string | Blob) => { pending = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer()); },
          close: async () => { this.files.set(name, pending); },
        };
      },
    };
  }
  read(name: string) { return new TextDecoder().decode(this.files.get(name)); }
  edit(name: string, text: string) { this.files.set(name, new TextEncoder().encode(text)); }
}
const folder = vi.hoisted(() => ({ root: null as unknown }));
vi.mock('../../destinations/markdown/handle-store.ts', () => ({ readRootHandle: async () => folder.root }));
let root: MemoryDirectory;
beforeEach(async () => {
  await deleteDB('vaultdraft');
  root = new MemoryDirectory(); folder.root = root;
  vi.stubGlobal('browser', { storage: { local: { get: async () => ({}) } } });
});
afterEach(() => vi.unstubAllGlobals());

it('keeps the original note, edited incoming copies, and stable paths across title changes', async () => {
  const conversation = buildConversation();
  expect(await deliverMarkdown(conversation, 'first')).toBe('written');
  const path = await resolveMarkdownNotePath(conversation);
  const directory = root.directories.get('chatgpt')!;
  const name = path.split('/').at(-1)!;
  directory.edit(name, 'user note');
  expect(await deliverMarkdown({ ...conversation, revision: 2, title: 'New title' }, 'new transcript')).toBe('kept-edits');
  const copy = [...directory.files.keys()].find((key) => key.includes('.incoming-'))!;
  expect(await deliverMarkdown({ ...conversation, revision: 2 }, 'new transcript')).toBe('kept-edits');
  expect(directory.files.size).toBe(2);
  directory.edit(copy, 'user incoming edits');
  expect(await deliverMarkdown({ ...conversation, revision: 2 }, 'new transcript')).toBe('kept-edits');
  expect(directory.read(copy)).toBe('user incoming edits');
  expect(directory.read(name)).toBe('user note');
  expect(await acceptIncomingMarkdown({ ...conversation, revision: 2 })).toBe('written');
  expect((await readDelivery(conversation.key, 'markdown'))!.externalId).not.toBe(path);
});
it('does not overwrite an unreadable existing mapped note', async () => {
  const conversation = buildConversation();
  await deliverMarkdown(conversation, 'first');
  const path = await resolveMarkdownNotePath(conversation);
  const directory = root.directories.get('chatgpt')!;
  const name = path.split('/').at(-1)!;
  directory.unreadable.add(name);
  await expect(deliverMarkdown({ ...conversation, revision: 2 }, 'replacement')).rejects.toThrow('not overwritten');
  expect(directory.read(name)).toBe('first');
});
it('keeps duplicate titles separate and handles reserved names and project-relative links', async () => {
  await deliverMarkdown(buildConversation(), 'one');
  await deliverMarkdown(buildConversation({ sourceId: 'other-conversation' }), 'two');
  expect(root.directories.get('chatgpt')!.files.size).toBe(2);
  expect(sanitizePathSegment('CON.txt')).toBe('conversation');
  expect(relativeNoteLink('claude/projects/work/note.md', 'claude/files/id/a b.png')).toBe('../../files/id/a%20b.png');
  const conversation = buildConversation({ provider: 'claude', projectSlug: 'work' });
  conversation.messages[0]!.blocks = [{ type: 'image', name: 'Image', sourceRef: null, savedPath: 'claude/files/id/a b.png' }];
  expect(renderConversationMarkdown(conversation)).toContain('](../../files/id/a%20b.png)');
  expect(relativeNoteLink('chatgpt/note.md', '../outside')).toBeNull();
});
it('downloads uploaded attachments into collision-safe side files and preserves user changes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('file bytes', { status: 200 })));
  const conversation = buildConversation();
  conversation.messages[0]!.blocks = [{ type: 'attachment', name: 'upload.txt', mediaType: 'text/plain', sourceRef: 'https://chatgpt.com/file/1' }];
  const first = await writeSideFiles(conversation, settingsSchema.parse({}));
  const block = first.messages[0]!.blocks[0]!;
  expect(block.type).toBe('file');
  if (block.type !== 'file') throw new Error('Expected local attachment');
  const folderName = block.savedPath!.split('/')[2]!;
  const directory = root.directories.get('chatgpt')!.directories.get('files')!.directories.get(folderName)!;
  const name = block.savedPath!.split('/').at(-1)!;
  directory.edit(name, 'user attachment edits');
  const second = await writeSideFiles(conversation, settingsSchema.parse({}));
  expect(directory.read(name)).toBe('user attachment edits');
  expect(second.messages[0]!.blocks[0]).not.toEqual(block);
  expect(directory.files.size).toBe(2);
});
it('honestly marks unsupported file hosts and refuses oversized downloads', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('large', { headers: { 'Content-Length': '9000000' } })));
  const conversation = buildConversation();
  conversation.messages[0]!.blocks = [
    { type: 'file', name: 'large.txt', mediaType: null, sourceRef: 'https://chatgpt.com/file/1', savedPath: null },
    { type: 'file', name: 'external.txt', mediaType: null, sourceRef: 'https://unsupported.example/file', savedPath: null },
  ];
  const next = await writeSideFiles(conversation, settingsSchema.parse({}));
  expect(next.warnings.map((warning) => warning.description).join('\n')).toContain('8 MB');
  expect(next.warnings.map((warning) => warning.description).join('\n')).toContain('not supported');
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  expect(renderConversationMarkdown(next)).toContain('could not be saved');
});
