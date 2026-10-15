import { deleteDB } from 'idb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retryDestinationQueue, runDeliveryQueue } from '../../core/queue/runner.ts';
import { commitConversationWithJobs, listJobs } from '../../core/archive/repository.ts';
import { deliverMarkdown } from '../../destinations/markdown/deliver.ts';
import { deliverNotion } from '../../destinations/notion/deliver.ts';
import { readFolderAccess } from '../../destinations/markdown/permission.ts';
import { buildConversation } from '../fixtures/factories.ts';
import { readNotionStatus, recordNotionDeliveryStatus } from '../../destinations/notion/config.ts';

vi.mock('../../destinations/markdown/deliver.ts', () => ({
  deliverMarkdown: vi.fn(async () => 'written'), resolveMarkdownNotePath: vi.fn(async () => 'chatgpt/note.md'),
}));
vi.mock('../../destinations/markdown/permission.ts', () => ({ readFolderAccess: vi.fn(async () => 'granted') }));
vi.mock('../../destinations/markdown/handle-store.ts', () => ({ readRootHandle: vi.fn(async () => ({ name: 'QA' })) }));
vi.mock('../../destinations/markdown/side-files.ts', () => ({ writeSideFiles: vi.fn(async (input) => input) }));
vi.mock('../../destinations/notion/config.ts', () => ({
  readNotionConfig: vi.fn(async () => ({ token: 'fixture-token', databaseId: 'database', dataSourceId: 'source', titleProperty: 'Name', identityProperty: 'Conversation ID', properties: {} })),
  recordNotionDeliveryStatus: vi.fn(async () => undefined),
  readNotionStatus: vi.fn(async () => ({ state: 'connected', message: null })),
  clearNotionDeliveryIssue: vi.fn(async () => undefined),
}));
vi.mock('../../destinations/notion/deliver.ts', () => ({ deliverNotion: vi.fn(async () => ({ status: 'written', pageId: 'page' })) }));
let store: Record<string, unknown>;
let permitted: boolean;
beforeEach(async () => {
  await deleteDB('vaultdraft'); vi.clearAllMocks();
  store = {}; permitted = true;
  vi.mocked(deliverMarkdown).mockResolvedValue('written');
  vi.mocked(deliverNotion).mockResolvedValue({ status: 'written', pageId: 'page' });
  vi.mocked(readFolderAccess).mockResolvedValue('granted');
  vi.mocked(readNotionStatus).mockResolvedValue({ state: 'connected', message: null });
  vi.stubGlobal('browser', { permissions: { contains: async () => permitted }, storage: { local: {
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => { Object.assign(store, values); },
  } } });
});
afterEach(() => vi.unstubAllGlobals());

it('keeps a rate-limited Notion delivery queued while Markdown finishes', async () => {
  await commitConversationWithJobs(buildConversation(), ['notion', 'markdown']);
  vi.mocked(deliverNotion).mockResolvedValue({ status: 'retry', errorCode: 'rate_limited', retryAfterMs: 125_000, message: 'Notion is waiting.' });
  expect((await runDeliveryQueue()).written).toBe(1);
  expect(vi.mocked(recordNotionDeliveryStatus)).toHaveBeenCalledWith(false, expect.objectContaining({ retryAfterMs: 125_000 }), expect.objectContaining({ dataSourceId: 'source' }));
  const waiting = (await listJobs()).find((job) => job.destinationId === 'notion')!;
  expect(waiting).toMatchObject({ state: 'retry_wait', errorCode: 'rate_limited' });
  expect(Date.parse(waiting.nextEligibleAt!) - Date.now()).toBeGreaterThan(120_000);
  await runDeliveryQueue();
  expect(deliverNotion).toHaveBeenCalledOnce();
});
it('stops automatic Notion work on quota exhaustion while Markdown remains available', async () => {
  await commitConversationWithJobs(buildConversation(), ['notion', 'markdown']);
  vi.mocked(deliverNotion).mockResolvedValue({ status: 'failed', errorCode: 'notion_workspace_limit', message: 'Workspace limit reached.' });
  await runDeliveryQueue();
  expect((await listJobs()).find((job) => job.destinationId === 'notion')).toMatchObject({ state: 'blocked', errorCode: 'notion_workspace_limit' });
  vi.mocked(readNotionStatus).mockResolvedValue({ state: 'error', message: 'Workspace limit reached.', errorCode: 'notion_workspace_limit' });
  await commitConversationWithJobs(buildConversation({ sourceId: 'second-chat' }), ['notion', 'markdown']);
  expect((await runDeliveryQueue()).written).toBe(1);
  expect(deliverNotion).toHaveBeenCalledOnce();
});
it('does not repeatedly call a restricted Notion connection', async () => {
  vi.mocked(readNotionStatus).mockResolvedValue({ state: 'error', message: 'Access restricted.', errorCode: 'notion_api_restricted' });
  await commitConversationWithJobs(buildConversation(), ['notion']);
  await runDeliveryQueue(); await runDeliveryQueue();
  expect(deliverNotion).not.toHaveBeenCalled();
  expect((await listJobs())[0]).toMatchObject({ state: 'blocked', errorCode: 'notion_api_restricted' });
});
it('rechecks terminal quota jobs only after an explicit destination retry', async () => {
  await commitConversationWithJobs(buildConversation(), ['notion']);
  vi.mocked(deliverNotion).mockResolvedValueOnce({ status: 'failed', errorCode: 'notion_workspace_limit' });
  await runDeliveryQueue();
  expect((await listJobs())[0]).toMatchObject({ state: 'blocked' });
  expect((await retryDestinationQueue()).written).toBe(1);
  expect(deliverNotion).toHaveBeenCalledTimes(2);
});

