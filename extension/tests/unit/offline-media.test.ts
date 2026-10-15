import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConversation } from '../fixtures/factories.ts';
import { renderConversationMarkdown } from '../../destinations/markdown/render.ts';
import { writeSideFiles } from '../../destinations/markdown/side-files.ts';
import { renderNotionBlocks } from '../../destinations/notion/render.ts';
import { settingsSchema } from '../../core/settings.ts';
import { conversationFromClaude } from '../../providers/shared/normalize.ts';

class MemoryDirectory {
  directories = new Map<string, MemoryDirectory>();
  files = new Map<string, Uint8Array>();
  async queryPermission() { return 'granted' as const; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.directories.has(name)) {
      if (!options?.create) throw new DOMException('Missing directory', 'NotFoundError');
      this.directories.set(name, new MemoryDirectory());
    }
    return this.directories.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
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

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const pngBytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
const html = '<!doctype html><html><body><h1>Offline artifact</h1></body></html>';
let root: MemoryDirectory;

function artifactFiles() {
  return Array.from(root.directories.get('claude')?.directories.get('artifacts')?.directories.values() ?? []).flatMap((directory) => [...directory.files.keys()]);
}
function fileDirectory(provider = 'claude') {
  const files = root.directories.get(provider)?.directories.get('files');
  return files?.directories.values().next().value as MemoryDirectory | undefined;
}
function claudeConversation() {
  return conversationFromClaude({ uuid: 'offline-demo', chat_messages: [
    { uuid: 'human', sender: 'human', text: 'Please save this image', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } }] },
    { uuid: 'assistant', sender: 'assistant', content: [{ type: 'artifact', id: 'page-1', title: 'Demo page', content: html, mime_type: 'text/html' }] },
  ] }, 'https://claude.ai/chat/offline-demo')!;
}

