import { expect, it } from 'vitest';
import { renderConversationMarkdown } from '../../destinations/markdown/render.ts';
import { buildConversation } from '../fixtures/factories.ts';
import { stripUnsupportedBlocks } from '../../providers/shared/placeholders.ts';

it('renders every content type without executing it', () => {
  const markdown = renderConversationMarkdown(
    buildConversation({
      title: 'Line\n"quoted"',
      messages: [
        {
          sourceId: 'msg-1',
          role: 'user',
          createdAt: '2026-10-05T00:00:00.000Z',
          model: null,
          parentId: null,
          branchId: null,
          blocks: [
            { type: 'text', text: 'Hello <script>alert(1)</script>\n| a | b |\n| - | - |' },
            { type: 'code', language: 'ts', code: 'const fence = ```;' },
            { type: 'citation', url: 'https://example.com/paper', title: 'Paper' },
            {
              type: 'attachment',
              name: 'diagram.png',
              mediaType: 'image/png',
              sourceRef: null,
            },
            { type: 'text', text: '$$E = mc^2$$' },
            { type: 'unsupported', code: 'canvas', description: 'Canvas was not saved' },
          ],
        },
      ],
      warnings: [
        {
          code: 'partial',
          description: 'Older messages were not loaded',
          messageId: null,
          blockIndex: null,
        },
      ],
    }),
  );

  expect(markdown).toContain('title: "Line\\n\\"quoted\\""');
  expect(markdown).toContain('Hello &lt;script>alert(1)&lt;/script>');
  expect(markdown).toContain('| a | b |');
  expect(markdown).toContain('````ts\nconst fence = ```;\n````');
  expect(markdown).toContain('> Paper\n> https://example.com/paper');
  expect(markdown).toContain('Attachment: diagram.png (image/png) unavailable');
  expect(markdown).toContain('$$E = mc^2$$');
  expect(markdown).toContain('> [!WARNING]\n> Canvas was not saved');
  expect(markdown).toContain('> [!WARNING]\n> Older messages were not loaded');
  expect(markdown).not.toContain('![diagram.png]');
});

it('drops Claude device placeholders', () => {
  const source = 'Hello\n\n```\nThis block is not supported on your current device yet.\n```\n\n```\nThis block is not supported on your current device yet.\n```\n\nDone';
  expect(stripUnsupportedBlocks(source)).toBe('Hello\n\nDone');
  const markdown = renderConversationMarkdown(
    buildConversation({
      messages: [
        {
          sourceId: null,
          role: 'assistant',
          createdAt: null,
          model: null,
          parentId: null,
          branchId: null,
          blocks: [{ type: 'text', text: source }],
        },
      ],
    }),
  );
  expect(markdown).not.toContain('not supported on your current device');
  expect(markdown).toContain('Hello');
});

it('adds a source list only when asked', () => {
  const conversation = buildConversation({
    messages: [
      {
        sourceId: null,
        role: 'assistant',
        createdAt: null,
        model: null,
        parentId: null,
        branchId: null,
        blocks: [{ type: 'citation', url: 'https://example.com/paper', title: 'Paper' }],
      },
    ],
  });
  expect(renderConversationMarkdown(conversation)).not.toContain('## Sources');
  expect(renderConversationMarkdown(conversation, { includeSources: true })).toContain('## Sources');
});

it('returns the same bytes for the same conversation', () => {
  const conversation = buildConversation({ title: 'Unicode café — 保存' });
  expect(renderConversationMarkdown(conversation)).toBe(
    renderConversationMarkdown(conversation),
  );
});
