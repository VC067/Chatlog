import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grokConversationId } from '../../providers/grok/url.ts';
import { readVisibleGrokConversation } from '../../providers/grok/page-capture.ts';
import { registerArchiveCommands } from '../../platform/commands.ts';
import { ingestDraft } from '../../core/archive/ingest.ts';
import { runDeliveryQueue } from '../../core/queue/runner.ts';

vi.mock('../../core/archive/ingest.ts', () => ({ ingestDraft: vi.fn(async () => 'saved') }));
vi.mock('../../core/queue/runner.ts', () => ({ runDeliveryQueue: vi.fn(async () => ({})), retryDestinationQueue: vi.fn() }));
vi.mock('../../core/archive/repository.ts', async (original) => ({
  ...await original<typeof import('../../core/archive/repository.ts')>(),
  listJobs: vi.fn(async () => []),
}));

describe('Grok conversation URLs', () => {
  it.each([
    ['https://grok.com/c/6a0a2b3c-d4e5-f678-abcd-123456789abc', '6a0a2b3c-d4e5-f678-abcd-123456789abc'],
    ['https://grok.com/chat/test-chat-123?utm_source=test#reply', 'test-chat-123'],
    ['https://www.grok.com/c/test-chat-123/', 'test-chat-123'],
    ['https://x.com/i/grok?conversation=1234567890', '1234567890'],
    ['https://x.com/i/grok/1234567890', '1234567890'],
  ])('recognizes %s', (value, id) => {
    expect(grokConversationId(new URL(value))).toBe(id);
  });
  it.each([
    'http://grok.com/c/test-chat-123', 'https://grok.com/', 'https://grok.com/c',
    'https://grok.com/settings/privacy', 'https://grok.com/imagine/test-chat-123',
    'https://grok.com/c/test-chat-123/settings', 'https://grok.com/c/short',
    'https://grok.com/c/%2Fsecret', 'https://grok.com.evil.test/c/test-chat-123',
    'https://user:password@grok.com/c/test-chat-123', 'https://grok.com:444/c/test-chat-123',
    'https://x.com/settings/grok', 'https://x.com/i/grok',
  ])('rejects %s', (value) => {
    expect(grokConversationId(new URL(value))).toBeNull();
  });
});

type Listener = (message: unknown, sender: { id: string; url: string }, response: (value: unknown) => void) => boolean | void;
let listener: Listener;
const sourceUrl = 'https://grok.com/c/test-chat-123';
const query = vi.fn();
const getTab = vi.fn();
const executeScript = vi.fn();
const sender = { id: 'self', url: 'chrome-extension://self/popup.html' };
const sample = {
  turns: [{ role: 'user', text: 'A disposable test prompt' }, { role: 'assistant', text: 'A test reply' }],
  text: 'A disposable test prompt\n\nA test reply', truncated: false, title: 'Grok',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ingestDraft).mockResolvedValue('saved');
  query.mockResolvedValue([{ id: 17, url: sourceUrl }]);
  getTab.mockResolvedValue({ id: 17, url: sourceUrl });
  executeScript.mockResolvedValue([{ frameId: 0, result: structuredClone(sample) }]);
  vi.stubGlobal('browser', {
    runtime: { id: 'self', getURL: (path: string) => 'chrome-extension://self/' + path,
      onMessage: { addListener: (value: Listener) => { listener = value; } } },
    tabs: { query, get: getTab }, scripting: { executeScript },
  });
  registerArchiveCommands();
});
afterEach(() => vi.unstubAllGlobals());

function save(action = 'conversation.save'): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve, reject) => {
    const handled = listener({ action }, sender, (response) => resolve(response as { ok: boolean; message: string }));
    if (!handled) reject(new Error('Trusted command was not handled'));
  });
}

describe('manual Grok capture through trusted commands', () => {
  it('binds one selected tab and URL, archives attributed text as partial, and delivers it', async () => {
    expect(await save()).toMatchObject({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 17 }, func: readVisibleGrokConversation, args: [sourceUrl] });
    expect(getTab).toHaveBeenCalledWith(17);
    expect(ingestDraft).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'grok', accountScope: 'default', sourceId: 'test-chat-123', sourceUrl,
      title: 'A disposable test prompt', manual: true, captureKind: 'manual', completeness: 'partial',
      messages: [expect.objectContaining({ role: 'user' }), expect.objectContaining({ role: 'assistant' })],
    }));
    expect(runDeliveryQueue).toHaveBeenCalledTimes(1);
  });
  it('preserves unknown speaker attribution and reports truncation honestly', async () => {
    executeScript.mockResolvedValue([{ result: { ...sample, turns: [{ role: null, text: sample.text }], truncated: true } }]);
    expect(await save('grok.capture')).toMatchObject({ ok: true });
    const draft = vi.mocked(ingestDraft).mock.calls[0]![0];
    expect(draft.messages?.[0]?.role).toBe('system');
    expect(draft.warning).toContain('Speaker attribution could not be verified');
    expect(draft.warning).toContain('truncated');
  });
  it.each([null, { ...sample, text: '', turns: [] }])('does not save empty or changed page results', async (result) => {
    executeScript.mockResolvedValue([{ result }]);
    expect(await save()).toMatchObject({ ok: false });
    expect(ingestDraft).not.toHaveBeenCalled();
    expect(runDeliveryQueue).not.toHaveBeenCalled();
  });
  it('rejects navigation after capture without saving under the previous identity', async () => {
    getTab.mockResolvedValue({ id: 17, url: 'https://grok.com/c/another-chat' });
    expect(await save()).toMatchObject({ ok: false, message: expect.stringContaining('changed') });
    expect(ingestDraft).not.toHaveBeenCalled();
  });
  it('rejects non-conversation routes without injecting', async () => {
    query.mockResolvedValue([{ id: 17, url: 'https://grok.com/settings/privacy' }]);
    expect(await save()).toMatchObject({ ok: false });
    expect(executeScript).not.toHaveBeenCalled();
  });
  it('does not report successful saving when ingestion rejects the capture', async () => {
    vi.mocked(ingestDraft).mockResolvedValue('ignored');
    expect(await save()).toMatchObject({ ok: false });
    expect(runDeliveryQueue).not.toHaveBeenCalled();
  });
  it('does not allow a provider page to trigger trusted manual capture', () => {
    const response = vi.fn();
    expect(listener({ action: 'conversation.save' }, { id: 'self', url: sourceUrl }, response)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(response).not.toHaveBeenCalled();
  });
});
