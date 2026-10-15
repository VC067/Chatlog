import { beforeEach, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import { admitHistory, claimImport, checkpointImport, readImportSessions, setImportPause, persistCapture, readScheduledCaptures, finishCapture } from '../../core/sync/persistence.ts';
import { openVaultDb } from '../../core/storage/db.ts';
import { buildConversation } from '../fixtures/factories.ts';
import { claudeSyncApi, readVisibleClaudeChat } from '../../providers/claude/api.ts';
import { chatGptSyncApi } from '../../providers/chatgpt/api.ts';
import { exportSamplePayloads } from '../../core/sync/samples.ts';
import { conversationFromChatGpt, conversationFromClaude } from '../../providers/shared/normalize.ts';
import { fetchRespectingRateLimit, retryAfterAt } from '../../core/sync/transport.ts';
import type { ListedChat } from '../../core/sync/engine.ts';

const listed = (id: string, accountScope = 'default'): ListedChat => ({ id, accountScope, title: id, updatedAt: null, projectName: null, projectSlug: null });

it('reads a visible Claude conversation from its accessible workspace after a scoped denial', async () => {
  const host = async (url: string) => url.endsWith('/api/organizations')
    ? { ok: true, status: 200, body: '[{"uuid":"denied"},{"uuid":"accessible"}]' }
    : url.includes('/denied/') ? { ok: false, status: 403, body: '{}' }
    : { ok: true, status: 200, body: JSON.stringify({ uuid: 'visible-chat', name: 'Visible', chat_messages: [{ sender: 'assistant', text: 'A complete reply' }] }) };
  const chat = await readVisibleClaudeChat('visible-chat', host);
  expect(chat && chat !== 'needs_signin' ? chat.key : null).toBe('claude:accessible:visible-chat');
});
beforeEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await deleteDB('vaultdraft');
  vi.stubGlobal('browser', { storage: { local: { get: async () => ({ saveCowork: false }) } } });
});

it('claims only one import and preserves pending items when its lease is recovered', async () => {
  const [a, b] = await Promise.all([claimImport('chatgpt', { maxItems: 25 }), claimImport('chatgpt', { maxItems: 25 })]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  const session = (a ?? b)!;
  session.checkpoint = { cursor: '25', pending: [listed('pending')], exhausted: false };
  session.discoveredCount = 25;
  await checkpointImport(session, true);
  const resumed = await claimImport('chatgpt', { maxItems: null });
  expect(resumed?.checkpoint?.pending?.[0]?.id).toBe('pending');
  expect(resumed?.discoveredCount).toBe(25);
  expect(resumed?.maxItems).toBe(25);
});

it('does not overwrite a persisted pause with a worker checkpoint', async () => {
  const session = (await claimImport('claude', { maxItems: null }))!;
  await setImportPause(true, 'claude');
  await checkpointImport(session, true);
  expect((await readImportSessions())[0]?.state).toBe('paused');
  await setImportPause(false, 'claude');
  expect((await readImportSessions())[0]?.state).toBe('running');
});

it('caps 25 unique historical keys per provider while repeats and live archives remain free', async () => {
  const outcomes = await Promise.all(Array.from({ length: 30 }, (_, i) => admitHistory('chatgpt', listed(String(i)), 25)));
  expect(outcomes.filter(Boolean)).toHaveLength(25);
  expect(await admitHistory('chatgpt', listed('0'), 25)).toBe(true);
  expect(await admitHistory('chatgpt', listed('0', 'other-account'), 25)).toBe(false);
  expect(await admitHistory('claude', listed('independent'), 25)).toBe(true);
  const db = await openVaultDb();
  await db.put('conversations', buildConversation({ key: 'chatgpt:default:live', sourceId: 'live' })); db.close();
  expect(await admitHistory('chatgpt', listed('live'), 25)).toBe(true);
  expect(await admitHistory('chatgpt', listed('paid'), null)).toBe(true);
});

it('persists capture leases and retains a newer signal while an older save completes', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await persistCapture({ provider: 'chatgpt', accountScope: 'default', conversationId: 'c1' });
  now += 5100;
  const [a, b] = await Promise.all([readScheduledCaptures(), readScheduledCaptures()]);
  expect(a.length + b.length).toBe(1);
  const old = (a[0] ?? b[0])!;
  await persistCapture(old.signal);
  await finishCapture(old.key, old.signal, true);
  now += 5100;
  expect(await readScheduledCaptures()).toHaveLength(1);
});

