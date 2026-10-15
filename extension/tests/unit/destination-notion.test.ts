import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import { buildConversation } from '../fixtures/factories.ts';
import { deliverNotion } from '../../destinations/notion/deliver.ts';
import { configureNotion, disconnectNotion, readNotionStatus, parseNotionId, recordNotionDeliveryStatus, type NotionConfig } from '../../destinations/notion/config.ts';
import { sanitizeDeliveryMapping } from '../../destinations/notion/mapping.ts';
import { readDelivery, saveDelivery } from '../../core/archive/repository.ts';
import { batchNotionBlocks, renderNotionBlocks, splitText } from '../../destinations/notion/render.ts';

// Client scheduling is exercised separately with a fake clock; these fixtures focus on write reconciliation.
vi.mock('../../destinations/notion/request-budget.ts', async (original) => ({
  ...await original<typeof import('../../destinations/notion/request-budget.ts')>(),
  waitForNotionRequest: async () => {}, rememberNotionCooldown: async () => {},
}));

const databaseId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const config: NotionConfig = { databaseId, dataSourceId: 'source-1', titleProperty: 'title-id', identityProperty: 'identity-id', properties: {
  Name: { id: 'title-id', type: 'title' }, 'Conversation ID': { id: 'identity-id', type: 'rich_text' }, Provider: { type: 'rich_text' },
  'Source URL': { type: 'url' }, Created: { type: 'date' }, Updated: { type: 'date' }, Tags: { type: 'multi_select' }, Model: { type: 'rich_text' },
} };
type Block = { id: string; type: string; [key: string]: unknown };
let blocks: Map<string, Block[]>;
let pages: Array<{ id: string }>;
let operations: string[];
let commitThenTimeout: 'page' | 'section' | null;
let storage: Record<string, unknown>;
let serial: number;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response { return new Response(JSON.stringify(body), { status, headers }); }
beforeEach(async () => {
  await deleteDB('vaultdraft');
  blocks = new Map([['page-1', []]]); pages = []; operations = []; commitThenTimeout = null; storage = {}; serial = 0;
  vi.stubGlobal('browser', { storage: { local: {
    get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, storage[name]])),
    set: async (value: Record<string, unknown>) => { Object.assign(storage, value); },
    remove: async (keys: string[]) => { for (const key of keys) delete storage[key]; },
  } } });
  vi.stubGlobal('fetch', vi.fn(async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    const path = url.pathname.replace('/v1/', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
    operations.push(`${method} ${path}`);
    if (path.startsWith('databases/')) return json({ id: databaseId, data_sources: [{ id: config.dataSourceId }] });
    if (path === `data_sources/${config.dataSourceId}`) {
      if (method === 'PATCH') config.properties = { ...config.properties, ...Object.fromEntries(Object.entries(body.properties as Record<string, Record<string, unknown>>).map(([name, value]) => [name, { type: Object.keys(value)[0]! }])) };
      return json({ id: config.dataSourceId, properties: config.properties });
    }
    if (path.endsWith('/query')) return json({ results: pages, has_more: false });
    if (path === 'pages' && method === 'POST') {
      pages.push({ id: 'page-1' });
      if (commitThenTimeout === 'page') { commitThenTimeout = null; throw new Error('timeout'); }
      return json({ id: 'page-1' });
    }
    if (path.startsWith('pages/')) return json({ id: 'page-1', parent: { type: 'data_source_id', data_source_id: config.dataSourceId } });
    if (path.endsWith('/children')) {
      const parent = path.split('/')[1]!;
      if (method === 'GET') return json({ results: blocks.get(parent) ?? [], has_more: false, next_cursor: null });
      const children = body.children as Array<{ type: string; toggle?: { rich_text: unknown[]; children?: Block[] } }>;
      const created = children.map((child) => {
        const id = `block-${++serial}`;
        if (child.type === 'toggle' && child.toggle) {
          const descendants = (child.toggle.children ?? []).map((nested) => ({ ...nested, id: `child-${++serial}`, has_children: false }));
          blocks.set(id, descendants);
          return { id, type: 'toggle', toggle: { rich_text: child.toggle.rich_text }, has_children: true };
        }
        blocks.set(id, []);
        return { ...child, id, has_children: false };
      });
      blocks.set(parent, [...(blocks.get(parent) ?? []), ...created]);
      if (commitThenTimeout === 'section') { commitThenTimeout = null; throw new Error('timeout'); }
      return json({ results: created });
    }
    if (method === 'DELETE') {
      const id = path.split('/')[1]!;
      for (const [parent, children] of blocks) blocks.set(parent, children.filter((block) => block.id !== id));
      return json({ id });
    }
    throw new Error('Unexpected fake API route');
  }));
});
afterEach(() => vi.unstubAllGlobals());
function deliver(overrides = {}) {
  return deliverNotion({ conversation: buildConversation(overrides), markdown: '', token: 'test-token', parentId: databaseId, parentType: 'database_id', pageId: null, config });
}

