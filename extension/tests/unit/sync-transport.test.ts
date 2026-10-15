import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchRespectingRateLimit, fetchWithTabFallback } from '../../core/sync/transport.ts';
import type { HostResponse } from '../../core/sync/transport.ts';

const url = 'https://claude.ai/api/organizations';
const tabQuery = 'https://claude.ai/*';
const response = (status: number, body = '', retryAfter: string | null = null): HostResponse => ({ ok: status >= 200 && status < 300, status, body, retryAfter });
const pageResult = (value: HostResponse | null) => [{ result: value }];
const request = vi.fn();
const query = vi.fn();
const execute = vi.fn();

beforeEach(() => {
  request.mockReset(); query.mockReset(); execute.mockReset();
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('browser', { tabs: { query }, scripting: { executeScript: execute } });
  query.mockResolvedValue([{ id: 1, url: 'https://claude.ai/new', active: true, status: 'complete' }]);
  request.mockImplementation(async () => new Response('', { status: 403 }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses the signed-in page when extension-origin requests are blocked', async () => {
  execute.mockResolvedValue(pageResult(response(200, '[{"uuid":"org"}]')));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 200, body: '[{"uuid":"org"}]' });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]?.[0]).toMatchObject({ target: { tabId: 1 }, world: 'MAIN', args: ['/api/organizations', [], 'https://claude.ai', expect.any(Number)] });
});

it('tries a second usable tab after the first page returns a denial', async () => {
  query.mockResolvedValue([{ id: 1, active: true }, { id: 2, active: false }]);
  execute.mockResolvedValueOnce(pageResult(response(403))).mockResolvedValueOnce(pageResult(response(200, '[]')));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 200 });
  expect(execute.mock.calls.map(([call]) => call.target.tabId)).toEqual([1, 2]);
});

it('prefers complete active and recently used tabs and skips loading or discarded pages', async () => {
  query.mockResolvedValue([
    { id: 1, active: false, lastAccessed: 10 },
    { id: 2, active: true, status: 'loading' },
    { id: 3, active: true, discarded: true },
    { id: 4, active: false, lastAccessed: 100 },
    { id: 5, active: true, status: 'complete' },
  ]);
  execute.mockRejectedValueOnce(new Error('tab closed')).mockResolvedValueOnce(pageResult(response(200, '[]')));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 200 });
  expect(execute.mock.calls.map(([call]) => call.target.tabId)).toEqual([5, 4]);
});

it('returns a page denial so the provider can ask for sign-in', async () => {
  request.mockResolvedValue(new Response('<html>challenge</html>', { status: 200 }));
  execute.mockResolvedValue(pageResult(response(403)));
  await expect(fetchRespectingRateLimit((target) => fetchWithTabFallback(target, tabQuery).then((value) => {
    if (value === 'no_tab') throw new Error('no_tab');
    return value;
  }), url)).resolves.toMatchObject({ status: 403 });
});

it('preserves a direct denial when the page returns unreadable HTML', async () => {
  execute.mockResolvedValue(pageResult(response(200, '<html>login</html>')));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 403 });
});

it('returns the available direct response when no usable tabs are open', async () => {
  query.mockResolvedValue([]);
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 403 });
  expect(execute).not.toHaveBeenCalled();
  request.mockRejectedValue(new Error('network unavailable'));
  expect(await fetchWithTabFallback(url, tabQuery)).toBe('no_tab');
});

it('tries another tab after injection fails without losing the direct response', async () => {
  query.mockResolvedValue([{ id: 1, active: true }, { id: 2 }]);
  execute.mockRejectedValueOnce(new Error('cannot access page')).mockResolvedValueOnce(pageResult(response(200, '[]')));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 200 });
  execute.mockRejectedValue(new Error('cannot access page'));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 403 });
});

it('keeps the direct response when querying tabs fails', async () => {
  query.mockRejectedValue(new Error('tabs unavailable'));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 403 });
});

