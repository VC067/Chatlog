import { NotionError, notionRequest } from './api.ts';

export interface NotionProperty { id?: string; type: string; name?: string }
export interface NotionConfig {
  databaseId: string;
  dataSourceId: string;
  titleProperty: string;
  identityProperty: string;
  properties: Record<string, NotionProperty>;
}
export interface StoredNotionConfig extends NotionConfig { token: string }
const KEY = 'notion';
const STATUS_KEY = 'notionStatus';
const WRITING_UNVERIFIED = 'Database access and columns verified. Writing has not been verified yet; the first successful save will verify write access.';
const REQUIRED_PROPERTIES: Record<string, string> = {
  'Conversation ID': 'rich_text', Provider: 'rich_text', 'Source URL': 'url', Created: 'date', Updated: 'date', Tags: 'multi_select', Model: 'rich_text',
};
class MissingPropertiesError extends NotionError {
  constructor(public missingProperties: string[]) { super('missing_properties', `Create the archive columns: ${missingProperties.join(', ')}. No schema changes were made.`); }
}

export function parseNotionId(input: string): string | null {
  let value = input.trim();
  if (/^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/(^|\.)notion\.(com|so|site)$/.test(url.hostname)) return null;
      value = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    } catch { return null; }
  }
  const match = value.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  return match ? match[1]!.replaceAll('-', '').toLowerCase() : null;
}

export async function discoverNotion(token: string, parentId: string, parentType: 'database_id' | 'data_source_id' = 'database_id', createProperties = false): Promise<NotionConfig> {
  let databaseId = parentId;
  let dataSourceId = parentId;
  if (parentType === 'database_id') {
    const database = await notionRequest<{ id: string; data_sources?: Array<{ id: string }> }>(token, `databases/${encodeURIComponent(parentId)}`);
    if (database.data_sources?.length !== 1) throw new NotionError('notion_source_selection', 'Use a database with one data source, or supply the intended data source ID.');
    databaseId = database.id;
    dataSourceId = database.data_sources[0]!.id;
  }
  const source = await notionRequest<{ id: string; properties: Record<string, NotionProperty>; parent?: { database_id?: string } }>(token, `data_sources/${encodeURIComponent(dataSourceId)}`);
  let properties = source.properties;
  const missing = Object.keys(REQUIRED_PROPERTIES).filter((name) => !Object.keys(properties).some((key) => key.toLowerCase() === name.toLowerCase()));
  const incompatible = Object.entries(REQUIRED_PROPERTIES).filter(([name, type]) => Object.entries(properties).some(([key, prop]) => key.toLowerCase() === name.toLowerCase() && prop.type !== type));
  if (incompatible.length) throw new NotionError('notion_schema', `These existing columns have incompatible types: ${incompatible.map(([name]) => name).join(', ')}. Choose a separate archive database; existing columns were not changed.`);
  if (missing.length) {
    if (!createProperties) throw new MissingPropertiesError(missing);
    const additions = Object.fromEntries(missing.map((name) => [name, { [REQUIRED_PROPERTIES[name]!]: {} }]));
    const updated = await notionRequest<{ properties: Record<string, NotionProperty> }>(token, `data_sources/${encodeURIComponent(source.id)}`, 'PATCH', { properties: additions });
    properties = updated.properties;
  }
  const title = Object.entries(properties).find(([, prop]) => prop.type === 'title');
  const identity = Object.entries(properties).find(([name, prop]) => name.toLowerCase() === 'conversation id' && prop.type === 'rich_text');
  if (!title || !identity) throw new NotionError('notion_schema', 'Add a “Conversation ID” text property to this database. A title property and Conversation ID text property are required; no schema changes were made.');
  // Query access is required for safe reconciliation after an uncertain write.
  await notionRequest(token, `data_sources/${encodeURIComponent(source.id)}/query`, 'POST', { page_size: 1 });
  return { databaseId: source.parent?.database_id ?? databaseId, dataSourceId: source.id, titleProperty: title[1].id ?? title[0], identityProperty: identity[1].id ?? identity[0], properties };
}

export async function readNotionConfig(): Promise<StoredNotionConfig | null> {
  const stored = (await browser.storage.local.get(KEY))[KEY] as StoredNotionConfig | undefined;
  return stored?.token && stored.dataSourceId && stored.identityProperty && stored.titleProperty ? stored : null;
}