it('paginates past a fully filtered Claude page and merges organizations by update date', async () => {
  const paths: string[] = [];
  const fetch = async (url: string) => {
    paths.push(url);
    const body = url.endsWith('organizations') ? [{ uuid: 'org-a' }, { uuid: 'org-b' }]
      : url.includes('org-a') && url.includes('offset=0') ? [{ uuid: 'excluded', task_type: 'cowork' }]
      : url.includes('org-a') && url.includes('offset=1') ? [{ uuid: 'newest', updated_at: '2026-10-09T00:00:00Z' }]
      : url.includes('org-a') ? []
      : url.includes('offset=0') ? [{ uuid: 'older', updated_at: '2026-01-01T00:00:00Z' }] : [];
    return { ok: true, status: 200, body: JSON.stringify(body) };
  };
  const first = await claudeSyncApi.list(null, 1, fetch);
  expect(first).not.toBe('needs_signin');
  if (first === 'needs_signin') return;
  expect(first.items[0]?.id).toBe('newest');
  const second = await claudeSyncApi.list(first.nextCursor, 1, fetch);
  expect(second !== 'needs_signin' && second.items[0]?.id).toBe('older');
  expect(paths.some((url) => url.includes('org-a') && url.includes('offset=1'))).toBe(true);
});

it.each([401, 403, 404, 200] as const)('keeps readable Claude history when a later workspace returns %i', async (status) => {
  const calls: string[] = [];
  const host = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/api/organizations')) return { ok: true, status: 200, body: JSON.stringify([{ uuid: 'org-readable' }, { uuid: 'org-denied' }]) };
    if (url.includes('/org-readable/')) return { ok: true, status: 200, body: JSON.stringify([{ uuid: 'accessible-chat', name: 'Accessible' }]) };
    return { ok: status >= 200 && status < 300, status, body: status === 200 ? '<html>challenge</html>' : '{"error":"private denial"}' };
  };
  const page = await claudeSyncApi.list(null, 25, host);
  expect(page).not.toBe('needs_signin');
  if (page === 'needs_signin') return;
  expect(page.items.map((item) => item.id)).toEqual(['accessible-chat']);
  expect(page.warning).toBe('claude_accounts_skipped');
  expect(calls.some((url) => url.includes('org-readable'))).toBe(true);
  expect(page.nextCursor).toBeNull();
});

it.each([
  ['401', 401, 'needs_signin'],
  ['403', 403, 'blocked'],
  ['HTML challenge', 200, 'blocked'],
] as const)('classifies a Claude history request when no workspace is readable (%s)', async (_name, status, code) => {
  const host = async (url: string) => url.endsWith('/api/organizations')
    ? { ok: true, status: 200, body: JSON.stringify([{ uuid: 'org' }]) }
    : { ok: status >= 200 && status < 300, status, body: status === 200 ? '<html>challenge</html>' : '{}' };
  if (code === 'needs_signin') {
    await expect(claudeSyncApi.list(null, 25, host)).resolves.toBe('needs_signin');
  } else {
    await expect(claudeSyncApi.list(null, 25, host)).rejects.toMatchObject({ code });
  }
});

it.each([[401, 'needs_signin'], [403, 'blocked']] as const)('classifies genuine Claude organization access status %i', async (status, code) => {
  const request = async () => ({ ok: false, status, body: '{}' });
  if (code === 'needs_signin') await expect(claudeSyncApi.list(null, 25, request)).resolves.toBe(code);
  else await expect(claudeSyncApi.list(null, 25, request)).rejects.toMatchObject({ code });
});

it('preserves a blocking Claude conversation denial and propagates a rate limit', async () => {
  await expect(claudeSyncApi.get(listed('chat', 'org'), async () => ({ ok: false, status: 403, body: '{}' }))).rejects.toMatchObject({ code: 'blocked' });
  await expect(claudeSyncApi.list(null, 25, async (url) => url.endsWith('/api/organizations')
    ? { ok: true, status: 200, body: '[{"uuid":"org"}]' }
    : { ok: false, status: 429, body: '<html>wait</html>', retryAfter: '120' })).rejects.toMatchObject({ code: 'rate_limited' });
});

it.each(['not-json', '{"offsets":{"org":-1},"exhausted":[]}', '{"offsets":{"org":1.5},"exhausted":[]}', '{"offsets":[],"exhausted":[]}', '1:x'])(
  'rejects malformed Claude cursor %s', async (cursor) => {
    await expect(claudeSyncApi.list(cursor, 25, async () => ({ ok: true, status: 200, body: '[{"uuid":"org"}]' }))).rejects.toMatchObject({ code: 'unreadable' });
  },
);

