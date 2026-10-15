export const NOTION_VERSION = '2026-03-11';

export class NotionError extends Error {
  constructor(public code: string, message: string, public retryAfterMs?: number, public uncertain = false) {
    super(message);
  }
}

export async function notionRequest<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  try { await waitForNotionRequest(token); }
  catch (error) {
    if (error instanceof NotionCooldownError) throw new NotionError(error.kind,
      'Notion asked this connection to wait. Saved chats stay in your local archive and delivery will retry automatically.', error.retryAfterMs);
    throw error;
  }
  let response: Response;
  try {
    response = await fetch(`https://api.notion.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new NotionError('notion_network', 'Notion could not be reached. Saved write checkpoints will be checked before retrying.', 30_000, method === 'POST' || method === 'PATCH');
  }
  if (!response.ok) {
    let payload: { code?: unknown; additional_data?: { rate_limit_reason?: unknown; block_limit?: unknown; retry_after?: unknown } } = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch { /* Response bodies are never copied into status. */ }
    const code = typeof payload.code === 'string' ? payload.code : '';
    const extra = payload.additional_data && typeof payload.additional_data === 'object' ? payload.additional_data : {};
    const delay = response.headers.get('Retry-After') ?? (typeof extra.retry_after === 'string' ? extra.retry_after : null);
    const seconds = delay !== null && /^\d+(?:\.\d+)?$/.test(delay.trim()) ? Number(delay) : NaN;
    const retryAfterMs = Number.isFinite(seconds) && Number.isFinite(seconds * 1000) && seconds <= 30 * 24 * 60 * 60
      ? Math.max(1000, Math.ceil(seconds * 1000)) : 30_000;
    if (response.status === 403 && extra.block_limit === 'block_creation') {
      throw new NotionError('notion_workspace_limit', 'This Notion workspace has reached its free block limit. New Notion notes are paused; your chats remain in the local archive. Review the workspace plan in Notion, then Recheck delivery.');
    }
    if (code === 'public_api_request_blocked' || extra.rate_limit_reason === 'public_api_request_blocked') {
      throw new NotionError('notion_api_restricted', 'Notion has restricted this connection’s API access. Automatic retries are paused; your chats remain in the local archive. Contact Notion support before rechecking delivery.');
    }
    if (response.status === 429 || response.status === 529 || response.status >= 500) {
      const temporaryCode = response.status === 429 ? 'rate_limited' : response.status === 529 ? 'service_overload' : code || 'notion_unavailable';
      if (response.status === 429 || response.status === 529) await rememberNotionCooldown(token, retryAfterMs, temporaryCode as 'rate_limited' | 'service_overload');
      throw new NotionError(temporaryCode, response.status === 429
        ? 'Notion asked this connection to wait. Saved chats stay in your local archive and delivery will retry automatically.'
        : 'Notion is temporarily unavailable. Saved chats stay in your local archive and delivery will retry automatically.', retryAfterMs,
      response.status >= 500 && response.status !== 529 && (method === 'POST' || method === 'PATCH'));
    }
    const message = response.status === 401 ? 'The Notion token was rejected.'
      : response.status === 403 || response.status === 404 ? 'Grant this Notion connection access to the original database, with read, insert and update content capabilities.'
      : 'Notion rejected the request. Check the database schema and connection capabilities.';
    throw new NotionError(code || `notion_${response.status}`, message);
  }
  return await response.json() as T;
}

export interface ApiBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

export async function listBlockChildren(token: string, id: string): Promise<ApiBlock[]> {
  const blocks: ApiBlock[] = [];
  let cursor: string | null = null;
  do {
    const response: { results: ApiBlock[]; has_more: boolean; next_cursor: string | null } = await notionRequest(token,
      `blocks/${encodeURIComponent(id)}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
    blocks.push(...response.results);
    if (response.has_more && !response.next_cursor) throw new NotionError('notion_pagination', 'Notion returned an incomplete page of blocks.');
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return blocks;
}
import { NotionCooldownError, rememberNotionCooldown, waitForNotionRequest } from './request-budget.ts';

