import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ host: vi.fn() }));
vi.mock('../../core/sync/run.ts', () => ({ getProviderHostFetch: () => mocks.host }));

import { collectRedactedShapes, redactStructure } from '../../core/sync/samples.ts';

beforeEach(() => {
  vi.stubGlobal('browser', { storage: { local: { get: async () => ({ connectedProviders: ['claude'] }) } } });
  mocks.host.mockReset();
});

it('keeps keys and value kinds and drops message text', () => {
  const secret = 'this conversation text must not leak';
  const redacted = redactStructure({
    uuid: 'org-1',
    chat_messages: [{ text: secret, content: [{ type: 'thinking', text: secret }] }],
  });
  const encoded = JSON.stringify(redacted);
  expect(encoded).not.toContain(secret);
  expect(encoded).not.toContain('org-1');
  expect(redacted).toMatchObject({
    uuid: 'string',
    chat_messages: { type: 'array', length: 1, first: { text: 'string', content: { type: 'array', length: 1 } } },
  });
});

it('includes heterogeneous media fields and safe type labels without leaking values or dynamic keys', () => {
  const redacted = redactStructure({ mapping: { 'secret-conversation-key': { message: { content: { parts: [
    'private user text',
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'private image bytes' } },
    { type: 'tool_use', name: 'artifacts', input: { command: 'create', title: 'private artifact title', content: 'private code' } },
  ] } } } } });
  const text = JSON.stringify(redacted);
  for (const value of ['secret-conversation-key', 'private user text', 'private image bytes', 'private artifact title', 'private code']) expect(text).not.toContain(value);
  expect(text).toContain('base64');
  expect(text).toContain('artifacts');
  expect(text).toContain('image/png');
  expect(text).toContain('samples');
});

it('redacts dynamic keys outside a mapping too', () => {
  const redacted = JSON.stringify(redactStructure({ attachments: { private_customer_name: { title: 'private title' } }, project: { personal_slug: 'private source' } }));
  expect(redacted).not.toContain('private_customer_name');
  expect(redacted).not.toContain('personal_slug');
  expect(redacted).not.toContain('private title');
  expect(redacted).not.toContain('private source');
});

it('reports only Claude organization counts and retains them when history listing fails', async () => {
  const organizations = [
    { uuid: 'synthetic-chat-uuid', name: 'Private organization', email: 'private@example.test', capabilities: ['chat'] },
    { uuid: 'synthetic-api-uuid', name: 'API organization', capabilities: ['api'] },
    { uuid: 'synthetic-unknown-uuid', name: 'Unknown organization', capabilities: ['token-secret-label'] },
  ];
  mocks.host.mockImplementation(async (url: string) => url.endsWith('/api/organizations')
    ? { ok: true, status: 200, body: JSON.stringify(organizations) }
    : { ok: false, status: 403, body: JSON.stringify({ error: 'private denial' }) });

  const shapes = await collectRedactedShapes();
  const claude = shapes.claude as Record<string, unknown>;
  expect(claude).toEqual({
    organizationSelection: { status: 200, kind: 'json', total: 3, chatEnabled: 1, apiOnlySkipped: 1, unknown: 1 },
    error: 'unavailable',
  });
  const encoded = JSON.stringify(shapes);
  for (const privateValue of ['synthetic-chat-uuid', 'synthetic-api-uuid', 'synthetic-unknown-uuid', 'Private organization', 'API organization', 'Unknown organization', 'private@example.test', 'token-secret-label', 'capabilities', 'private denial']) {
    expect(encoded).not.toContain(privateValue);
  }
});
