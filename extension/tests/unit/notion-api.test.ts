import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notionRequest } from '../../destinations/notion/api.ts';
import { NotionCooldownError } from '../../destinations/notion/request-budget.ts';
const gate = vi.hoisted(() => ({ wait: vi.fn(), remember: vi.fn() }));
vi.mock('../../destinations/notion/request-budget.ts', async (original) => ({
  ...await original<typeof import('../../destinations/notion/request-budget.ts')>(),
  waitForNotionRequest: gate.wait, rememberNotionCooldown: gate.remember,
}));
beforeEach(() => {
  vi.clearAllMocks(); gate.wait.mockResolvedValue(undefined); gate.remember.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
const rejectWith = (status: number, payload: unknown, headers?: Record<string, string>) => vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(payload), { status, headers }));

it('distinguishes a workspace block limit from a sharing failure', async () => {
  rejectWith(403, { code: 'restricted_resource', message: 'private response', additional_data: { block_limit: 'block_creation' } });
  await expect(notionRequest('private-token', 'pages', 'POST')).rejects.toMatchObject({ code: 'notion_workspace_limit', retryAfterMs: undefined, uncertain: false });
  rejectWith(403, { code: 'restricted_resource' });
  await expect(notionRequest('private-token', 'pages')).rejects.toMatchObject({ code: 'restricted_resource', message: expect.stringContaining('Grant this Notion connection access') });
});
it('treats documented API restriction as terminal rather than a cooldown', async () => {
  rejectWith(429, { code: 'rate_limited', additional_data: { rate_limit_reason: 'public_api_request_blocked' } }, { 'Retry-After': '60' });
  await expect(notionRequest('private-token', 'pages')).rejects.toMatchObject({ code: 'notion_api_restricted', retryAfterMs: undefined });
  expect(gate.remember).not.toHaveBeenCalled();
});
it('honors rate-limit headers and body fallback without exposing response contents', async () => {
  rejectWith(429, { code: 'rate_limited', message: 'private server details' }, { 'Retry-After': '125' });
  await expect(notionRequest('private-token', 'pages')).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 125_000, message: expect.not.stringContaining('private') });
  expect(gate.remember).toHaveBeenCalledWith('private-token', 125_000, 'rate_limited');
  rejectWith(529, { code: 'service_overload', additional_data: { retry_after: '61' } });
  await expect(notionRequest('private-token', 'pages')).rejects.toMatchObject({ code: 'service_overload', retryAfterMs: 61_000 });
});
it('does not fetch during a persisted cooldown', async () => {
  gate.wait.mockRejectedValueOnce(new NotionCooldownError('rate_limited', 9999));
  await expect(notionRequest('private-token', 'pages')).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 9999, uncertain: false });
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps failed write responses uncertain while reads remain safe to retry', async () => {
  rejectWith(503, { code: 'service_unavailable' });
  await expect(notionRequest('private-token', 'pages', 'POST')).rejects.toMatchObject({ uncertain: true });
  rejectWith(503, { code: 'service_unavailable' });
  await expect(notionRequest('private-token', 'pages')).rejects.toMatchObject({ uncertain: false });
});
