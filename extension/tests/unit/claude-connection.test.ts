import { beforeEach, expect, it, vi } from 'vitest';
import { checkClaudeConnection, clearClaudeConnectionCheck, createClaudeImportReport, readClaudeConnectionCheck, readClaudeConnectionReport } from '../../core/sync/claude-connection.ts';
import { parseTrustedCommand } from '../../core/contracts/messages.ts';
import { claudeSyncApi } from '../../providers/claude/api.ts';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../core/sync/transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/sync/transport.ts')>();
  return { ...actual, fetchWithTabFallback: mocks.request };
});
let values: Record<string, unknown>;
let permission: boolean;
let tabs: unknown[];
beforeEach(() => {
  mocks.request.mockReset(); values = {}; permission = true;
  tabs = [{ id: 1, status: 'complete', discarded: false }];
  vi.stubGlobal('browser', {
    permissions: { contains: async () => permission }, tabs: { query: async () => tabs },
    storage: { local: { get: async () => ({ ...values }), set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); }, remove: async (key: string) => { delete values[key]; } } },
  });
});
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, body: typeof body === 'string' ? body : JSON.stringify(body) });
function emitAttempt(options: { onAttempt: (event: unknown) => void }, result: ReturnType<typeof response>) {
  options.onAttempt({ source: 'extension', outcome: 'response', status: result.status, bodyKind: result.body.trim().startsWith('<') ? 'html' : result.body.trim().startsWith('{') || result.body.trim().startsWith('[') ? 'json' : 'other' });
}
function queueResponses(...results: ReturnType<typeof response>[]) {
  for (const result of results) mocks.request.mockImplementationOnce(async (_url: string, _query: string, _headers: unknown, options: { onAttempt: (event: unknown) => void }) => {
    emitAttempt(options, result);
    return result;
  });
}

it('does not request provider data without site permission or a ready tab', async () => {
  permission = false;
  expect((await checkClaudeConnection()).message).toContain('site access is missing');
  expect(mocks.request).not.toHaveBeenCalled();
  permission = true; tabs = [{ id: 1, status: 'loading' }, { id: 2, discarded: true }];
  expect((await checkClaudeConnection()).message).toContain('No ready Claude tab');
  expect(mocks.request).not.toHaveBeenCalled();
});

