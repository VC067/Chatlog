import { archivedConversationSchema, type ArchivedConversation } from '../contracts/conversation.ts';
import { deliveryJobSchema, type DeliveryJob } from '../contracts/jobs.ts';
import { openVaultDb, type CaptureCheckpoint, type DeliveryMapping } from '../storage/db.ts';
import { sanitizeDeliveryMapping } from '../../destinations/notion/mapping.ts';

async function withDatabase<T>(
  work: (database: Awaited<ReturnType<typeof openVaultDb>>) => Promise<T>,
): Promise<T> {
  const database = await openVaultDb();
  try {
    return await work(database);
  } finally {
    database.close();
  }
}

export async function upsertConversation(
  input: ArchivedConversation,
): Promise<ArchivedConversation> {
  const parsed = archivedConversationSchema.parse(input);
  return withDatabase(async (database) => {
    const tx = database.transaction('conversations', 'readwrite');
    const existing = await tx.store.get(parsed.key);
    const next = !existing || existing.contentHash !== parsed.contentHash
      ? {
          ...parsed,
          revision: existing ? existing.revision + 1 : parsed.revision,
        }
      : existing;
    if (!existing || existing.contentHash !== parsed.contentHash) {
      await tx.store.put(next);
    }
    await tx.done;
    return archivedConversationSchema.parse(next);
  });
}

export async function listConversations(
  provider: ArchivedConversation['provider'],
  accountScope: string,
): Promise<ArchivedConversation[]> {
  return withDatabase(async (database) => {
    const rows = await database.getAllFromIndex('conversations', 'by-account', [
      provider,
      accountScope,
    ]);
    return rows.map((row) => archivedConversationSchema.parse(row));
  });
}

export async function commitConversationWithJobs(
  input: ArchivedConversation,
  destinationIds: readonly string[],
): Promise<{ conversation: ArchivedConversation; changed: boolean }> {
  const parsed = archivedConversationSchema.parse(input);
  return withDatabase(async (database) => {
    const tx = database.transaction(['conversations', 'jobs'], 'readwrite');
    const conversations = tx.objectStore('conversations');
    const jobs = tx.objectStore('jobs');
    const existing = await conversations.get(parsed.key);
    if (existing?.contentHash === parsed.contentHash) {
      await tx.done;
      return { conversation: archivedConversationSchema.parse(existing), changed: false };
    }
    const next = archivedConversationSchema.parse({
      ...parsed,
      revision: existing ? existing.revision + 1 : Math.max(1, parsed.revision),
      capturedAt: existing?.capturedAt ?? parsed.capturedAt,
    });
    await conversations.put(next);
    for (const job of await jobs.getAll()) {
      if (job.conversationKey === next.key && job.revision < next.revision && job.state !== 'running' && job.state !== 'completed') {
        await jobs.put({ ...job, state: 'completed', errorCode: 'superseded', leaseOwner: null, leaseExpiresAt: null });
      }
    }
    for (const destinationId of new Set(destinationIds)) {
      await jobs.put(deliveryJobSchema.parse({
        id: `${destinationId}:${next.key}:${next.revision}`,
        conversationKey: next.key, revision: next.revision, destinationId,
        operation: 'upsert', state: 'pending', attempts: 0,
        nextEligibleAt: null, leaseOwner: null, leaseExpiresAt: null,
        checkpoint: null, errorCode: null,
      }));
    }
    await tx.done;
    return { conversation: next, changed: true };
  });
}

export async function saveConversationAndJob(
  input: ArchivedConversation,
  jobInput: DeliveryJob,
): Promise<void> {
  const conversation = archivedConversationSchema.parse(input);
  const job = deliveryJobSchema.parse(jobInput);
  await withDatabase(async (database) => {
    const tx = database.transaction(['conversations', 'jobs'], 'readwrite');
    await tx.objectStore('conversations').put(conversation);
    await tx.objectStore('jobs').put(job);
    await tx.done;
  });
}

export async function readConversation(
  key: string,
): Promise<ArchivedConversation | null> {
  return withDatabase(async (database) => {
    const row = await database.get('conversations', key);
    return row ? archivedConversationSchema.parse(row) : null;
  });
}

export async function readJob(id: string): Promise<DeliveryJob | null> {
  return withDatabase(async (database) => {
    const row = await database.get('jobs', id);
    return row ? deliveryJobSchema.parse(row) : null;
  });
}

export async function saveCapture(checkpoint: CaptureCheckpoint): Promise<void> {
  await withDatabase(async (database) => {
    await database.put('captures', checkpoint);
  });
}

export async function saveDelivery(mapping: DeliveryMapping): Promise<void> {
  await withDatabase(async (database) => {
    await database.put('deliveries', mapping);
  });
}

export async function readDelivery(
  conversationKey: string,
  destinationId: string,
): Promise<DeliveryMapping | null> {
  return withDatabase(async (database) => {
    const row = await database.get('deliveries', `${conversationKey}\n${destinationId}`);
    return row ?? null;
  });
}

export function isJunkConversation(conversation: ArchivedConversation): boolean {
  try {
    return /^\/(?:api|backend-api)(?:\/|$)/.test(new URL(conversation.sourceUrl).pathname);
  } catch {
    return true;
  }
}