export async function configureNotion(input: { token: string; databaseId: string; createProperties?: boolean; parentType?: 'database_id' | 'data_source_id' }): Promise<{ ok: boolean; message: string; config?: NotionConfig; errorCode?: string; missingProperties?: string[] }> {
  const id = parseNotionId(input.databaseId);
  const token = input.token.trim();
  if (!id || !token || /\s/.test(token)) return { ok: false, message: 'Enter a valid Notion token and database URL or ID.' };
  try {
    const config = await discoverNotion(token, id, input.parentType ?? 'database_id', input.createProperties === true);
    await browser.storage.local.set({ [KEY]: { ...config, token }, [STATUS_KEY]: { state: 'connected', message: WRITING_UNVERIFIED } });
    return { ok: true, message: WRITING_UNVERIFIED, config };
  } catch (error) {
    const message = error instanceof NotionError ? error.message : 'Notion configuration could not be verified.';
    await browser.storage.local.set({ [STATUS_KEY]: { state: 'error', message } });
    return { ok: false, message, ...(error instanceof NotionError ? { errorCode: error.code } : {}), ...(error instanceof MissingPropertiesError ? { missingProperties: error.missingProperties } : {}) };
  }
}

export interface NotionStatus {
  state: 'disconnected' | 'connected' | 'error' | 'waiting';
  message: string | null;
  errorCode?: string;
  nextRetryAt?: string;
}
export async function readNotionStatus(): Promise<NotionStatus> {
  const stored = await browser.storage.local.get([KEY, STATUS_KEY, 'notionToken', 'notionParentId']);
  const status = stored[STATUS_KEY] as Partial<NotionStatus> | undefined;
  if (status?.state === 'error' || status?.state === 'waiting') return {
    state: status.state, message: status.message ?? 'Notion configuration needs attention.',
    ...(typeof status.errorCode === 'string' ? { errorCode: status.errorCode } : {}),
    ...(typeof status.nextRetryAt === 'string' && Number.isFinite(Date.parse(status.nextRetryAt)) ? { nextRetryAt: status.nextRetryAt } : {}),
  };
  if (await readNotionConfig()) return { state: 'connected', message: status?.state === 'connected' ? status.message ?? null : WRITING_UNVERIFIED };
  if (typeof stored.notionToken === 'string' || typeof stored.notionParentId === 'string') return { state: 'error', message: 'Legacy Notion settings need database validation. Reconnect to verify the source and archive columns; existing pages will be preserved.' };
  return { state: 'disconnected', message: null };
}

export async function recordNotionDeliveryStatus(success: boolean, error?: { errorCode?: string; message?: string; retryAfterMs?: number }, expected?: Pick<StoredNotionConfig, 'token' | 'dataSourceId'>): Promise<void> {
  // A queued result must not reconnect a destination that was disconnected while it ran.
  const current = await readNotionConfig();
  if (!current || expected && (current.token !== expected.token || current.dataSourceId !== expected.dataSourceId)) return;
  if (success) {
    await browser.storage.local.set({ [STATUS_KEY]: { state: 'connected', message: null } });
    return;
  }
  if (error?.retryAfterMs && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
    await browser.storage.local.set({ [STATUS_KEY]: {
      state: 'waiting', message: error.message ?? 'Notion delivery is waiting and will retry automatically. Your local archive is preserved.',
      errorCode: error.errorCode ?? 'rate_limited', nextRetryAt: new Date(Date.now() + error.retryAfterMs).toISOString(),
    } });
    return;
  }
  const accessError = ['unauthorized', 'restricted_resource', 'object_not_found', 'notion_401', 'notion_403', 'notion_404'].includes(error?.errorCode ?? '');
  const message = accessError
    ? 'Notion write access is unavailable. Check the connection token, database sharing, and read, insert and update content capabilities.'
    : error?.message ?? 'Notion could not save this conversation. Existing content was preserved; review the delivery status and retry when resolved.';
  await browser.storage.local.set({ [STATUS_KEY]: { state: 'error', message, ...(error?.errorCode ? { errorCode: error.errorCode } : {}) } });
}

/** Explicit recheck clears a local terminal stop, never the provider request cooldown. */
export async function clearNotionDeliveryIssue(): Promise<void> {
  if (!await readNotionConfig()) return;
  await browser.storage.local.set({ [STATUS_KEY]: { state: 'connected', message: WRITING_UNVERIFIED } });
}

export async function disconnectNotion(): Promise<void> {
  await browser.storage.local.remove([KEY, STATUS_KEY, 'notionToken', 'notionParentId', 'notionParentType']);
}
