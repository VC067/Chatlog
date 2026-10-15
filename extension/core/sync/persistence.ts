import { openVaultDb } from '../storage/db.ts';
import type { ImportSession } from '../contracts/jobs.ts';
import type { SyncApi, ListedChat } from './engine.ts';
import { conversationKey } from '../contracts/conversation.ts';

export const IMPORT_LEASE_MS = 60_000;
export async function readImportSessions(): Promise<ImportSession[]> {
  const db = await openVaultDb();
  try { return await db.getAll('imports'); } finally { db.close(); }
}

export async function claimImport(provider: SyncApi['provider'], options: { maxItems: number | null; manual?: boolean }, resume = false): Promise<ImportSession | null> {
  const db = await openVaultDb();
  try {
    const tx = db.transaction('imports', 'readwrite');
    const id = `history:${provider}`;
    const old = await tx.store.get(id);
    const now = Date.now();
    if (old && ((old.leaseExpiresAt && Date.parse(old.leaseExpiresAt) > now) || (old.nextEligibleAt && Date.parse(old.nextEligibleAt) > now) || (resume && old.state !== 'running'))) {
      await tx.done; return null;
    }
    const active = old && (old.state === 'running' || old.state === 'paused');
    const session: ImportSession = active ? { ...old, state: 'running', manual: options.manual ?? old.manual } : {
      id, provider, accountScope: 'multiple', state: 'running', discoveredCount: 0, completedCount: 0,
      checkpoint: { cursor: null, pending: [], exhausted: false }, maxItems: options.maxItems, manual: options.manual ?? false,
    };
    session.leaseOwner = crypto.randomUUID();
    session.leaseExpiresAt = new Date(now + IMPORT_LEASE_MS).toISOString();
    session.nextEligibleAt = null;
    session.error = null;
    await tx.store.put(session); await tx.done; return session;
  } finally { db.close(); }
}

export async function checkpointImport(session: ImportSession, release = false): Promise<boolean> {
  const db = await openVaultDb();
  try {
    const tx = db.transaction('imports', 'readwrite');
    const current = await tx.store.get(session.id);
    if (!current || current.leaseOwner !== session.leaseOwner) { await tx.done; return false; }
    // A pause command takes effect at the next checkpoint without being overwritten.
    if (current.state === 'paused') {
      session.state = 'paused';
      // A reset/pause may have cleared an earlier error while a request was in
      // flight. Keep the durable paused status, but honor a newly returned 429.
      if (session.error !== 'rate_limited') {
        session.error = current.error;
        session.nextEligibleAt = current.nextEligibleAt;
      }
    }
    session.leaseExpiresAt = release ? null : new Date(Date.now() + IMPORT_LEASE_MS).toISOString();
    if (release) session.leaseOwner = null;
    await tx.store.put(session); await tx.done; return true;
  } finally { db.close(); }
}

export async function setImportPause(paused: boolean, provider?: SyncApi['provider']): Promise<void> {
  const db = await openVaultDb();
  try {
    const tx = db.transaction('imports', 'readwrite');
    for (const item of await tx.store.getAll()) {
      if ((!provider || item.provider === provider) && (item.state === 'running' || item.state === 'paused' || (!paused && item.state === 'failed'))) {
        // An explicit retry continues the existing page, without bypassing a provider's
        // rate limit or the lease of an in-flight request.
        await tx.store.put(paused ? { ...item, state: 'paused' } : {
          ...item,
          state: 'running',
          error: item.error === 'rate_limited' ? item.error : null,
          nextEligibleAt: item.error === 'rate_limited' ? item.nextEligibleAt : null,
        });
      }
    }
    await tx.done;
  } finally { db.close(); }
}

/** Clear temporary failures without discarding an unfinished import or its lease. */
export async function resetImportFailure(provider: SyncApi['provider']): Promise<void> {
  const db = await openVaultDb();
  try {
    const tx = db.transaction('imports', 'readwrite');
    const item = await tx.store.get(`history:${provider}`);
    if (item && (item.state === 'running' || item.state === 'paused' || item.state === 'failed')) {
      await tx.store.put({
        ...item,
        state: 'paused',
        error: item.error === 'rate_limited' ? item.error : 'paused',
        nextEligibleAt: item.error === 'rate_limited' ? item.nextEligibleAt : null,
      });
    }
    await tx.done;
  } finally { db.close(); }
}

