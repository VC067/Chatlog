import type { Provider } from '../contracts/conversation.ts';

export type SyncState = 'idle' | 'running' | 'ok' | 'needs_signin' | 'error';

export interface SyncProviderStatus {
  provider: Provider;
  state: SyncState;
  lastRunAt: string | null;
  discoveredCount: number;
  savedCount: number;
  error: string | null;
}

export interface SyncRunResult {
  provider: Provider;
  status: SyncProviderStatus;
  stoppedBecause: 'complete' | 'needs_signin' | 'rate_limited' | 'error' | null;
}
