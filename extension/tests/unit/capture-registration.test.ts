import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ queue: vi.fn(), autoSync: true, autoCaptureAllowed: true }));
vi.mock('../../core/sync/run.ts', () => ({ queueCaptureSignal: mocks.queue }));
vi.mock('../../core/settings.ts', () => ({ readSettings: async () => ({ autoSync: mocks.autoSync }) }));
vi.mock('../../core/licensing/policy.ts', () => ({ getEntitlementStatus: async () => ({ autoCaptureAllowed: mocks.autoCaptureAllowed }) }));

type Sender = { id: string; url?: string; tab?: { url?: string } };
let listener: (message: unknown, sender: Sender, response: (value: unknown) => void) => boolean | void;
let connected: string[];
let settingsWrite: ReturnType<typeof vi.fn>;
let queryTabs: ReturnType<typeof vi.fn>;
const sender: Sender = { id: 'test-extension', url: 'https://chatgpt.com/c/chat-1', tab: { url: 'https://chatgpt.com/c/chat-1' } };
const signal = { source: 'vaultdraft-main', type: 'CAPTURE_SIGNAL', provider: 'chatgpt', pageOrigin: 'https://chatgpt.com', url: 'https://chatgpt.com/backend-api/conversation/chat-1', accountScope: 'default', conversationId: 'chat-1' };

beforeEach(async () => {
  vi.resetModules(); mocks.queue.mockReset().mockResolvedValue(undefined);
  mocks.autoSync = true; mocks.autoCaptureAllowed = true; connected = ['chatgpt', 'claude'];
  settingsWrite = vi.fn(async () => undefined);
  queryTabs = vi.fn(async () => []);
  vi.stubGlobal('browser', {
    runtime: { id: 'test-extension', getURL: () => 'chrome-extension://test-extension/', onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() }, onMessage: { addListener: (value: typeof listener) => { listener = value; } } },
    scripting: { unregisterContentScripts: vi.fn(async () => undefined), registerContentScripts: vi.fn(async () => undefined), executeScript: vi.fn(async () => []) },
    tabs: { query: queryTabs },
    storage: { local: { get: async () => ({ connectedProviders: connected }), set: settingsWrite }, session: { set: vi.fn(async () => undefined) } },
  });
  const { registerCapture, syncCaptureScripts } = await import('../../providers/shared/register.ts'); registerCapture();
  await syncCaptureScripts();
});

it('acknowledges a signal only after its durable queue write finishes', async () => {
  let persist!: () => void;
  mocks.queue.mockImplementation(() => new Promise<void>((resolve) => { persist = resolve; }));
  const response = vi.fn();
  expect(listener(signal, sender, response)).toBe(true);
  await vi.waitFor(() => expect(mocks.queue).toHaveBeenCalledWith('chatgpt', 'default', 'chat-1'));
  expect(response).not.toHaveBeenCalled();
  persist();
  await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ ok: true }));
});

it('reports a failed persistence write instead of acknowledging success', async () => {
  mocks.queue.mockRejectedValue(new Error('fixture-storage-failure'));
  const response = vi.fn(); listener(signal, sender, response);
  await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ ok: false, reason: 'capture_persistence_failed' }));
});

it.each(['disconnect', 'autoSync', 'entitlement'])('stops already-injected signal capture after %s changes', async (gate) => {
  if (gate === 'disconnect') connected = [];
  if (gate === 'autoSync') mocks.autoSync = false;
  if (gate === 'entitlement') mocks.autoCaptureAllowed = false;
  const signalResponse = vi.fn();
  listener(signal, sender, signalResponse);
  await vi.waitFor(() => expect(signalResponse).toHaveBeenCalledWith({ ok: false, reason: 'capture_paused' }));
  expect(mocks.queue).not.toHaveBeenCalled();
});

it('rejects cross-provider messages, unclassified URLs, wrong scopes and mismatched frame origins', () => {
  const response = vi.fn();
  listener({ ...signal, provider: 'claude' }, sender, response);
  listener({ ...signal, url: 'https://chatgpt.com/backend-api/models' }, sender, response);
  listener({ ...signal, accountScope: 'forged-account' }, sender, response);
  listener(signal, { ...sender, url: 'https://claude.ai/chat/chat-1' }, response);
  expect(mocks.queue).not.toHaveBeenCalled();
  expect(response).not.toHaveBeenCalled();
});

it('allows provider settings commands only from extension pages', async () => {
  const response = vi.fn();
  listener({ action: 'provider.connect', provider: 'chatgpt' }, sender, response);
  listener({ action: 'provider.connect', provider: 'chatgpt' }, { id: 'test-extension' }, response);
  expect(settingsWrite).not.toHaveBeenCalled();
  listener({ action: 'provider.connect', provider: 'chatgpt' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, response);
  await vi.waitFor(() => expect(settingsWrite).toHaveBeenCalled());
  expect(response).toHaveBeenCalledWith({ ok: true });
});

it('reattaches capture to already open connected tabs and ignores loading, foreign and discarded tabs', async () => {
  queryTabs.mockResolvedValue([
    { id: 1, url: 'https://claude.ai/chat/one', status: 'complete' },
    { id: 2, url: 'https://chatgpt.com/c/two', status: 'complete' },
    { id: 3, url: 'https://claude.ai/chat/three', status: 'loading' },
    { id: 4, url: 'https://foreign.example/', status: 'complete' },
    { id: 5, url: 'https://claude.ai/chat/five', discarded: true },
  ]);
  const { syncCaptureScripts } = await import('../../providers/shared/register.ts');
  await syncCaptureScripts();
  const calls = vi.mocked(browser.scripting.executeScript).mock.calls.map(([options]) => options);
  expect(calls).toEqual([
    { target: { tabId: 1 }, world: 'ISOLATED', files: ['/content-scripts/provider-relay.js'] },
    { target: { tabId: 1 }, world: 'MAIN', files: ['/content-scripts/provider-main.js'] },
    { target: { tabId: 2 }, world: 'ISOLATED', files: ['/content-scripts/provider-relay.js'] },
    { target: { tabId: 2 }, world: 'MAIN', files: ['/content-scripts/provider-main.js'] },
  ]);
});

it('queues a visible Claude signal only for the same conversation and trusted provider tab', async () => {
  const changed = { source: 'chatlog-page', type: 'CLAUDE_PAGE_CHANGED', pageOrigin: 'https://claude.ai', conversationId: 'visible-chat' };
  const claudeSender = { id: 'test-extension', url: 'https://claude.ai/chat/visible-chat', tab: { url: 'https://claude.ai/chat/visible-chat' } };
  const response = vi.fn();
  expect(listener(changed, claudeSender, response)).toBe(true);
  await vi.waitFor(() => expect(mocks.queue).toHaveBeenCalledWith('claude', '__visible__', 'visible-chat', 'visible'));
  expect(response).toHaveBeenCalledWith({ ok: true });
  mocks.queue.mockClear();
  listener({ ...changed, conversationId: 'another-chat' }, claudeSender, response);
  listener(changed, sender, response);
  listener({ ...changed, text: 'should not be sent' }, claudeSender, response);
  expect(mocks.queue).not.toHaveBeenCalled();
  mocks.autoSync = false;
  const paused = vi.fn(); listener(changed, claudeSender, paused);
  await vi.waitFor(() => expect(paused).toHaveBeenCalledWith({ ok: false, reason: 'capture_paused' }));
  expect(mocks.queue).not.toHaveBeenCalled();
});
