import type { ArchivedConversation } from '../../core/contracts/conversation.ts';
import { readDelivery, saveDelivery } from '../../core/archive/repository.ts';
import { sha256Hex } from '../../core/archive/hash.ts';
import type { DeliveryMapping } from '../../core/storage/db.ts';
import { listBlockChildren, notionRequest, NotionError, type ApiBlock } from './api.ts';
import { discoverNotion, type NotionConfig } from './config.ts';
import { batchNotionBlocks, renderNotionBlocks, richText } from './render.ts';
import { hashManagedFingerprint, sanitizeDeliveryMapping } from './mapping.ts';

type Section = NonNullable<DeliveryMapping['notionManagedSections']>[number];
export interface NotionDeliveryResult {
  status: 'written' | 'retry' | 'failed';
  pageId?: string;
  retryAfterMs?: number;
  errorCode?: string;
  message?: string;
}
function markerOf(block: ApiBlock): string {
  const content = block[block.type] as { rich_text?: Array<{ text?: { content?: string } }> } | undefined;
  return content?.rich_text?.map((text) => text.text?.content ?? '').join('') ?? '';
}
function fingerprint(block: ApiBlock): string {
  return JSON.stringify({ type: block.type, value: block[block.type], has_children: Boolean(block.has_children) });
}
function intendedFingerprint(block: { type: string; [key: string]: unknown }): string {
  const value = block[block.type] as { rich_text?: Array<{ type?: string; text?: { content?: string; link?: { url: string } | null }; annotations?: Record<string, unknown> }>; language?: string; expression?: string };
  const rich = value.rich_text?.map((item) => ({
    type: item.type ?? 'text', content: item.text?.content ?? '', link: item.text?.link?.url ?? null,
    annotations: Object.entries(item.annotations ?? {}).filter(([key, annotation]) => annotation !== false && !(key === 'color' && annotation === 'default')).sort(([a], [b]) => a.localeCompare(b)),
  }));
  return JSON.stringify({ type: block.type, rich, language: value.language, expression: value.expression, has_children: Boolean(block.has_children) });
}
function pageProperties(config: NotionConfig, conversation: ArchivedConversation): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [config.titleProperty]: { title: richText(conversation.title) },
    [config.identityProperty]: { rich_text: richText(conversation.key) },
  };
  const model = [...new Set(conversation.messages.map((message) => message.model).filter(Boolean))].join(', ');
  for (const [name, property] of Object.entries(config.properties)) {
    const key = property.id ?? name;
    const normalized = name.toLowerCase();
    if (normalized === 'provider' && property.type === 'rich_text') properties[key] = { rich_text: richText(conversation.provider) };
    if (normalized === 'source url' && property.type === 'url' && conversation.sourceUrl.length <= 2000) properties[key] = { url: conversation.sourceUrl };
    if (normalized === 'created' && property.type === 'date') properties[key] = { date: conversation.createdAt ? { start: conversation.createdAt } : null };
    if (normalized === 'updated' && property.type === 'date') properties[key] = { date: { start: conversation.updatedAt ?? conversation.capturedAt } };
    if (normalized === 'model' && property.type === 'rich_text') properties[key] = { rich_text: richText(model) };
    if (normalized === 'tags' && property.type === 'multi_select') properties[key] = { multi_select: [{ name: `capture/${conversation.provider}` }] };
  }
  return properties;
}
async function findPage(token: string, config: NotionConfig, key: string): Promise<string | null> {
  const response = await notionRequest<{ results: Array<{ id: string }>; has_more: boolean }>(token, `data_sources/${encodeURIComponent(config.dataSourceId)}/query`, 'POST', {
    filter: { property: config.identityProperty, rich_text: { equals: key } }, page_size: 2,
  });
  if (response.results.length > 1 || response.has_more) throw new NotionError('notion_duplicate_identity', 'Multiple Notion pages have this conversation identity. Resolve them before saving.');
  return response.results[0]?.id ?? null;
}