it('continues cross-page Claude history while a denied workspace stays eligible for retry', async () => {
  const calls: string[] = [];
  const host = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/api/organizations')) return { ok: true, status: 200, body: '[{"uuid":"org-a"},{"uuid":"org-b"}]' };
    if (url.includes('/org-b/')) return { ok: false, status: 403, body: '{}' };
    const offset = Number(new URL(url).searchParams.get('offset'));
    return { ok: true, status: 200, body: JSON.stringify(offset < 2 ? [{ uuid: `chat-${offset}`, updated_at: `2026-10-0${2 - offset}T00:00:00Z` }] : []) };
  };
  const first = await claudeSyncApi.list(null, 1, host);
  expect(first).not.toBe('needs_signin');
  if (first === 'needs_signin') return;
  expect(first.items[0]?.id).toBe('chat-0');
  expect(first.warning).toBe('claude_accounts_skipped');
  expect(first.nextCursor).not.toBeNull();
  expect(first.nextCursor).not.toContain('org-b');
  const second = await claudeSyncApi.list(first.nextCursor, 1, host);
  expect(second).not.toBe('needs_signin');
  if (second === 'needs_signin') return;
  expect(second.items[0]?.id).toBe('chat-1');
  expect(second.warning).toBe('claude_accounts_skipped');
  expect(calls.filter((url) => url.includes('/org-b/'))).toHaveLength(2);
  expect(calls.some((url) => url.includes('/org-a/') && url.includes('offset=1'))).toBe(true);
});

it('uses provider dates and selected branches and marks unavailable content', () => {
  const chat = conversationFromChatGpt({ id: 'c', create_time: 1700000000, update_time: 1700000010, current_node: 'chosen', mapping: {
    user: { message: { id: 'u', author: { role: 'user' }, content: { parts: ['Question'] } } },
    discarded: { parent: 'user', message: { id: 'd', author: { role: 'assistant' }, content: { parts: ['Discarded'] } } },
    chosen: { parent: 'user', message: { id: 'a', create_time: 1700000010, metadata: { model_slug: 'fixture-model' }, author: { role: 'assistant' }, content: { parts: ['```js\nconst x = 1;\n```\n| A | B |\n| - | - |\n| 1 | 2 |\n$$x^2$$', { content_type: 'unknown-fixture' }] } } },
  } }, 'https://chatgpt.com/c/c');
  expect(chat?.createdAt).toBe('2023-11-14T22:13:20.000Z');
  expect(chat?.messages).toHaveLength(2);
  expect(chat?.messages[1]?.parentId).toBe('user');
  expect(chat?.messages[1]?.model).toBe('fixture-model');
  expect(chat?.warnings).toHaveLength(1);
  const claude = conversationFromClaude({ uuid: 'c', chat_messages: [{ sender: 'assistant', text: '{"valid":"user content"}', created_at: '2026-10-01T00:00:00Z' }] }, 'https://claude.ai/chat/c');
  expect(claude?.messages[0]?.blocks[0]).toEqual({ type: 'text', text: '{"valid":"user content"}' });
  const cleaned = conversationFromClaude({ uuid: 'c2', chat_messages: [{ sender: 'assistant', uuid: 'm', text: 'See this\n\n```\nThis block is not supported on your current device yet.\n```\n\nAfter', content: [{ type: 'image', file_name: 'shot.png', url: 'https://claude.ai/api/files/shot.png' }] }] }, 'https://claude.ai/chat/c2');
  expect(cleaned?.messages[0]?.blocks[0]).toEqual({ type: 'text', text: 'See this\n\nAfter' });
  expect(cleaned?.messages[0]?.blocks[1]).toEqual({ type: 'image', name: 'shot.png', sourceRef: 'https://claude.ai/api/files/shot.png', savedPath: null, origin: 'created' });
});

it('returns a durable retry time for a rate limit without repeating the request', async () => {
  const request = vi.fn(async () => ({ ok: false, status: 429, body: '', retryAfter: '120' }));
  await expect(fetchRespectingRateLimit(request, 'https://claude.ai/api/organizations')).rejects.toMatchObject({ code: 'rate_limited' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(retryAfterAt('120', 1000)).toBe(121000);
});

it('encodes provider identifiers as individual URL path segments', async () => {
  const host = vi.fn(async () => ({ ok: false, status: 404, body: '' }));
  const unsafe = 'fixture/segment?query=value#fragment';
  await chatGptSyncApi.get(listed(unsafe), host);
  expect(host).toHaveBeenLastCalledWith(`https://chatgpt.com/backend-api/conversation/${encodeURIComponent(unsafe)}`);
  await claudeSyncApi.get(listed(unsafe, unsafe), host);
  expect(host).toHaveBeenLastCalledWith(`https://claude.ai/api/organizations/${encodeURIComponent(unsafe)}/chat_conversations/${encodeURIComponent(unsafe)}`);
});

it('copies provider key shapes only when a provider is connected', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const result = await exportSamplePayloads();
  expect(result.ok).toBe(true);
  expect(result.message).toContain('not_connected');
  expect(result.message).not.toContain('conversation text');
  expect(fetch).not.toHaveBeenCalled();
});