export async function purgeJunkConversations(): Promise<number> {
  return withDatabase(async (database) => {
    const tx = database.transaction(['conversations', 'jobs', 'deliveries'], 'readwrite');
    const rows = await tx.objectStore('conversations').getAll();
    const removed = new Set<string>();
    for (const row of rows) {
      const parsed = archivedConversationSchema.safeParse(row);
      if (parsed.success && isJunkConversation(parsed.data)) {
        await tx.objectStore('conversations').delete(parsed.data.key);
        removed.add(parsed.data.key);
      }
    }
    for (const job of await tx.objectStore('jobs').getAll()) {
      if (removed.has(job.conversationKey)) {
        await tx.objectStore('jobs').delete(job.id);
      }
    }
    for (const delivery of await tx.objectStore('deliveries').getAll()) {
      if (removed.has(delivery.conversationKey)) {
        await tx.objectStore('deliveries').delete(delivery.id);
      }
    }
    await tx.done;
    return removed.size;
  });
}

export async function clearArchive(): Promise<void> {
  await withDatabase(async (database) => {
    // Preserve only safe destination references so re-importing cannot duplicate exports.
    // Hashing happens before the write transaction to avoid closing it across crypto awaits.
    const mappings = await Promise.all((await database.getAll('deliveries')).map(sanitizeDeliveryMapping));
    const tx = database.transaction(
      ['conversations', 'jobs', 'deliveries', 'captures', 'imports', 'metadata'],
      'readwrite',
    );
    await Promise.all([
      tx.objectStore('conversations').clear(),
      tx.objectStore('jobs').clear(),
      tx.objectStore('captures').clear(),
      tx.objectStore('imports').clear(),
    ]);
    for (const mapping of mappings) await tx.objectStore('deliveries').put(mapping);
    for (const item of await tx.objectStore('metadata').getAll()) {
      if (item.key.startsWith('capture-signal:') || item.key.startsWith('markdown-incoming:')) {
        await tx.objectStore('metadata').delete(item.key);
      }
    }
    await tx.done;
  });
}

export async function listWrittenConversationKeys(): Promise<Set<string>> {
  return withDatabase(async (database) => {
    const rows = await database.getAll('deliveries');
    const keys = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const record = row as { destinationId?: unknown; conversationKey?: unknown; externalId?: unknown };
      if (
        record.destinationId === 'markdown' &&
        typeof record.conversationKey === 'string' &&
        typeof record.externalId === 'string' &&
        record.externalId.endsWith('.md')
      ) {
        keys.add(record.conversationKey);
      }
    }
    return keys;
  });
}

export async function listRecentConversations(): Promise<ArchivedConversation[]> {
  return withDatabase(async (database) => {
    const rows = await database.getAll('conversations');
    const parsed: ArchivedConversation[] = [];
    for (const row of rows) {
      const result = archivedConversationSchema.safeParse(row);
      if (result.success) {
        parsed.push(result.data);
      }
    }
    parsed.sort((left, right) => (left.capturedAt < right.capturedAt ? 1 : -1));
    return parsed;
  });
}

export async function listJobs(): Promise<DeliveryJob[]> {
  return withDatabase(async (database) => {
    const rows = await database.getAll('jobs');
    const parsed: DeliveryJob[] = [];
    for (const row of rows) {
      const result = deliveryJobSchema.safeParse(row);
      if (result.success) {
        parsed.push(result.data);
      }
    }
    return parsed;
  });
}

export async function saveJob(jobInput: DeliveryJob): Promise<void> {
  const job = deliveryJobSchema.parse(jobInput);
  await withDatabase(async (database) => {
    await database.put('jobs', job);
  });
}

export async function claimJob(
  id: string,
  nowIso: string,
  leaseUntilIso: string,
): Promise<DeliveryJob | null> {
  return withDatabase(async (database) => {
    const tx = database.transaction('jobs', 'readwrite');
    const existing = await tx.store.get(id);
    const leaseExpired =
      existing?.state === 'running' &&
      (existing.leaseExpiresAt === null || existing.leaseExpiresAt <= nowIso);
    const ready =
      existing?.state === 'pending' ||
      existing?.state === 'retry_wait' ||
      leaseExpired;
    const due = existing?.nextEligibleAt === null || (typeof existing?.nextEligibleAt === 'string' && existing.nextEligibleAt <= nowIso);
    if (!existing || !ready || !due) {
      await tx.done;
      return null;
    }
    const next = deliveryJobSchema.parse({
      ...existing,
      state: 'running',
      leaseOwner: crypto.randomUUID(),
      leaseExpiresAt: leaseUntilIso,
      attempts: existing.attempts + 1,
    });
    await tx.store.put(next);
    await tx.done;
    return next;
  });
}

export async function finishClaimedJob(job: DeliveryJob, patch: Partial<DeliveryJob>): Promise<boolean> {
  return withDatabase(async (database) => {
    const tx = database.transaction('jobs', 'readwrite');
    const current = await tx.store.get(job.id);
    if (!current || current.state !== 'running' || current.leaseOwner !== job.leaseOwner) {
      await tx.done;
      return false;
    }
    await tx.store.put(deliveryJobSchema.parse({ ...current, ...patch, leaseOwner: null, leaseExpiresAt: null }));
    await tx.done;
    return true;
  });
}

export async function renewClaimedJob(job: DeliveryJob, leaseUntilIso: string): Promise<boolean> {
  return withDatabase(async (database) => {
    const tx = database.transaction('jobs', 'readwrite');
    const current = await tx.store.get(job.id);
    if (!current || current.state !== 'running' || current.leaseOwner !== job.leaseOwner) {
      await tx.done;
      return false;
    }
    await tx.store.put({ ...current, leaseExpiresAt: leaseUntilIso });
    await tx.done;
    return true;
  });
}
