import { classifyProviderUrl } from './endpoints.ts';

const PATCH_FLAG = '__vaultdraftFetchPatched';

export interface CaptureSignal {
  provider: 'chatgpt' | 'claude';
  url: string;
  accountScope: string;
  conversationId: string;
}

type FetchTarget = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  [PATCH_FLAG]?: boolean;
};

export function providerForUrl(url: URL): 'chatgpt' | 'claude' | null {
  return classifyProviderUrl(url)?.provider ?? null;
}

function conversationIdFromBody(body: string): string {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]' || raw.length > 20_000) {
      continue;
    }
    try {
      const event = JSON.parse(raw) as { conversation_id?: unknown };
      if (typeof event.conversation_id === 'string' && event.conversation_id.length > 0) {
        return event.conversation_id;
      }
    } catch {
      // The page response is left alone.
    }
  }
  return '';
}

export async function observeResponse(
  response: Pick<Response, 'url' | 'clone'>,
): Promise<CaptureSignal | null> {
  const url = new URL(response.url);
  const classified = classifyProviderUrl(url);
  if (!classified) {
    return null;
  }
  let conversationId = classified.sourceId;
  if (classified.kind === 'completion') {
    // The completion response starts before the assistant has finished. Reading
    // its clone to the end prevents saving only the first streaming snapshot.
    const body = await response.clone().text();
    if (!conversationId) conversationId = conversationIdFromBody(body);
  }
  if (!conversationId) {
    return null;
  }
  return {
    provider: classified.provider,
    url: response.url,
    accountScope: classified.accountScope,
    conversationId,
  };
}

export function installFetchObserver(
  target: FetchTarget,
  emit: (observed: CaptureSignal) => void,
): void {
  if (target[PATCH_FLAG]) {
    return;
  }
  target[PATCH_FLAG] = true;
  const original = target.fetch.bind(target);
  const wrapped: typeof target.fetch & { __vaultdraftOriginalFetch?: typeof target.fetch } = async (input, init) => {
    const response = await original(input, init);
    void observeResponse(response).then((observed) => {
      if (observed) {
        emit(observed);
      }
    }).catch(() => {
      // Observation must never break the page response.
    });
    return response;
  };
  Object.defineProperty(wrapped, '__vaultdraftOriginalFetch', { value: original });
  target.fetch = wrapped;
}