it('validates a discovered source and never returns the local token', async () => {
  const result = await configureNotion({ token: 'test-token', databaseId });
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain('test-token');
  expect(result.config?.titleProperty).toBe('title-id');
  expect((await readNotionStatus()).state).toBe('connected');
  expect((await readNotionStatus()).message).toContain('Writing has not been verified');
  await recordNotionDeliveryStatus(true);
  expect(await readNotionStatus()).toEqual({ state: 'connected', message: null });
  await disconnectNotion();
  expect(await readNotionStatus()).toEqual({ state: 'disconnected', message: null });
});
it('surfaces revoked write access, clears the error after successful delivery, and respects disconnection', async () => {
  await configureNotion({ token: 'test-token', databaseId });
  await recordNotionDeliveryStatus(false, { errorCode: 'restricted_resource', message: 'Access rejected' });
  expect(await readNotionStatus()).toMatchObject({ state: 'error' });
  expect((await readNotionStatus()).message).toContain('insert and update');
  await recordNotionDeliveryStatus(true);
  expect(await readNotionStatus()).toEqual({ state: 'connected', message: null });
  await disconnectNotion();
  await recordNotionDeliveryStatus(true);
  expect(await readNotionStatus()).toEqual({ state: 'disconnected', message: null });
});
it('shows a temporary wait separately from a terminal workspace limit', async () => {
  await configureNotion({ token: 'test-token', databaseId });
  await recordNotionDeliveryStatus(false, { errorCode: 'rate_limited', retryAfterMs: 61_000, message: 'Notion is waiting.' });
  const waiting = await readNotionStatus();
  expect(waiting).toMatchObject({ state: 'waiting', errorCode: 'rate_limited', message: 'Notion is waiting.' });
  expect(Date.parse(waiting.nextRetryAt!) - Date.now()).toBeGreaterThan(60_000);
  await recordNotionDeliveryStatus(false, { errorCode: 'notion_workspace_limit', message: 'Workspace block limit reached. Local archive is kept.' });
  expect(await readNotionStatus()).toEqual({ state: 'error', errorCode: 'notion_workspace_limit', message: 'Workspace block limit reached. Local archive is kept.' });
  await recordNotionDeliveryStatus(true);
  expect(await readNotionStatus()).toEqual({ state: 'connected', message: null });
});
it('does not apply a late delivery result to a different connected account', async () => {
  await configureNotion({ token: 'current-token', databaseId });
  const before = await readNotionStatus();
  await recordNotionDeliveryStatus(false, { errorCode: 'notion_workspace_limit', message: 'Old account limit.' }, { token: 'previous-token', dataSourceId: config.dataSourceId });
  expect(await readNotionStatus()).toEqual(before);
});
it('stores only hashes for managed text while legacy plaintext snapshots still match safely', async () => {
  await deliver();
  const conversation = buildConversation();
  const mapping = (await readDelivery(conversation.key, 'notion'))!;
  expect(JSON.stringify(mapping)).not.toContain('Hello');
  expect(mapping.notionManagedSections![0]!.children.every((child) => /^sha256:[a-f0-9]{64}$/.test(child.fingerprint))).toBe(true);
  const oldSection = mapping.notionManagedSections![0]!;
  const current = blocks.get('page-1')!.filter((block) => oldSection.children.some((child) => child.id === block.id));
  oldSection.children = current.map((block) => ({ id: block.id, fingerprint: JSON.stringify({ type: block.type, value: block[block.type], has_children: Boolean(block.has_children) }) }));
  expect(JSON.stringify(mapping)).toContain('Hello');
  await saveDelivery(mapping);
  expect((await deliver({ contentHash: 'replacement', title: 'Replacement', revision: 2 })).status).toBe('written');
  expect(operations).toContain(`DELETE blocks/${oldSection.id}`);
  expect(JSON.stringify(await readDelivery(conversation.key, 'notion'))).not.toContain('Hello');
});
it('sanitizes retained pointers and pending snapshots without keeping duplicate transcript text', async () => {
  const legacySection = { id: 'managed-id', marker: 'hash-only-marker', children: [{ id: 'child-id', fingerprint: '{"text":"PRIVATE_TRANSCRIPT_SENTINEL"}' }] };
  const mapping = {
    id: 'conversation\nnotion', conversationKey: 'conversation', destinationId: 'notion', revision: 2, externalId: 'page-id', contentHash: 'file-hash',
    notionDataSourceId: 'data-source', notionManagedSections: [legacySection],
    notionCheckpoint: { contentHash: 'revision-hash', revision: 3, sections: [legacySection], pendingMarker: 'pending-marker', creatingPage: false },
    unusedTranscript: 'PRIVATE_TRANSCRIPT_SENTINEL',
  };
  const sanitized = await sanitizeDeliveryMapping(mapping);
  expect(JSON.stringify(sanitized)).not.toContain('PRIVATE_TRANSCRIPT_SENTINEL');
  expect(sanitized).toMatchObject({ externalId: 'page-id', contentHash: 'file-hash', notionDataSourceId: 'data-source' });
  expect(sanitized.notionCheckpoint?.pendingMarker).toBe('pending-marker');
  expect(sanitized.notionManagedSections![0]!.children[0]!.fingerprint).toEqual(sanitized.notionCheckpoint!.sections[0]!.children[0]!.fingerprint);
  expect(await sanitizeDeliveryMapping(sanitized)).toEqual(sanitized);
  expect(JSON.stringify(mapping)).toContain('PRIVATE_TRANSCRIPT_SENTINEL');
});
it('rejects invalid tokens without reporting connected or exposing response details', async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => json({ code: 'unauthorized', message: 'Sensitive server detail' }, 401));
  const result = await configureNotion({ token: 'test-token', databaseId });
  expect(result).toMatchObject({ ok: false, errorCode: 'unauthorized' });
  expect(result.message).not.toContain('Sensitive');
  expect((await readNotionStatus()).state).toBe('error');
  expect(storage.notion).toBeUndefined();
});
it('supports explicit data-source IDs and official Notion URL variants', async () => {
  expect(parseNotionId(`https://www.notion.com/Archive-${databaseId}?v=ignored`)).toBe(databaseId);
  expect(parseNotionId(`https://example.com/${databaseId}`)).toBeNull();
  const sourceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  vi.mocked(fetch).mockImplementationOnce(async () => json({ id: sourceId, properties: config.properties, parent: { database_id: databaseId } }));
  expect((await configureNotion({ token: 'test-token', databaseId: sourceId, parentType: 'data_source_id' })).ok).toBe(true);
  expect(operations.some((op) => op.includes('databases/'))).toBe(false);
});
it('requests missing columns without modifying schema until explicitly enabled', async () => {
  const original = config.properties;
  config.properties = { Name: { id: 'title-id', type: 'title' } };
  try {
    const result = await configureNotion({ token: 'test-token', databaseId });
    expect(result).toMatchObject({ ok: false, errorCode: 'missing_properties' });
    expect(result.missingProperties).toContain('Conversation ID');
    expect(operations.some((op) => op.startsWith('PATCH'))).toBe(false);
    const setup = await configureNotion({ token: 'test-token', databaseId, createProperties: true });
    expect(operations).toContain('PATCH data_sources/source-1');
    expect(setup.ok).toBe(true);
    expect(setup.config?.identityProperty).toBe('Conversation ID');
  } finally { config.properties = original; }
});
it('retains long transcripts and respects all nested block and request limits', async () => {
  const conversation = buildConversation();
  conversation.messages[0]!.blocks = [{ type: 'code', language: 'ts', code: `${'😀long code\n'.repeat(30_000)}FINAL_SENTINEL` }];
  const rendered = renderNotionBlocks(conversation);
  expect(JSON.stringify(rendered)).toContain('FINAL_SENTINEL');
  expect(batchNotionBlocks(rendered).length).toBeGreaterThan(1);
  for (const batch of batchNotionBlocks(rendered)) {
    expect(batch.length + 1).toBeLessThanOrEqual(100);
    expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(500_000);
  }
  expect(splitText('😀'.repeat(5000)).every((text) => text.length <= 1800)).toBe(true);
});
it('keeps legacy and user content, and writes replacements before deleting managed content', async () => {
  blocks.set('page-1', [{ id: 'user-block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'User notes' } }] } }]);
  await saveDelivery({ id: `${buildConversation().key}\nnotion`, conversationKey: buildConversation().key, destinationId: 'notion', revision: 0, externalId: 'page-1', contentHash: 'legacy' });
  expect((await deliver()).status).toBe('written');
  const first = (await readDelivery(buildConversation().key, 'notion'))!;
  const oldId = first.notionManagedSections![0]!.id;
  operations = [];
  expect((await deliver({ title: 'Updated', contentHash: 'new', revision: 2 })).status).toBe('written');
  expect(operations.findIndex((op) => op === 'PATCH blocks/page-1/children')).toBeLessThan(operations.findIndex((op) => op === `DELETE blocks/${oldId}`));
  expect(blocks.get('page-1')?.some((block) => block.id === 'user-block')).toBe(true);
});
it('starts a fresh mapping for a confirmed legacy source change and preserves the old page', async () => {
  const conversation = buildConversation();
  await saveDelivery({ id: `${conversation.key}\nnotion`, conversationKey: conversation.key, destinationId: 'notion', revision: 1, externalId: 'page-1', contentHash: 'legacy' });
  blocks.set('page-1', [{ id: 'legacy-user-content', type: 'paragraph', paragraph: { rich_text: [] } }]);
  const oldBlocks = structuredClone(blocks.get('page-1'));
  const implementation = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (raw, init) => {
    const path = new URL(String(raw)).pathname.replace('/v1/', '');
    if (path === 'pages/page-1' && init?.method === 'GET') return json({ id: 'page-1', parent: { data_source_id: 'old-source' } });
    if (path === 'pages' && init?.method === 'POST') {
      operations.push('POST pages');
      blocks.set('page-2', []);
      return json({ id: 'page-2' });
    }
    return implementation(raw, init);
  });
  expect(await deliver()).toMatchObject({ status: 'written', pageId: 'page-2' });
  expect(blocks.get('page-1')).toEqual(oldBlocks);
  expect(operations).not.toContain('PATCH pages/page-1');
  expect(operations.some((op) => op.startsWith('DELETE'))).toBe(false);
  expect((await readDelivery(conversation.key, 'notion'))?.externalId).toBe('page-2');
});
it('keeps ambiguous or inaccessible legacy parents conservative instead of creating copies', async () => {
  const conversation = buildConversation();
  await saveDelivery({ id: `${conversation.key}\nnotion`, conversationKey: conversation.key, destinationId: 'notion', revision: 1, externalId: 'page-1', contentHash: 'legacy' });
  vi.mocked(fetch).mockImplementationOnce(async () => json({ id: 'page-1', parent: { page_id: 'unknown-page' } }));
  expect(await deliver()).toMatchObject({ status: 'failed', errorCode: 'notion_destination_mismatch' });
  expect(operations).not.toContain('POST pages');
  vi.mocked(fetch).mockImplementationOnce(async () => json({ code: 'restricted_resource' }, 403));
  expect(await deliver()).toMatchObject({ status: 'failed', errorCode: 'restricted_resource' });
  expect(operations).not.toContain('POST pages');
  expect((await readDelivery(conversation.key, 'notion'))?.externalId).toBe('page-1');
});
it('writes to a newly configured source without changing the old destination page', async () => {
  await deliver();
  const oldMapping = (await readDelivery(buildConversation().key, 'notion'))!;
  const oldSections = structuredClone(blocks.get('page-1'));
  const implementation = vi.mocked(fetch).getMockImplementation()!;
  operations = [];
  vi.mocked(fetch).mockImplementation(async (raw, init) => {
    const path = new URL(String(raw)).pathname.replace('/v1/', '');
    if (path === 'data_sources/new-source/query') {
      operations.push('POST data_sources/new-source/query');
      return json({ results: [], has_more: false });
    }
    if (path === 'pages' && init?.method === 'POST') {
      operations.push('POST pages');
      expect(JSON.parse(init.body as string).parent).toEqual({ type: 'data_source_id', data_source_id: 'new-source' });
      blocks.set('page-2', []);
      return json({ id: 'page-2' });
    }
    return implementation(raw, init);
  });
  const result = await deliverNotion({ conversation: buildConversation(), markdown: '', token: 'test-token', parentId: databaseId, parentType: 'database_id', pageId: oldMapping.externalId, config: { ...config, dataSourceId: 'new-source' } });
  expect(result).toMatchObject({ status: 'written', pageId: 'page-2' });
  expect(blocks.get('page-1')).toEqual(oldSections);
  expect(operations).not.toContain('PATCH pages/page-1');
  expect(operations.some((operation) => operation.startsWith('DELETE'))).toBe(false);
  expect((await readDelivery(buildConversation().key, 'notion'))?.notionDataSourceId).toBe('new-source');
});
it('preserves additions inside old managed sections', async () => {
  await deliver();
  const mapping = (await readDelivery(buildConversation().key, 'notion'))!;
  const oldId = mapping.notionManagedSections![0]!.id;
  const edited = blocks.get('page-1')!.find((block) => block.type === 'paragraph');
  edited!.paragraph = { rich_text: [{ text: { content: 'edited by hand' } }] };
  const result = await deliver({ contentHash: 'new', revision: 2, title: 'Updated' });
  expect(result.status).toBe('written');
  expect(operations).not.toContain(`DELETE blocks/${oldId}`);
  expect(blocks.get('page-1')?.some((block) => block.id === edited!.id)).toBe(true);
});
it('leaves a previously delivered revision untouched after the user edits its section', async () => {
  await deliver();
  const sectionId = (await readDelivery(buildConversation().key, 'notion'))!.notionManagedSections![0]!.id;
  blocks.get(sectionId)!.push({ id: 'user-added', type: 'paragraph', paragraph: { rich_text: [] } });
  operations = [];
  expect((await deliver()).status).toBe('written');
  expect(operations).toHaveLength(0);
  expect(blocks.get(sectionId)?.some((block) => block.id === 'user-added')).toBe(true);
});
it('reconciles uncertain page creation by stable conversation identity without duplicates', async () => {
  commitThenTimeout = 'page';
  expect((await deliver()).status).toBe('retry');
  expect((await deliver()).status).toBe('written');
  expect(operations.filter((op) => op === 'POST pages')).toHaveLength(1);
});
it('reconciles a committed append after timeout and restart without duplicate sections', async () => {
  commitThenTimeout = 'section';
  expect((await deliver()).status).toBe('retry');
  expect((await deliver()).status).toBe('written');
  expect(operations.filter((op) => op === 'PATCH blocks/page-1/children')).toHaveLength(1);
  expect((await readDelivery(buildConversation().key, 'notion'))?.notionCheckpoint).toBeNull();
});
it('waits for Retry-After and permits a rejected batch to retry without duplicating content', async () => {
  const implementation = vi.mocked(fetch).getMockImplementation()!;
  let limited = false;
  vi.mocked(fetch).mockImplementation(async (raw, init) => {
    if (!limited && String(raw).endsWith('/blocks/page-1/children') && init?.method === 'PATCH') { limited = true; return json({ code: 'rate_limited' }, 429, { 'Retry-After': '125' }); }
    return implementation(raw, init);
  });
  expect(await deliver()).toMatchObject({ status: 'retry', retryAfterMs: 125_000 });
  expect((await readDelivery(buildConversation().key, 'notion'))?.notionCheckpoint?.pendingMarker).toBeNull();
  expect((await deliver()).status).toBe('written');
  expect(blocks.get('page-1')?.length).toBeGreaterThan(1);
});
it('keeps old content through a failed multi-batch replacement and resumes confirmed batches', async () => {
  await deliver();
  const oldId = (await readDelivery(buildConversation().key, 'notion'))!.notionManagedSections![0]!.id;
  const conversation = buildConversation({ revision: 2, contentHash: 'large-new' });
  conversation.messages[0]!.blocks = [{ type: 'text', text: 'full content '.repeat(30_000) }];
  const input = { conversation, markdown: '', token: 'test-token', parentId: databaseId, parentType: 'database_id' as const, pageId: null, config };
  const implementation = vi.mocked(fetch).getMockImplementation()!;
  let appended = 0;
  vi.mocked(fetch).mockImplementation(async (raw, init) => {
    if (String(raw).endsWith('/blocks/page-1/children') && init?.method === 'PATCH' && ++appended === 2) return json({ code: 'restricted_resource' }, 403);
    return implementation(raw, init);
  });
  operations = [];
  expect((await deliverNotion(input)).status).toBe('failed');
  expect(operations).not.toContain(`DELETE blocks/${oldId}`);
  expect((await readDelivery(conversation.key, 'notion'))!.notionCheckpoint!.sections).toHaveLength(1);
  vi.mocked(fetch).mockImplementation(implementation);
  expect((await deliverNotion(input)).status).toBe('written');
  expect(operations).toContain(`DELETE blocks/${oldId}`);
  const rendered = renderNotionBlocks(conversation);
  expect(blocks.get('page-1')).toHaveLength(rendered.length + batchNotionBlocks(rendered).length);
});
it('does not mutate remote content after ownership is lost', async () => {
  const result = await deliverNotion({ conversation: buildConversation(), markdown: '', token: 'test-token', parentId: databaseId, parentType: 'database_id', pageId: null, config, assertLease: async () => { throw new Error('lease lost'); } });
  expect(result.status).toBe('failed');
  expect(operations).toHaveLength(0);
});
it('does not create a page when stable identity resolves to multiple pages', async () => {
  pages = [{ id: 'first' }, { id: 'second' }];
  expect(await deliver()).toMatchObject({ status: 'failed', errorCode: 'notion_duplicate_identity' });
  expect(operations).not.toContain('POST pages');
});
it('does not repeat an ambiguous write that cannot be confirmed', async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => json({ results: [], has_more: false }));
  vi.mocked(fetch).mockImplementationOnce(async () => { throw new Error('uncommitted timeout'); });
  expect((await deliver()).status).toBe('retry');
  const result = await deliver();
  expect(result).toMatchObject({ status: 'failed', errorCode: 'notion_write_uncertain' });
  expect(operations.filter((op) => op === 'POST pages')).toHaveLength(0);
});
