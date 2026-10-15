import { expect, it, vi } from 'vitest';
import { accessTokenFromSession, parseChatGptPage } from '../../providers/chatgpt/api.ts';
import { syncProvider, type SyncApi } from '../../core/sync/engine.ts';
import type { ArchivedConversation } from '../../core/contracts/conversation.ts';
import { buildConversation } from '../fixtures/factories.ts';

it('saves a changed chat and skips one that is already current', async () => {
  const saved: string[] = [];
  const api: SyncApi = {
    provider: 'chatgpt',
    async list() {
      return {
        items: [
          {
            id: 'new',
            title: 'New',
            updatedAt: '2026-10-06T00:00:00.000Z',
            accountScope: 'default',
            projectName: null,
            projectSlug: null,
          },
          {
            id: 'old',
            title: 'Old',
            updatedAt: '2026-10-01T00:00:00.000Z',
            accountScope: 'default',
            projectName: null,
            projectSlug: null,
          },
        ],
        nextCursor: null,
      };
    },
    async get(item) {
      return buildConversation({
        sourceId: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
      });
    },
  };
  const result = await syncProvider(
    api,
    {
      hostFetch: vi.fn(),
      async readUpdatedAt(_provider, _account, sourceId) {
        return sourceId === 'old' ? '2026-10-01T00:00:00.000Z' : null;
      },
      async save(conversation: ArchivedConversation) {
        saved.push(conversation.sourceId);
      },
      async pauseRequested() {
        return false;
      },
      async delay() {
        return undefined;
      },
    },
    { pageSize: 25, maxItems: 25 },
  );
  expect(saved).toEqual(['new']);
  expect(result.savedCount).toBe(1);
  expect(result.discoveredCount).toBe(2);
  expect(result.state).toBe('ok');
});

it('reads a ChatGPT session token and conversation list', () => {
  expect(accessTokenFromSession('{"accessToken":"abc"}')).toBe('abc');
  expect(accessTokenFromSession('{}')).toBeNull();
  const page = parseChatGptPage(JSON.stringify({ items: [{ id: 'c1', title: 'Hello', update_time: 1_700_000_000 }] }));
  expect(page.items[0]?.title).toBe('Hello');
  expect(page.items[0]?.id).toBe('c1');
});

it('stops when the provider says the user is signed out', async () => {
  const api: SyncApi = {
    provider: 'claude',
    async list() {
      return 'needs_signin';
    },
    async get() {
      return null;
    },
  };
  const result = await syncProvider(
    api,
    {
      hostFetch: vi.fn(),
      async readUpdatedAt() {
        return null;
      },
      async save() {
        return undefined;
      },
      async pauseRequested() {
        return false;
      },
      async delay() {
        return undefined;
      },
    },
    { pageSize: 5, maxItems: 5 },
  );
  expect(result.state).toBe('needs_signin');
});