it('reports the exact stage and route of a denial without response data', async () => {
  mocks.request.mockImplementation(async (_url, _query, _headers, options) => {
    options.onAttempt({ source: 'extension', outcome: 'response', status: 403, bodyKind: 'html' });
    options.onAttempt({ source: 'tab', outcome: 'response', status: 403, bodyKind: 'json' });
    return response(403, { token: 'PRIVATE-SECRET', error: 'private body' });
  });
  const result = await checkClaudeConnection();
  expect(result.ok).toBe(false);
  expect(result.message).toContain('account access');
  expect(result.report).toContain('extension: 403 html');
  expect(result.report).toContain('tab: 403 json');
  expect(JSON.stringify(values)).not.toContain('PRIVATE-SECRET');
  expect(JSON.stringify(values)).not.toContain('private body');
  expect(await readClaudeConnectionReport()).toBe(result.report);
  expect(await readClaudeConnectionCheck()).toEqual(result);
  expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

it('checks actual history and conversation reads without exporting titles or IDs', async () => {
  queueResponses(response(200, [{ uuid: 'private-org' }]), response(200, [{ uuid: 'private-chat', name: 'private title' }]),
    response(200, { uuid: 'private-chat', chat_messages: [{ sender: 'assistant', text: 'private transcript' }] }));
  const result = await checkClaudeConnection();
  expect(result.ok).toBe(true);
  expect(mocks.request).toHaveBeenCalledTimes(3);
  expect(result.message).toContain('conversation access work');
  for (const privateValue of ['private-org', 'private-chat', 'private title', 'private transcript']) {
    expect(JSON.stringify(values)).not.toContain(privateValue);
    expect(JSON.stringify(result)).not.toContain(privateValue);
  }
});

it('identifies a history failure and respects a 429 even when it contains HTML', async () => {
  queueResponses(response(200, [{ uuid: 'org' }]), response(429, '<html>wait</html>'));
  const result = await checkClaudeConnection();
  expect(result.message).toContain('wait at history list');
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

it('identifies unreadable conversation data instead of claiming success', async () => {
  queueResponses(response(200, [{ uuid: 'org' }]), response(200, [{ uuid: 'chat' }]), response(200, { errors: ['format changed'] }));
  expect((await checkClaudeConnection()).message).toContain('unexpected format at conversation read');
});

it('checks every Claude workspace at limit 25 and reports partial coverage', async () => {
  const requested: string[] = [];
  mocks.request.mockImplementation(async (url: string, _query: string, _headers: unknown, options: { onAttempt: (event: unknown) => void }) => {
    requested.push(url);
    const result = url.endsWith('/api/organizations')
      ? response(200, [{ uuid: 'private-org-a' }, { uuid: 'private-org-b' }])
      : url.includes('/private-org-a/') && url.includes('/chat_conversations?') ? response(200, [{ uuid: 'private-chat', name: 'private title' }])
        : url.includes('/private-org-a/') ? response(200, { uuid: 'private-chat', chat_messages: [{ sender: 'assistant', text: 'private transcript', created_at: '2026-10-01T00:00:00Z' }] })
        : response(403, { error: 'private body' });
    options.onAttempt({ source: 'extension', outcome: 'response', status: result.status, bodyKind: result.body.trim().startsWith('<') ? 'html' : 'json' });
    return result;
  });
  const result = await checkClaudeConnection();
  expect(result.ok).toBe(true);
  expect(result.message).toContain('Some workspaces were unavailable');
  expect((values.claudeConnectionCheck as { partial: boolean }).partial).toBe(true);
  expect(requested.filter((url) => url.includes('/chat_conversations?limit=25'))).toHaveLength(2);
  for (const privateValue of ['private-org-a', 'private-org-b', 'private-chat', 'private title', 'private body']) {
    expect(JSON.stringify(values)).not.toContain(privateValue);
    expect(JSON.stringify(result)).not.toContain(privateValue);
  }
});

it.each([[401, 'sign-in'], [403, 'account access']] as const)('classifies genuine organization %i reads as %s', async (status, expected) => {
  mocks.request.mockImplementation(async (url: string, _query: string, _headers: unknown, options: { onAttempt: (event: unknown) => void }) => {
    const result = response(status, { error: 'private organization denial' });
    options.onAttempt({ source: 'extension', outcome: 'response', status, bodyKind: 'json' });
    return result;
  });
  const result = await checkClaudeConnection();
  expect(result.message).toContain(expected);
  expect(JSON.stringify(result)).not.toContain('private organization denial');
});

it('records real import request stages, workspace ordinals, offsets and source with bounded redaction', async () => {
  const trace = await createClaudeImportReport();
  const requests: string[] = [];
  const host = async (url: string) => {
    requests.push(url);
    const result = url.endsWith('/api/organizations')
      ? response(200, [{ uuid: 'private-org-a' }, { uuid: 'private-org-b' }])
      : url.includes('/private-org-a/') ? response(200, [{ uuid: 'private-chat', name: 'private title' }])
        : response(403, { secret: 'private body' });
    trace.onAttempt(url, { source: 'tab', outcome: 'response', status: result.status, bodyKind: 'json' });
    return result;
  };
  const page = await claudeSyncApi.list(null, 25, host);
  expect(page).not.toBe('needs_signin');
  await trace.finish(null, true);
  const result = await readClaudeConnectionCheck();
  expect(result?.source).toBe('import');
  expect((values.claudeConnectionCheck as { partial: boolean }).partial).toBe(true);
  expect(result?.report).toContain('History import.');
  expect(result?.report).toContain('history list (workspace 1, limit 25, offset 0) / tab: 200 json');
  expect(result?.report).toContain('history list (workspace 2, limit 25, offset 0) / tab: 403 json');
  expect(requests).toHaveLength(3);
  for (const privateValue of ['private-org-a', 'private-org-b', 'private-chat', 'private title', 'private body']) {
    expect(JSON.stringify(values)).not.toContain(privateValue);
    expect(JSON.stringify(result)).not.toContain(privateValue);
  }
  for (let index = 0; index < 70; index += 1) trace.onAttempt(`https://claude.ai/api/organizations/private-${index}/chat_conversations?limit=25&offset=${index}`, { source: 'tab', outcome: 'response', status: 403, bodyKind: 'json' });
  await trace.finish('blocked', true);
  expect((values.claudeConnectionCheck as { attempts: unknown[] }).attempts).toHaveLength(60);
});

it('shares concurrent checks and does not claim a conversation read on an empty history', async () => {
  let release!: (value: ReturnType<typeof response>) => void;
  mocks.request.mockImplementationOnce(async (_url: string, _query: string, _headers: unknown, options: { onAttempt: (event: unknown) => void }) => new Promise((resolve) => {
    release = (result) => { emitAttempt(options, result); resolve(result); };
  }));
  queueResponses(response(200, []));
  const first = checkClaudeConnection(); const second = checkClaudeConnection();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release(response(200, [{ uuid: 'org' }]));
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(a.message).toContain('No eligible conversations');
  expect(a.message).not.toContain('conversation access work');
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

it('rejects malformed stored reports and restricts the trusted command to Claude', async () => {
  values.claudeConnectionCheck = { secret: 'do not export' };
  expect(await readClaudeConnectionReport()).toBeNull();
  values.claudeConnectionCheck = { checkedAt: 1e20, stage: 'tab', code: 'no_tab', permission: true, readyTabs: 0, attempts: [] };
  expect(await readClaudeConnectionCheck()).toBeNull();
  expect(parseTrustedCommand({ action: 'provider.check', provider: 'claude' }).success).toBe(true);
  expect(parseTrustedCommand({ action: 'provider.check', provider: 'claude', url: 'https://other.example' }).success).toBe(false);
  expect(parseTrustedCommand({ action: 'provider.check', provider: 'grok' }).success).toBe(false);
  expect(parseTrustedCommand({ action: 'provider.reset', provider: 'claude' }).success).toBe(true);
  expect(parseTrustedCommand({ action: 'provider.reset', provider: 'grok' }).success).toBe(false);
});

it('reset invalidates an in-flight old report without deleting unrelated data', async () => {
  let release!: (value: ReturnType<typeof response>) => void;
  values.keep = 'unrelated setting';
  mocks.request.mockImplementationOnce(async (_url: string, _query: string, _headers: unknown, options: { onAttempt: (event: unknown) => void }) => new Promise((resolve) => {
    release = (result) => { emitAttempt(options, result); resolve(result); };
  }));
  const old = checkClaudeConnection();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await clearClaudeConnectionCheck();
  expect(await readClaudeConnectionCheck()).toBeNull();
  release(response(403, '<html>blocked</html>'));
  await old;
  expect(await readClaudeConnectionCheck()).toBeNull();
  expect(values.keep).toBe('unrelated setting');
  queueResponses(response(200, [{ uuid: 'org' }]), response(200, []));
  expect((await checkClaudeConnection()).ok).toBe(true);
  expect((await readClaudeConnectionCheck())?.ok).toBe(true);
});
