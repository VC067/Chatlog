import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConversation } from '../fixtures/factories.ts';
import { enrichVisibleClaudeImages } from '../../providers/claude/visible-images.ts';
import type { ArchivedMessage } from '../../core/contracts/conversation.ts';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  executeScript: vi.fn(),
}));

const imageData = 'data:image/png;base64,aGVsbG8=';

function visibleResult(
  counts: { user: number; assistant: number },
  output: Array<{ role: 'user' | 'assistant'; ordinal: number; images: Array<{ name: string; data: string }> }>,
) {
  return { result: { counts, output } };
}

function conversation(messages: ArchivedMessage[] = [
  { sourceId: 'u1', role: 'user' as const, blocks: [{ type: 'text' as const, text: 'hello' }], createdAt: null, model: null, parentId: null, branchId: null },
  { sourceId: 'a1', role: 'assistant' as const, blocks: [{ type: 'text' as const, text: 'hi' }], createdAt: null, model: null, parentId: null, branchId: null },
]) {
  return buildConversation({ provider: 'claude', sourceId: 'chat-1', messages });
}

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue([{ id: 7, url: 'https://claude.ai/chat/chat-1', status: 'complete', discarded: false, active: true }]);
  mocks.executeScript.mockReset().mockResolvedValue([visibleResult({ user: 1, assistant: 1 }, [])]);
  vi.stubGlobal('browser', { tabs: { query: mocks.query }, scripting: { executeScript: mocks.executeScript } });
});

describe('enrichVisibleClaudeImages', () => {
  it('queries only Claude and injects into the same conversation tab', async () => {
    await enrichVisibleClaudeImages(conversation());
    expect(mocks.query).toHaveBeenCalledWith({ url: 'https://claude.ai/*' });
    expect(mocks.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7 }, args: ['chat-1'] }));
  });

  it('ignores another provider and a different chat', async () => {
    const otherProvider = buildConversation();
    await enrichVisibleClaudeImages(otherProvider);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();

    mocks.query.mockResolvedValue([{ id: 8, url: 'https://claude.ai/chat/other-chat', status: 'complete', discarded: false }]);
    const claude = conversation();
    expect(await enrichVisibleClaudeImages(claude)).toBe(claude);
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('merges copied visible images by role and ordinal when visible turn counts match', async () => {
    mocks.executeScript.mockResolvedValue([visibleResult({ user: 1, assistant: 1 }, [
      { role: 'user', ordinal: 0, images: [{ name: 'upload.png', data: imageData }] },
      { role: 'assistant', ordinal: 0, images: [{ name: 'render.png', data: imageData }] },
    ])]);
    const original = conversation();
    const enriched = await enrichVisibleClaudeImages(original);
    expect(enriched).not.toBe(original);
    expect(enriched.messages[0]?.blocks).toContainEqual(expect.objectContaining({ type: 'image', name: 'upload.png', origin: 'uploaded', sourceRef: imageData }));
    expect(enriched.messages[1]?.blocks).toContainEqual(expect.objectContaining({ type: 'image', name: 'render.png', origin: 'created', sourceRef: imageData }));
    expect(original.messages[0]?.blocks).toHaveLength(1);
  });

  it('does not attach images when visible counts mismatch the API turns', async () => {
    mocks.executeScript.mockResolvedValue([visibleResult({ user: 2, assistant: 1 }, [
      { role: 'user', ordinal: 0, images: [{ name: 'wrong-turn.png', data: imageData }] },
    ])]);
    const original = conversation();
    const enriched = await enrichVisibleClaudeImages(original);
    expect(enriched.messages[0]?.blocks).toEqual(original.messages[0]?.blocks);
    expect(enriched.messages[1]?.blocks).toEqual(original.messages[1]?.blocks);
  });

  it('retains an existing usable API image reference', async () => {
    const original = conversation([
      { sourceId: 'u1', role: 'user', blocks: [
        { type: 'text', text: 'hello' },
        { type: 'image', name: 'api.png', mediaType: 'image/png', origin: 'uploaded', sourceRef: 'https://claude.ai/api/files/api.png', savedPath: null },
      ], createdAt: null, model: null, parentId: null, branchId: null },
    ]);
    mocks.executeScript.mockResolvedValue([visibleResult({ user: 1, assistant: 0 }, [
      { role: 'user', ordinal: 0, images: [{ name: 'visible.png', data: imageData }] },
    ])]);
    const enriched = await enrichVisibleClaudeImages(original);
    expect(enriched.messages[0]?.blocks).toContainEqual(expect.objectContaining({ type: 'image', name: 'api.png', sourceRef: 'https://claude.ai/api/files/api.png' }));
    expect(enriched.messages[0]?.blocks).not.toContainEqual(expect.objectContaining({ type: 'image', name: 'visible.png' }));
  });

  it('returns the original conversation after a transient script failure', async () => {
    mocks.executeScript.mockRejectedValue(new Error('tab closed'));
    const original = conversation();
    expect(await enrichVisibleClaudeImages(original)).toBe(original);
  });
});
