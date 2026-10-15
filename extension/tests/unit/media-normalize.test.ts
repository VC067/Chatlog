import { expect, it } from 'vitest';
import { conversationFromChatGpt, conversationFromClaude } from '../../providers/shared/normalize.ts';

it('retains uploaded base64 images and Claude attachment references', () => {
  const chat = conversationFromClaude({ uuid: 'media-chat', chat_messages: [{
    uuid: 'user-1', sender: 'human', text: 'Keep these files',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }],
    attachments: [
      { file_name: 'notes.bin', content_type: 'application/octet-stream' },
      { file_name: 'uploaded.png', content_type: 'image/png', download_url: '/api/files/uploaded.png' },
    ],
  }] }, 'https://claude.ai/chat/media-chat');
  expect(chat?.messages[0]?.blocks).toContainEqual({
    type: 'image', name: 'image', sourceRef: 'data:image/png;base64,aGVsbG8=', savedPath: null, mediaType: 'image/png', origin: 'uploaded',
  });
  expect(chat?.messages[0]?.blocks).toContainEqual({ type: 'attachment', name: 'notes.bin', mediaType: 'application/octet-stream', sourceRef: null });
  expect(chat?.messages[0]?.blocks).toContainEqual({ type: 'image', name: 'uploaded.png', sourceRef: 'https://claude.ai/api/files/uploaded.png', savedPath: null, mediaType: 'image/png', origin: 'uploaded' });
});

it('keeps full Claude artifact source and reconstructs only valid selected-branch patches', () => {
  const source = '<!doctype html><html><body>old</body></html>';
  const chat = conversationFromClaude({
    uuid: 'artifact-chat', current_leaf_message_uuid: 'patch',
    chat_messages: [
      { uuid: 'root', sender: 'human', text: 'Make a page' },
      { uuid: 'discarded', sender: 'assistant', parent_message_uuid: 'root', text: 'Discard this branch' },
      { uuid: 'artifact', sender: 'assistant', parent_message_uuid: 'root', content: [{ type: 'artifact', id: 'page-1', title: 'Page', content: source, mime_type: 'text/html' }] },
      { uuid: 'patch', sender: 'assistant', parent_message_uuid: 'artifact', content: [
        { type: 'tool_use', name: 'artifacts', input: { command: 'update', id: 'page-1', old_str: 'old', new_str: 'new' } },
        { type: 'tool_use', name: 'artifacts', input: { command: 'update', id: 'page-1', title: 'Page', mime_type: 'text/html', old_str: 'missing', new_str: 'bad' } },
      ] },
    ],
  }, 'https://claude.ai/chat/artifact-chat');
  expect(chat?.messages.map((item) => item.sourceId)).toEqual(['root', 'artifact', 'patch']);
  expect(chat?.messages[1]?.blocks).toContainEqual({ type: 'artifact', sourceId: 'page-1', name: 'Page', mediaType: 'text/html', language: 'html', content: source, savedPath: null });
  expect(chat?.messages[2]?.blocks).toContainEqual({ type: 'artifact', sourceId: 'page-1', name: 'Page', mediaType: 'text/html', language: 'html', content: source.replace('old', 'new'), savedPath: null });
  expect(chat?.messages[2]?.blocks.filter((block) => block.type === 'unsupported')).toHaveLength(1);
  expect(chat?.messages.some((item) => item.blocks.some((block) => block.type === 'text' && block.text.includes('Discard')))).toBe(false);
});

it('retains ChatGPT image asset pointers without constructing a download URL', () => {
  const chat = conversationFromChatGpt({ id: 'pointer-chat', current_node: 'image', mapping: {
    image: { parent: null, message: { id: 'image-msg', author: { role: 'user' }, content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://fixture-image' }] } } },
  } }, 'https://chatgpt.com/c/pointer-chat');
  expect(chat?.messages[0]?.blocks).toContainEqual({ type: 'image', name: 'image', sourceRef: 'file-service://fixture-image', savedPath: null, origin: 'uploaded' });
  expect(chat?.messages[0]?.blocks.some((block) => block.type === 'image' && block.sourceRef?.includes('/backend-api/'))).toBe(false);
  expect(chat?.warnings).toEqual([]);
});

it('uses Claude artifact tool MIME metadata and rejects ambiguous patches and malformed image data', () => {
  const chat = conversationFromClaude({ uuid: 'tool-artifact', chat_messages: [
    { uuid: 'create', sender: 'assistant', content: [{ type: 'tool_use', name: 'artifacts', input: { command: 'create', id: 'tool-page', type: 'text/html', content: '<p>same same</p>' } }] },
    { uuid: 'patch', sender: 'assistant', parent_message_uuid: 'create', content: [{ type: 'tool_use', name: 'artifacts', input: { command: 'update', id: 'tool-page', old_str: 'same', new_str: 'changed' } }] },
    { uuid: 'bad-image', sender: 'human', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not base64!' } }] },
  ] }, 'https://claude.ai/chat/tool-artifact');
  expect(chat?.messages[0]?.blocks).toContainEqual({ type: 'artifact', sourceId: 'tool-page', name: 'tool-page', mediaType: 'text/html', language: 'html', content: '<p>same same</p>', savedPath: null });
  expect(chat?.messages[1]?.blocks.some((block) => block.type === 'artifact')).toBe(false);
  expect(chat?.messages[1]?.blocks.some((block) => block.type === 'unsupported')).toBe(true);
  expect(chat?.messages[2]?.blocks.some((block) => block.type === 'image')).toBe(false);
  expect(chat?.messages[2]?.blocks.some((block) => block.type === 'unsupported')).toBe(true);
});