beforeEach(() => { root = new MemoryDirectory(); folder.root = root; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('offline media side files', () => {
  it('writes exact inline PNG bytes and full artifact source with relative links, and is stable on repeat saves', async () => {
    const conversation = claudeConversation();
    const saved = await writeSideFiles(conversation, settingsSchema.parse({}));
    const image = saved.messages[0]!.blocks.find((block) => block.type === 'image');
    const artifact = saved.messages[1]!.blocks.find((block) => block.type === 'artifact');
    expect(image?.type).toBe('image');
    expect(artifact?.type).toBe('artifact');
    if (image?.type !== 'image' || artifact?.type !== 'artifact') throw new Error('Expected saved image and artifact blocks');
    expect(image.savedPath).toMatch(/^claude\/files\/[^/]+\/[^/]+\.png$/);
    expect(artifact.savedPath).toMatch(/^claude\/artifacts\/[^/]+\/[^/]+\.html$/);
    const imageDir = fileDirectory()!;
    const imageName = image.savedPath!.split('/').at(-1)!;
    expect([...imageDir.files.get(imageName)!]).toEqual([...pngBytes]);
    const artifactDir = root.directories.get('claude')!.directories.get('artifacts')!.directories.values().next().value as MemoryDirectory;
    expect(artifactDir.read(artifact.savedPath!.split('/').at(-1)!)).toBe(html);
    const markdown = renderConversationMarkdown(saved, { saveCodeGallery: true, notePath: 'claude/projects/demo/note.md' });
    expect(markdown).toContain(`](../../files/${image.savedPath!.split('/').slice(2).join('/')})`);
    expect(markdown).toContain(`[Open saved artifact](../../artifacts/${artifact.savedPath!.split('/').slice(2).join('/')})`);

    const fileCount = imageDir.files.size;
    const artifactCount = artifactFiles().length;
    await writeSideFiles(conversation, settingsSchema.parse({}));
    expect(imageDir.files.size).toBe(fileCount);
    expect(artifactFiles()).toHaveLength(artifactCount);
  });

  it('keeps prior artifact source and edited side files when changed bytes are saved', async () => {
    const conversation = claudeConversation();
    const first = await writeSideFiles(conversation, settingsSchema.parse({}));
    const originalArtifact = first.messages[1]!.blocks.find((block) => block.type === 'artifact');
    if (originalArtifact?.type !== 'artifact') throw new Error('Expected artifact');
    const artifactDir = root.directories.get('claude')!.directories.get('artifacts')!.directories.values().next().value as MemoryDirectory;
    const originalArtifactName = originalArtifact.savedPath!.split('/').at(-1)!;
    const editedImageDir = fileDirectory()!;
    const image = first.messages[0]!.blocks.find((block) => block.type === 'image');
    if (image?.type !== 'image') throw new Error('Expected image');
    const imageName = image.savedPath!.split('/').at(-1)!;
    editedImageDir.edit(imageName, 'user image edit');

    const changed = structuredClone(conversation);
    const changedArtifact = changed.messages[1]!.blocks.find((block) => block.type === 'artifact');
    if (changedArtifact?.type !== 'artifact') throw new Error('Expected artifact');
    changedArtifact.content = `${html}\n<!-- updated -->`;
    const next = await writeSideFiles(changed, settingsSchema.parse({}));
    const nextImage = next.messages[0]!.blocks.find((block) => block.type === 'image');
    const nextArtifact = next.messages[1]!.blocks.find((block) => block.type === 'artifact');
    if (nextImage?.type !== 'image' || nextArtifact?.type !== 'artifact') throw new Error('Expected exported blocks');
    expect(editedImageDir.read(imageName)).toBe('user image edit');
    expect(nextImage.savedPath).not.toBe(image.savedPath);
    expect(editedImageDir.files.size).toBe(2);
    expect(artifactDir.read(originalArtifactName)).toBe(html);
    expect(nextArtifact.savedPath).not.toBe(originalArtifact.savedPath);
    expect(artifactFiles()).toHaveLength(2);
  });

  it('respects uploaded, created and artifact export settings without false missing-file warnings', async () => {
    const conversation = buildConversation({ provider: 'claude' });
    conversation.messages[0]!.blocks = [
      { type: 'image', name: 'upload.png', mediaType: 'image/png', sourceRef: `data:image/png;base64,${pngBase64}`, savedPath: null, origin: 'uploaded' },
      { type: 'image', name: 'created.png', mediaType: 'image/png', sourceRef: `data:image/png;base64,${pngBase64}`, savedPath: null, origin: 'created' },
      { type: 'artifact', sourceId: 'page-off', name: 'Disabled page', mediaType: 'text/html', language: 'html', content: html, savedPath: null },
    ];
    const next = await writeSideFiles(conversation, settingsSchema.parse({ saveUploadedFiles: false, saveCreatedFiles: true, saveCodeGallery: false }));
    const blocks = next.messages[0]!.blocks;
    expect(blocks[0]!.type === 'image' && blocks[0]!.savedPath).toBeNull();
    expect(blocks[1]!.type === 'image' && blocks[1]!.savedPath).toMatch(/\.png$/);
    expect(blocks[2]!.type === 'artifact' && blocks[2]!.savedPath).toBeNull();
    expect(next.warnings).toEqual([]);
    const markdown = renderConversationMarkdown(next, { saveUploadedFiles: false, saveCreatedFiles: true, saveCodeGallery: false, notePath: 'claude/projects/demo/note.md' });
    expect(markdown).toContain('upload.png');
    expect(markdown).toContain(html);
    expect(markdown).not.toContain('could not be saved');
    expect(artifactFiles()).toHaveLength(0);
  });

  it('authenticates only direct provider image URLs and records failed, HTML and oversized saves in the note', async () => {
    const calls: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, credentials: init?.credentials });
      if (url.endsWith('/good.png')) return new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } });
      if (url.endsWith('/challenge.png')) return new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
      return new Response('too big', { headers: { 'Content-Type': 'image/png', 'Content-Length': '8000001' } });
    }));
    const conversation = buildConversation({ provider: 'claude' });
    conversation.messages[0]!.blocks = [
      { type: 'image', name: 'good.png', mediaType: 'image/png', sourceRef: 'https://claude.ai/api/files/good.png', savedPath: null, origin: 'created' },
      { type: 'image', name: 'foreign.png', mediaType: 'image/png', sourceRef: 'https://images.example/foreign.png', savedPath: null, origin: 'created' },
      { type: 'image', name: 'other-provider.png', mediaType: 'image/png', sourceRef: 'https://chatgpt.com/files/other.png', savedPath: null, origin: 'created' },
      { type: 'image', name: 'challenge.png', mediaType: 'image/png', sourceRef: 'https://claude.ai/api/files/challenge.png', savedPath: null, origin: 'created' },
      { type: 'image', name: 'large.png', mediaType: 'image/png', sourceRef: 'https://claude.ai/api/files/large.png', savedPath: null, origin: 'created' },
    ];
    const next = await writeSideFiles(conversation, settingsSchema.parse({}));
    expect(calls.map((call) => call.url)).toEqual(['https://claude.ai/api/files/good.png', 'https://claude.ai/api/files/challenge.png', 'https://claude.ai/api/files/large.png']);
    expect(calls.every((call) => call.credentials === 'include')).toBe(true);
    expect(fileDirectory()!.files.size).toBe(1);
    const markdown = renderConversationMarkdown(next, { saveCreatedFiles: true });
    expect(markdown).toContain('foreign.png: This file source is not supported');
    expect(markdown).toContain('other-provider.png: This file source is not supported');
    expect(markdown).toContain('challenge.png: The provider returned a page instead of the file.');
    expect(markdown).toContain('large.png: File exceeds the 8 MB download limit.');
    expect(markdown).toContain('could not be saved');
  });

  it('renders artifact source as Notion code, including fence characters, without exposing inline image data', () => {
    const secretImageData = 'data:image/png;base64,secret-payload-must-not-leak';
    const conversation = buildConversation({ provider: 'claude' });
    conversation.messages[0]!.blocks = [
      { type: 'artifact', sourceId: 'fenced', name: 'Fence example', mediaType: 'text/html', language: 'html', content: '<pre>```html\nvalue\n```</pre>', savedPath: null },
      { type: 'image', name: 'private.png', mediaType: 'image/png', sourceRef: secretImageData, savedPath: null, origin: 'uploaded' },
    ];
    const rendered = renderNotionBlocks(conversation);
    const body = JSON.stringify(rendered);
    expect(rendered.some((block) => block.type === 'code' && JSON.stringify(block).includes('```html'))).toBe(true);
    expect(rendered.some((block) => block.type === 'paragraph' && JSON.stringify(block).includes('Fence example'))).toBe(true);
    expect(body).not.toContain(secretImageData);
    expect(body).not.toContain('secret-payload-must-not-leak');
  });
});
