import type { ArchivedConversation } from '../contracts/conversation.ts';
import type { SyncProviderStatus } from './types.ts';
import type { HostFetch } from './transport.ts';

export interface ListedChat {
  id: string;
  title: string;
  updatedAt: string | null;
  accountScope: string;
  projectName: string | null;
  projectSlug: string | null;
}

export interface SyncApi {
  provider: 'chatgpt' | 'claude';
  list(cursor: string | null, limit: number, hostFetch: HostFetch): Promise<
    { items: ListedChat[]; nextCursor: string | null; warning?: 'claude_accounts_skipped' } | 'needs_signin'
  >;
  get(item: ListedChat, hostFetch: HostFetch): Promise<ArchivedConversation | null | 'needs_signin'>;
}

export interface SyncDeps {
  hostFetch: HostFetch;
  readUpdatedAt(provider: string, accountScope: string, sourceId: string): Promise<string | null>;
  save(conversation: ArchivedConversation): Promise<void>;
  pauseRequested(): Promise<boolean>;
  delay(ms: number): Promise<void>;
}

function status(provider: SyncApi['provider'], patch: Partial<SyncProviderStatus>): SyncProviderStatus {
  return {
    provider,
    state: 'ok',
    lastRunAt: new Date().toISOString(),
    discoveredCount: 0,
    savedCount: 0,
    error: null,
    ...patch,
  };
}

export async function syncProvider(
  api: SyncApi,
  deps: SyncDeps,
  options: { pageSize: number; maxItems: number | null },
): Promise<SyncProviderStatus> {
  let cursor: string | null = null;
  let discovered = 0;
  let saved = 0;
  const cap = options.maxItems ?? Number.POSITIVE_INFINITY;
  while (discovered < cap) {
    if (await deps.pauseRequested()) {
      return status(api.provider, {
        state: 'ok',
        discoveredCount: discovered,
        savedCount: saved,
        error: 'paused',
      });
    }
    const pageSize = Math.min(options.pageSize, cap - discovered);
    const page = await api.list(cursor, pageSize, deps.hostFetch);
    if (page === 'needs_signin') {
      return status(api.provider, {
        state: 'needs_signin',
        discoveredCount: discovered,
        savedCount: saved,
        error: 'Sign in to ChatGPT or Claude in this browser, then try again.',
      });
    }
    if (page.items.length === 0 && !page.nextCursor) {
      break;
    }
    for (const item of page.items) {
      if (discovered >= cap) {
        break;
      }
      discovered += 1;
      const previous = await deps.readUpdatedAt(api.provider, item.accountScope, item.id);
      if (previous && item.updatedAt && previous >= item.updatedAt) {
        continue;
      }
      await deps.delay(350);
      const conversation = await api.get(item, deps.hostFetch);
      if (conversation === 'needs_signin') {
        return status(api.provider, {
          state: 'needs_signin',
          discoveredCount: discovered,
          savedCount: saved,
          error: 'Sign in to ChatGPT or Claude in this browser, then try again.',
        });
      }
      if (conversation) {
        await deps.save(conversation);
        saved += 1;
      }
    }
    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
    await deps.delay(350);
  }
  return status(api.provider, { discoveredCount: discovered, savedCount: saved });
}
