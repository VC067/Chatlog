export interface HostResponse {
  ok: boolean;
  status: number;
  body: string;
  retryAfter?: string | null;
}

export type HostFetch = (url: string) => Promise<HostResponse>;

export interface ProviderAttemptTrace {
  source: 'extension' | 'tab';
  outcome: 'response' | 'failed' | 'origin_changed' | 'invalid';
  status: number | null;
  bodyKind: 'json' | 'html' | 'other' | null;
}

export class ProviderRequestError extends Error {
  constructor(public code: 'rate_limited' | 'blocked' | 'unavailable' | 'unreadable', public retryAt: number | null = null) { super(code); }
}

export function retryAfterAt(value?: string | null, now = Date.now()): number {
  if (value && /^\d+(\.\d+)?$/.test(value)) return now + Math.max(1000, Number(value) * 1000);
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(now + 1000, date) : now + 60_000;
}

export async function fetchRespectingRateLimit(hostFetch: HostFetch, url: string): Promise<HostResponse> {
  const response = await hostFetch(url);
  if (response.status === 429) throw new ProviderRequestError('rate_limited', retryAfterAt(response.retryAfter));
  // 401 and 403 are returned so each provider can ask the user to sign in again.
  if (!response.ok && response.status !== 401 && response.status !== 403 && response.status !== 404) throw new ProviderRequestError('unavailable', Date.now() + 60_000);
  return response;
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export async function extensionFetch(url: string, headers: Record<string, string> = {}): Promise<HostResponse> {
  const response = await fetch(url, { credentials: 'include', headers, signal: AbortSignal.timeout(20_000) });
  return { ok: response.ok, status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') };
}

export async function fetchWithTabFallback(
  url: string,
  tabQuery: string,
  headers: Record<string, string> = {},
  options: { onAttempt?: (event: ProviderAttemptTrace) => void } = {},
): Promise<HostResponse | 'no_tab'> {
  const report = (source: ProviderAttemptTrace['source'], outcome: ProviderAttemptTrace['outcome'], response?: HostResponse) => {
    try {
      options.onAttempt?.({ source, outcome, status: response?.status ?? null, bodyKind: response ? looksLikeJson(response.body) ? 'json' : response.body.trim().startsWith('<') ? 'html' : 'other' : null });
    } catch { /* Diagnostics must never interrupt a provider request. */ }
  };
  let direct: HostResponse | null = null;
  try {
    direct = await extensionFetch(url, headers);
    report('extension', 'response', direct);
    if ((direct.ok && looksLikeJson(direct.body)) || direct.status === 429 || direct.status >= 500) {
      return direct;
    }
  } catch {
    report('extension', 'failed');
    direct = null;
  }
  const target = new URL(url);
  let tabs;
  try { tabs = await browser.tabs.query({ url: tabQuery }); }
  catch { return direct ?? 'no_tab'; }
  const candidates = tabs.filter((tab) => {
    if (tab.id == null || tab.discarded || tab.status === 'loading') return false;
    try { return !tab.url || new URL(tab.url).origin === target.origin; }
    catch { return false; }
  }).sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, 2);
  // Keep all page attempts within one fetch timeout, even if the first tab is stale.
  const deadline = Date.now() + 20_000;
  let fallback = direct;
  for (const tab of candidates) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) break;
    let payload: HostResponse | null | undefined;
    try {
      const [result] = await browser.scripting.executeScript({
        target: { tabId: tab.id! },
        world: 'MAIN',
        func: async (relativePath: string, headerEntries: [string, string][], origin: string, timeout: number) => {
          // A tab may have navigated after query; never send provider headers elsewhere.
          if (location.origin !== origin) return null;
          const internalFetch = (fetch as typeof fetch & { __vaultdraftOriginalFetch?: typeof fetch }).__vaultdraftOriginalFetch ?? fetch;
          const response = await internalFetch(relativePath, {
            credentials: 'include',
            headers: Object.fromEntries(headerEntries),
            signal: AbortSignal.timeout(timeout),
          });
          return { ok: response.ok, status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') };
        },
        args: [target.pathname + target.search, Object.entries(headers), target.origin, timeoutMs],
      });
      payload = result?.result as HostResponse | null | undefined;
    } catch { report('tab', 'failed'); continue; }
    if (!payload || typeof payload.ok !== 'boolean' || typeof payload.status !== 'number' || typeof payload.body !== 'string') {
      report('tab', payload === null ? 'origin_changed' : 'invalid');
      continue;
    }
    report('tab', 'response', payload);
    if (payload.status === 429 || (payload.ok && looksLikeJson(payload.body))) return payload;
    if (!payload.ok && payload.status !== 403) return payload;
    // Preserve a concrete denial over a challenge/login page returned with HTTP 200.
    if (!fallback || (!payload.ok && fallback.ok)) fallback = payload;
  }
  return fallback ?? 'no_tab';
}