export interface NotionDeliveryInput {
  conversation: ArchivedConversation;
  markdown: string;
  token: string;
  parentId: string;
  parentType: 'database_id' | 'data_source_id';
  pageId: string | null;
  config?: NotionConfig;
  assertLease?: () => Promise<void>;
}
const active = new Set<string>();
export async function deliverNotion(input: NotionDeliveryInput): Promise<NotionDeliveryResult> {
  if (active.has(input.conversation.key)) return { status: 'retry', retryAfterMs: 1000, errorCode: 'notion_busy', message: 'This conversation is already being saved to Notion.' };
  active.add(input.conversation.key);
  try { return await deliverNotionOwned(input); } finally { active.delete(input.conversation.key); }
}
async function deliverNotionOwned(input: NotionDeliveryInput): Promise<NotionDeliveryResult> {
  let mapping: DeliveryMapping | null = null;
  const persist = async () => { await input.assertLease?.(); await saveDelivery(mapping!); };
  try {
    const config = input.config ?? await discoverNotion(input.token, input.parentId, input.parentType);
    const storedMapping = await readDelivery(input.conversation.key, 'notion');
    const prior = storedMapping ? await sanitizeDeliveryMapping(storedMapping) : null;
    const sameSource = !prior?.notionDataSourceId || prior.notionDataSourceId === config.dataSourceId;
    mapping = sameSource && prior ? prior : {
      id: `${input.conversation.key}\nnotion`, conversationKey: input.conversation.key, destinationId: 'notion',
      revision: 0, externalId: null, contentHash: '',
    };
    if (!mapping.externalId && sameSource && input.pageId) mapping.externalId = input.pageId;
    if (mapping.externalId && !prior?.notionDataSourceId) {
      // Old mappings did not record destination identity. Verify their page parent before adopting them.
      const page = await notionRequest<{ parent?: { data_source_id?: string; database_id?: string } }>(input.token, `pages/${encodeURIComponent(mapping.externalId)}`);
      const normalizeId = (id: string) => id.replaceAll('-', '').toLowerCase();
      const compatible = page.parent?.data_source_id ? normalizeId(page.parent.data_source_id) === normalizeId(config.dataSourceId)
        : page.parent?.database_id ? normalizeId(page.parent.database_id) === normalizeId(config.databaseId) : false;
      if (!compatible) {
        if (!page.parent?.data_source_id && !page.parent?.database_id) throw new NotionError('notion_destination_mismatch', 'The legacy mapped page belongs to an unverified Notion destination. Its content was preserved.');
        // The old source is confirmed and differs from the validated new destination.
        // Start a new mapping; no old page or managed section is updated or removed.
        mapping = {
          id: `${input.conversation.key}\nnotion`, conversationKey: input.conversation.key, destinationId: 'notion',
          revision: 0, externalId: null, contentHash: '',
        };
      }
    }
    mapping.notionDataSourceId = config.dataSourceId;
    const legacyToggle = (mapping.notionManagedSections ?? []).some((section) => section.marker.startsWith('Chat archive ·'));
    if (!legacyToggle && mapping.externalId && !mapping.notionCheckpoint && mapping.notionManagedSections && mapping.contentHash === input.conversation.contentHash && mapping.revision === input.conversation.revision) {
      await persist();
      return { status: 'written', pageId: mapping.externalId };
    }
    const blocks = renderNotionBlocks(input.conversation);
    const batches = batchNotionBlocks(blocks);
    const contentHash = await sha256Hex(JSON.stringify({ blocks, title: input.conversation.title }));
    if (mapping.notionCheckpoint && mapping.notionCheckpoint.contentHash !== contentHash) {
      if (mapping.notionCheckpoint.creatingPage && !mapping.externalId) {
        mapping.externalId = await findPage(input.token, config, input.conversation.key);
        if (!mapping.externalId) throw new NotionError('notion_write_uncertain', 'A previous page creation could not yet be confirmed. No duplicate page was created.');
        mapping.notionCheckpoint.creatingPage = false;
      }
      if (mapping.notionCheckpoint.pendingMarker) {
        if (!mapping.externalId) throw new NotionError('notion_write_uncertain', 'A previous Notion write needs reconciliation.');
        const pending = (await listBlockChildren(input.token, mapping.externalId)).filter((block) => markerOf(block) === mapping!.notionCheckpoint!.pendingMarker);
        if (pending.length !== 1) throw new NotionError('notion_write_uncertain', 'A previous Notion write could not be uniquely confirmed. Existing content was preserved.');
        // Its original payload is unavailable for this newer revision. Preserve this section forever rather than adopting unknown edits.
        mapping.notionCheckpoint.sections.push({ id: pending[0]!.id, marker: mapping.notionCheckpoint.pendingMarker, children: [] });
        mapping.notionCheckpoint.pendingMarker = null;
      }
      mapping.notionManagedSections = [...(mapping.notionManagedSections ?? []), ...mapping.notionCheckpoint.sections];
      mapping.notionCheckpoint = null;
    }
    if (!mapping.notionCheckpoint) {
      mapping.notionCheckpoint = { contentHash, revision: input.conversation.revision, sections: [], pendingMarker: null, creatingPage: false };
      await persist();
    }
    const checkpoint = mapping.notionCheckpoint;
    const properties = pageProperties(config, input.conversation);
    if (Object.values(properties).some((property) => {
      const item = property as { title?: unknown[]; rich_text?: unknown[] };
      return (item.title?.length ?? item.rich_text?.length ?? 0) > 100;
    })) throw new NotionError('notion_property_limit', 'A title or identity exceeds Notion’s property limits. The full transcript remains in your local archive.');
    if (!mapping.externalId) {
      mapping.externalId = await findPage(input.token, config, input.conversation.key);
      if (!mapping.externalId) {
        if (checkpoint.creatingPage) throw new NotionError('notion_write_uncertain', 'A page creation timed out and could not yet be confirmed. No duplicate page was created.');
        checkpoint.creatingPage = true;
        await persist();
        try {
          await input.assertLease?.();
          const page = await notionRequest<{ id: string }>(input.token, 'pages', 'POST', {
            parent: { type: 'data_source_id', data_source_id: config.dataSourceId }, properties,
          });
          mapping.externalId = page.id;
        } catch (error) {
          if (error instanceof NotionError && !error.uncertain) { checkpoint.creatingPage = false; await persist(); }
          throw error;
        }
      }
      checkpoint.creatingPage = false;
      await persist();
    }
    const pageId = mapping.externalId;
    await input.assertLease?.();
    await notionRequest(input.token, `pages/${encodeURIComponent(pageId)}`, 'PATCH', { properties });
    const existing = await listBlockChildren(input.token, pageId);
    for (let index = checkpoint.sections.length; index < batches.length; index += 1) {
      const marker = `${input.conversation.title} · ${index + 1}/${batches.length}`;
      const expected = [{ object: 'block', type: 'heading_2', heading_2: { rich_text: richText(marker) } }, ...batches[index]!];
      const candidates = existing.filter((block) => markerOf(block) === marker);
      if (candidates.length > 1) throw new NotionError('notion_duplicate_section', 'Duplicate managed sections were found. Existing content was preserved.');
      let created: ApiBlock[];
      const start = candidates[0] ? existing.findIndex((block) => block.id === candidates[0]?.id) : -1;
      if (start >= 0) {
        created = existing.slice(start, start + expected.length);
      } else {
        if (checkpoint.pendingMarker === marker) throw new NotionError('notion_write_uncertain', 'A content write timed out and could not yet be confirmed. Existing content was preserved.');
        checkpoint.pendingMarker = marker;
        await persist();
        try {
          await input.assertLease?.();
          const appended = await notionRequest<{ results: ApiBlock[] }>(input.token, `blocks/${encodeURIComponent(pageId)}/children`, 'PATCH', {
            children: expected,
          });
          const ids = new Set(appended.results.map((block) => block.id));
          created = (await listBlockChildren(input.token, pageId)).filter((block) => ids.has(block.id));
          if (!created.length) throw new NotionError('notion_write_uncertain', 'Notion did not confirm the new section.', 30_000, true);
        } catch (error) {
          if (error instanceof NotionError && !error.uncertain) { checkpoint.pendingMarker = null; await persist(); }
          throw error;
        }
      }
      if (created.length !== expected.length || created.some((block, offset) => intendedFingerprint(block) !== intendedFingerprint(expected[offset]!))) throw new NotionError('notion_section_changed', 'A managed section differs from the intended content. It was preserved for review.');
      checkpoint.sections.push({ id: created[0]!.id, marker, children: await Promise.all(created.map(async (block) => ({ id: block.id, fingerprint: await hashManagedFingerprint(fingerprint(block)) }))) });
      checkpoint.pendingMarker = null;
      await persist();
    }
    const preserved: Section[] = [];
    for (const section of mapping.notionManagedSections ?? []) {
      if (checkpoint.sections.some((fresh) => fresh.id === section.id)) continue;
      const parent = existing.find((block) => block.id === section.id);
      if (!parent) continue;
      if (parent.type === 'toggle') {
        const children = await listBlockChildren(input.token, section.id);
        const actualFingerprints = await Promise.all(children.map((block) => hashManagedFingerprint(fingerprint(block))));
        const unchanged = markerOf(parent) === section.marker && children.length === section.children.length && children.every((block, index) => block.id === section.children[index]?.id && actualFingerprints[index] === section.children[index]?.fingerprint);
        if (!unchanged) { preserved.push(section); continue; }
        await input.assertLease?.();
        await notionRequest(input.token, `blocks/${encodeURIComponent(section.id)}`, 'DELETE');
        continue;
      }
      const byId = new Map(existing.map((block) => [block.id, block]));
      const actual = await Promise.all(section.children.map(async (child) => {
        const block = byId.get(child.id);
        return Boolean(block) && await hashManagedFingerprint(fingerprint(block!)) === child.fingerprint;
      }));
      if (!section.children.length || actual.some((match) => !match)) { preserved.push(section); continue; }
      for (const child of section.children) {
        await input.assertLease?.();
        await notionRequest(input.token, `blocks/${encodeURIComponent(child.id)}`, 'DELETE');
      }
    }
    mapping.notionManagedSections = [...preserved, ...checkpoint.sections];
    mapping.notionCheckpoint = null;
    mapping.revision = input.conversation.revision;
    mapping.contentHash = input.conversation.contentHash;
    await persist();
    return { status: 'written', pageId, ...(preserved.length ? { message: 'New archive content saved. Edited older sections were preserved.' } : {}) };
  } catch (error) {
    const known = error instanceof NotionError ? error : null;
    return {
      status: known?.retryAfterMs ? 'retry' : 'failed',
      ...(mapping?.externalId ? { pageId: mapping.externalId } : {}),
      ...(known?.retryAfterMs ? { retryAfterMs: known.retryAfterMs } : {}),
      errorCode: known?.code ?? 'notion_failed', message: known?.message ?? 'Notion delivery failed. Existing content was preserved.',
    };
  }
}