it('does not issue page requests after a direct rate limit', async () => {
  request.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 429, retryAfter: '120' });
  expect(query).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

it('stops immediately when a page returns a rate limit', async () => {
  query.mockResolvedValue([{ id: 1, active: true }, { id: 2 }]);
  execute.mockResolvedValue(pageResult(response(429, '', '120')));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 429, retryAfter: '120' });
  expect(execute).toHaveBeenCalledOnce();
});

it('bounds fallback to two pages and shares one timeout budget', async () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  query.mockResolvedValue([{ id: 1, active: true }, { id: 2 }, { id: 3 }]);
  execute.mockResolvedValue(pageResult(response(403)));
  await fetchWithTabFallback(url, tabQuery);
  expect(execute).toHaveBeenCalledTimes(2);
  execute.mockClear().mockImplementation(async () => { now += 21_000; throw new Error('timed out'); });
  await fetchWithTabFallback(url, tabQuery);
  expect(execute).toHaveBeenCalledOnce();
});

it('does not fetch if a selected tab navigates to another origin before injection', async () => {
  vi.stubGlobal('location', { origin: 'https://example.com' });
  execute.mockImplementation(async (call) => [{ result: await call.func(...call.args) }]);
  expect(await fetchWithTabFallback(url, tabQuery, { Authorization: 'Bearer fixture' })).toMatchObject({ status: 403 });
  expect(request).toHaveBeenCalledOnce();
});

it('does not query tabs for a successful direct JSON response', async () => {
  request.mockResolvedValue(new Response('[]', { status: 200 }));
  expect(await fetchWithTabFallback(url, tabQuery)).toMatchObject({ status: 200 });
  expect(query).not.toHaveBeenCalled();
});

it('reports sanitized route/status traces without response data or request identifiers', async () => {
  const onAttempt = vi.fn();
  execute.mockResolvedValue(pageResult(response(200, '[{"uuid":"private-account"}]')));
  await fetchWithTabFallback(url, tabQuery, { Authorization: 'Bearer secret' }, { onAttempt });
  expect(onAttempt.mock.calls.map(([event]) => event)).toEqual([
    { source: 'extension', outcome: 'response', status: 403, bodyKind: 'other' },
    { source: 'tab', outcome: 'response', status: 200, bodyKind: 'json' },
  ]);
});

it('reports failed and invalid page attempts without surfacing their exception contents', async () => {
  const onAttempt = vi.fn();
  request.mockRejectedValue(new Error('private request details'));
  query.mockResolvedValue([{ id: 1, active: true }, { id: 2 }]);
  execute.mockRejectedValueOnce(new Error('private tab details')).mockResolvedValueOnce([]);
  expect(await fetchWithTabFallback(url, tabQuery, {}, { onAttempt })).toBe('no_tab');
  expect(onAttempt.mock.calls.map(([event]) => event)).toEqual([
    { source: 'extension', outcome: 'failed', status: null, bodyKind: null },
    { source: 'tab', outcome: 'failed', status: null, bodyKind: null },
    { source: 'tab', outcome: 'invalid', status: null, bodyKind: null },
  ]);
});

it('reports a changed page origin and HTML body kind without storing content', async () => {
  const onAttempt = vi.fn();
  request.mockResolvedValue(new Response('<html>Private content</html>', { status: 200 }));
  execute.mockResolvedValue(pageResult(null));
  await fetchWithTabFallback(url, tabQuery, {}, { onAttempt });
  expect(onAttempt.mock.calls.map(([event]) => event)).toEqual([
    { source: 'extension', outcome: 'response', status: 200, bodyKind: 'html' },
    { source: 'tab', outcome: 'origin_changed', status: null, bodyKind: null },
  ]);
});

it('ignores diagnostic observer errors while completing the provider request', async () => {
  execute.mockResolvedValue(pageResult(response(200, '[]')));
  expect(await fetchWithTabFallback(url, tabQuery, {}, { onAttempt: () => { throw new Error('observer failed'); } })).toMatchObject({ status: 200 });
});