/** Count the persistent history ledger, independently of live chats and disk files. */
export async function readHistoryUsage(): Promise<Array<{ provider: 'chatgpt' | 'claude'; used: number }>> {
  const db = await openVaultDb();
  try {
    return await Promise.all((['chatgpt', 'claude'] as const).map(async (provider) => {
      const record = await db.get('metadata', `history-ledger:${provider}`);
      const keys: unknown = record ? JSON.parse(record.value) : [];
      return { provider, used: Array.isArray(keys) ? new Set(keys.filter((key) => typeof key === 'string')).size : 0 };
    }));
  } finally { db.close(); }
}

/** Reserve before ingest so a worker death between save and checkpoint cannot bypass the cap. */
export async function admitHistory(provider: SyncApi['provider'], item: ListedChat, limit: number | null): Promise<boolean> {
  if (limit === null) return true;
  const db = await openVaultDb();
  try {
    const tx = db.transaction(['metadata', 'conversations'], 'readwrite');
    const key = conversationKey(provider, item.accountScope, item.id);
    const ledgerKey = `history-ledger:${provider}`;
    const record = await tx.objectStore('metadata').get(ledgerKey);
    const keys = record ? JSON.parse(record.value) as string[] : [];
    if (keys.includes(key) || await tx.objectStore('conversations').get(key)) { await tx.done; return true; }
    if (keys.length >= limit) { await tx.done; return false; }
    await tx.objectStore('metadata').put({ key: ledgerKey, value: JSON.stringify([...keys, key]) });
    await tx.done; return true;
  } finally { db.close(); }
}

export interface ScheduledCapture { provider: SyncApi['provider']; accountScope: string; conversationId: string; dueAt: number; attempts: number; generation: string; }
const CAPTURE_PREFIX = 'capture-signal:';
export async function discardDisconnectedCaptures(connected: string[]): Promise<void> {
  const db = await openVaultDb();
  try {
    const tx = db.transaction('metadata', 'readwrite');
    for (const row of await tx.store.getAll()) {
      if (!row.key.startsWith(CAPTURE_PREFIX)) continue;
      const signal = JSON.parse(row.value) as ScheduledCapture;
      if (!connected.includes(signal.provider)) await tx.store.delete(row.key);
    }
    await tx.done;
  } finally { db.close(); }
}
export async function persistCapture(signal: Omit<ScheduledCapture, 'dueAt' | 'attempts' | 'generation'>): Promise<void> {
  const db = await openVaultDb();
  try { await db.put('metadata', { key: `${CAPTURE_PREFIX}${conversationKey(signal.provider, signal.accountScope, signal.conversationId)}`, value: JSON.stringify({ ...signal, dueAt: Date.now() + 5000, attempts: 0, generation: crypto.randomUUID() }) }); }
  finally { db.close(); }
}

export async function readScheduledCaptures(): Promise<Array<{ key: string; signal: ScheduledCapture }>> {
  const db = await openVaultDb();
  try {
    const tx = db.transaction('metadata', 'readwrite');
    const due: Array<{ key: string; signal: ScheduledCapture }> = [];
    for (const row of await tx.store.getAll()) {
      if (!row.key.startsWith(CAPTURE_PREFIX)) continue;
      const signal = JSON.parse(row.value) as ScheduledCapture;
      if (signal.dueAt > Date.now()) continue;
      due.push({ key: row.key, signal });
      // Persist the lease before network I/O; another wake cannot claim the same signal.
      await tx.store.put({ ...row, value: JSON.stringify({ ...signal, dueAt: Date.now() + IMPORT_LEASE_MS }) });
    }
    await tx.done; return due;
  }
  finally { db.close(); }
}

export async function finishCapture(key: string, signal: ScheduledCapture, success: boolean, retryAt?: number): Promise<void> {
  const db = await openVaultDb();
  try {
    const tx = db.transaction('metadata', 'readwrite');
    const row = await tx.store.get(key);
    if (row && (JSON.parse(row.value) as ScheduledCapture).generation === signal.generation) {
      if (success) await tx.store.delete(key);
      else await tx.store.put({ key, value: JSON.stringify({ ...signal, attempts: signal.attempts + 1, dueAt: retryAt ?? Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(signal.attempts, 7)) }) });
    }
    await tx.done;
  } finally { db.close(); }
}