it('shares concurrent queue wakeups so one job writes once', async () => {
  await commitConversationWithJobs(buildConversation(), ['markdown']);
  const [first, second] = await Promise.all([runDeliveryQueue(), runDeliveryQueue()]);
  expect(deliverMarkdown).toHaveBeenCalledTimes(1); expect(first).toEqual(second);
  expect((await listJobs())[0]?.state).toBe('completed');
});
it('continues Notion delivery when the independent Markdown write throws', async () => {
  await commitConversationWithJobs(buildConversation(), ['markdown', 'notion']);
  vi.mocked(deliverMarkdown).mockRejectedValue(new Error('write unavailable'));
  const result = await runDeliveryQueue();
  expect(result.written).toBe(1); expect(deliverNotion).toHaveBeenCalledOnce();
  const jobs = await listJobs();
  expect(jobs.find((job) => job.destinationId === 'markdown')?.state).toBe('retry_wait');
  expect(jobs.find((job) => job.destinationId === 'notion')?.state).toBe('completed');
});
it('retains a permission-blocked folder job without reporting a write', async () => {
  await commitConversationWithJobs(buildConversation(), ['markdown']);
  vi.mocked(readFolderAccess).mockResolvedValue('denied');
  vi.mocked(deliverMarkdown).mockResolvedValue('blocked');
  const result = await runDeliveryQueue();
  expect(result.written).toBe(0); expect(result.blocked).toBe(1);
  expect((await listJobs())[0]).toMatchObject({ state: 'blocked', errorCode: 'permission_required' });
});
it('keeps disabled folder delivery separate from enabled Notion', async () => {
  store.settings = { markdownEnabled: false };
  await commitConversationWithJobs(buildConversation(), ['markdown', 'notion']);
  const result = await runDeliveryQueue();
  expect(deliverMarkdown).not.toHaveBeenCalled(); expect(deliverNotion).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ written: 1, blocked: 1 });
});
it('does not send the token to Notion after its host permission is revoked', async () => {
  permitted = false;
  await commitConversationWithJobs(buildConversation(), ['notion']);
  expect((await runDeliveryQueue()).written).toBe(0);
  expect(deliverNotion).not.toHaveBeenCalled();
  expect((await listJobs())[0]).toMatchObject({ state: 'blocked', errorCode: 'notion_permission_required' });
  permitted = true;
  expect((await runDeliveryQueue()).written).toBe(1);
});
it('keeps an uncertain remote write for explicit reconciliation', async () => {
  await commitConversationWithJobs(buildConversation(), ['notion']);
  vi.mocked(deliverNotion).mockResolvedValue({ status: 'failed', errorCode: 'notion_write_uncertain' });
  expect((await runDeliveryQueue()).written).toBe(0);
  expect((await listJobs())[0]).toMatchObject({ state: 'needs_review', errorCode: 'notion_write_uncertain' });
});
