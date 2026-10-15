import { conversationKey, type ArchivedConversation } from '../../core/contracts/conversation.ts';
import { fetchRespectingRateLimit, ProviderRequestError, type HostFetch } from '../../core/sync/transport.ts';
import type { ListedChat, SyncApi } from '../../core/sync/engine.ts';
import { conversationFromChatGpt, providerDate } from '../shared/normalize.ts';

function auth(status: number): boolean {
  return status === 401 || status === 403;
}

export function accessTokenFromSession(body: string): string | null {
  try {
    const json = JSON.parse(body) as { accessToken?: unknown };
    return typeof json.accessToken === 'string' && json.accessToken.length > 0 ? json.accessToken : null;
  } catch {
    return null;
  }
}

export function parseChatGptPage(body: string): { items: ListedChat[]; total: number | null } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { items: [], total: null };
  }
  const record = json as { items?: unknown; conversations?: unknown; total?: unknown };
  const raw = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.conversations)
      ? record.conversations
      : Array.isArray(json)
        ? json
        : [];
  const items: ListedChat[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as { id?: unknown; title?: unknown; update_time?: unknown };
    if (typeof row.id !== 'string') {
      continue;
    }
    const updatedAt = providerDate(row.update_time);
    items.push({
      id: row.id,
      title: typeof row.title === 'string' ? row.title : 'Untitled',
      updatedAt,
      accountScope: 'default',
      projectName: null,
      projectSlug: null,
    });
  }
  return { items, total: typeof record.total === 'number' ? record.total : null };
}

export const chatGptSyncApi: SyncApi = {
  provider: 'chatgpt',
  async list(cursor, limit, hostFetch: HostFetch) {
    const offset = Number(cursor ?? '0') || 0;
    const response = await fetchRespectingRateLimit(hostFetch, 
      `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`,
    );
    const body = response.body.trim();
    if (auth(response.status)) {
      return 'needs_signin';
    }
    if (!body.startsWith('{') && !body.startsWith('[')) throw new ProviderRequestError(body.startsWith('<') ? 'blocked' : 'unreadable', Date.now() + 60_000);
    if (!response.ok) throw new ProviderRequestError('unavailable');
    try {
      const parsed = JSON.parse(body) as { items?: unknown; conversations?: unknown };
      if (!Array.isArray(parsed) && !Array.isArray(parsed.items) && !Array.isArray(parsed.conversations)) throw new Error();
    } catch { throw new ProviderRequestError('unreadable'); }
    const page = parseChatGptPage(response.body);
    return {
      items: page.items,
      nextCursor: page.total !== null ? offset + page.items.length < page.total ? String(offset + page.items.length) : null : page.items.length >= limit ? String(offset + page.items.length) : null,
    };
  },
  async get(item, hostFetch) {
    const response = await fetchRespectingRateLimit(hostFetch, `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(item.id)}`);
    if (auth(response.status)) {
      return 'needs_signin';
    }
    if (!response.ok) {
      return null;
    }
    try {
      const conversation = conversationFromChatGpt(JSON.parse(response.body), `https://chatgpt.com/c/${item.id}`);
      if (!conversation || conversation.sourceId !== item.id) {
        return null;
      }
      return {
        ...conversation,
        key: conversationKey('chatgpt', 'default', conversation.sourceId),
        title: conversation.title === 'Untitled' ? item.title : conversation.title,
        updatedAt: conversation.updatedAt ?? item.updatedAt,
      } satisfies ArchivedConversation;
    } catch {
      return null;
    }
  },
};
