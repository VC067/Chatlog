import { expect, it } from 'vitest';
import { sampleSse } from '../fixtures/streams.ts';
import {
  installFetchObserver,
  observeResponse,
  providerForUrl,
} from '../../providers/shared/observe.ts';
function responseFor(url: string, body: string): Response {
  const response = {
    url,
    clone() {
      return response;
    },
    text() {
      return Promise.resolve(body);
    },
  };
  return response as unknown as Response;
}

it('ignores unrelated urls', () => {
  expect(providerForUrl(new URL('https://example.com/backend-api/conversation'))).toBe(
    null,
  );
  expect(
    providerForUrl(
      new URL(
        'https://claude.ai/api/organizations/org/chat_conversations/chat/composer_notices',
      ),
    ),
  ).toBe(null);
  expect(providerForUrl(new URL('https://chatgpt.com/backend-api/models'))).toBe(null);
});

it('reads a cloned body and leaves the original readable', async () => {
  const response = responseFor(
    'https://chatgpt.com/backend-api/conversation/conv-1',
    sampleSse,
  );
  const observed = await observeResponse(response);
  expect(observed?.provider).toBe('chatgpt');
  expect(observed?.conversationId).toBe('conv-1');
  await expect(response.text()).resolves.toBe(sampleSse);
});

it('does not reject the page fetch when observation throws', async () => {
  const target: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } = {
    fetch: () => Promise.resolve(responseFor('https://chatgpt.com/backend-api/x', sampleSse)),
  };
  installFetchObserver(target, () => {
    throw new Error('parser failed');
  });
  const response = await target.fetch('https://chatgpt.com/backend-api/x');
  await expect(response.text()).resolves.toBe(sampleSse);
});

it('does not emit twice when the observer is installed twice', async () => {
  let calls = 0;
  const target: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } = {
    fetch: () =>
      Promise.resolve(
        responseFor('https://claude.ai/api/organizations/o/chat_conversations/c', sampleSse),
      ),
  };
  const emit = () => {
    calls += 1;
  };
  installFetchObserver(target, emit);
  installFetchObserver(target, emit);
  await target.fetch('https://claude.ai/api/organizations/o/chat_conversations/c');
  expect(calls).toBe(1);
});

it('observes user fetches while exposing an internal read that does not reschedule capture', async () => {
  let calls = 0;
  const target = { fetch: () => Promise.resolve(responseFor('https://claude.ai/api/organizations/o/chat_conversations/c', sampleSse)) };
  installFetchObserver(target, () => { calls += 1; });
  await target.fetch();
  expect(calls).toBe(1);
  const internalFetch = (target.fetch as typeof target.fetch & { __vaultdraftOriginalFetch?: typeof target.fetch }).__vaultdraftOriginalFetch;
  expect(internalFetch).toBeTypeOf('function');
  await internalFetch?.();
  expect(calls).toBe(1);
});

it('waits for the Claude completion stream to finish before signaling a save', async () => {
  let finish!: (body: string) => void;
  let signaled = false;
  const body = new Promise<string>((resolve) => { finish = resolve; });
  const response = { url: 'https://claude.ai/api/organizations/org/chat_conversations/chat/completion', clone: () => ({ text: () => body }) };
  const pending = observeResponse(response as unknown as Response).then((signal) => { signaled = true; return signal; });
  await Promise.resolve();
  expect(signaled).toBe(false);
  finish('data: [DONE]');
  expect(await pending).toMatchObject({ provider: 'claude', conversationId: 'chat', accountScope: 'org' });
});
