import { conversationKey } from '../../core/contracts/conversation.ts';
import { readSettings } from '../../core/settings.ts';
import { fetchRespectingRateLimit, ProviderRequestError, type HostFetch } from '../../core/sync/transport.ts';
import type { ListedChat, SyncApi } from '../../core/sync/engine.ts';
import { conversationFromClaude, providerDate } from '../shared/normalize.ts';
import { selectClaudeChatOrganizations } from './organizations.ts';

function jsonBody(response: { status: number; body: string }): unknown {
  if (response.status === 403 || response.body.trim().startsWith('<')) throw new ProviderRequestError('blocked');
  try { return JSON.parse(response.body); }
  catch { throw new ProviderRequestError('unreadable'); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readCursor(cursor: string | null, orgs: string[]) {
  const offsets: Record<string, number> = Object.create(null);
  let exhausted: string[] = [];
  if (cursor?.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(cursor); } catch { throw new ProviderRequestError('unreadable'); }
    if (!object(parsed) || !object(parsed.offsets) || !Array.isArray(parsed.exhausted) ||
      !parsed.exhausted.every((value) => typeof value === 'string') ||
      !Object.values(parsed.offsets).every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) {
      throw new ProviderRequestError('unreadable');
    }
    Object.assign(offsets, parsed.offsets);
    exhausted = [...new Set(parsed.exhausted as string[])];
  } else if (cursor) {
    if (!/^\d+:\d+$/.test(cursor)) throw new ProviderRequestError('unreadable');
    const [index, offset] = cursor.split(':').map(Number);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || index! > orgs.length) throw new ProviderRequestError('unreadable');
    exhausted = orgs.slice(0, index);
    if (orgs[index!]) offsets[orgs[index!]!] = offset!;
  }
  return { offsets, exhausted };
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return cleaned || 'project';
}

interface ClaudeRow {
  uuid?: unknown;
  name?: unknown;
  updated_at?: unknown;
  project_uuid?: unknown;
  project?: { name?: unknown; uuid?: unknown };
  task_type?: unknown;
  chat_type?: unknown;
}

function listedFrom(row: ClaudeRow, accountScope: string): ListedChat | null {
  if (typeof row.uuid !== 'string') {
    return null;
  }
  const projectName =
    typeof row.project?.name === 'string'
      ? row.project.name
      : null;
  const projectId =
    typeof row.project?.uuid === 'string'
      ? row.project.uuid
      : typeof row.project_uuid === 'string'
        ? row.project_uuid
        : null;
  return {
    id: row.uuid,
    title: typeof row.name === 'string' && row.name.trim() ? row.name : 'Untitled',
    updatedAt: providerDate(row.updated_at),
    accountScope,
    projectName,
    projectSlug: projectId ? `${projectName ? slug(projectName) + '-' : ''}${projectId}` : projectName ? slug(projectName) : null,
  };
}

async function organizations(hostFetch: HostFetch): Promise<string[] | 'needs_signin'> {
  const response = await fetchRespectingRateLimit(hostFetch, 'https://claude.ai/api/organizations');
  if (response.status === 401) {
    return 'needs_signin';
  }
  const selection = selectClaudeChatOrganizations(jsonBody(response));
  if (!selection || selection.summary.total > 0 && !selection.ids.length) throw new ProviderRequestError('unreadable');
  return selection.ids;
}

export const claudeSyncApi: SyncApi = {
  provider: 'claude',
  async list(cursor, limit, hostFetch) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ProviderRequestError('unreadable');
    const orgs = await organizations(hostFetch);
    if (orgs === 'needs_signin') {
      return 'needs_signin';
    }
    const { offsets, exhausted } = readCursor(cursor, orgs);
    const settings = await readSettings();
    const denied: Array<{ orgId: string; status: number }> = [];
    const pages: Array<{ orgId: string; rows: ClaudeRow[]; ended: boolean; candidates: Array<{ item: ListedChat; index: number }> }> = [];
    for (const orgId of orgs) {
      if (exhausted.includes(orgId)) continue;
      const rows: ClaudeRow[] = [];
      const candidates: Array<{ item: ListedChat; index: number }> = [];
      let ended = false;
      // Fill each organization's candidate page before merging dates across accounts.
      // Filtered rows must not hide a newer eligible chat on the following page.
      while (candidates.length < limit && !ended) {
        const response = await fetchRespectingRateLimit(hostFetch, `https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/chat_conversations?limit=${limit}&offset=${(offsets[orgId] ?? 0) + rows.length}`);
        if ([401, 403, 404].includes(response.status) || response.body.trim().startsWith('<')) {
          denied.push({ orgId, status: response.status });
          break;
        }
        const json = jsonBody(response);
        const batch = Array.isArray(json) ? json : object(json) ? json.chat_conversations ?? json.data : null;
        if (!Array.isArray(batch) || !batch.every(object)) throw new ProviderRequestError('unreadable');
        const base = rows.length;
        rows.push(...batch);
        batch.forEach((row, index) => {
          const kind = typeof row.task_type === 'string' ? row.task_type : typeof row.chat_type === 'string' ? row.chat_type : '';
          if (!settings.saveCowork && kind.toLowerCase() === 'cowork') return;
          const item = listedFrom(row, orgId); if (item) candidates.push({ item, index: base + index });
        });
        ended = batch.length < limit;
      }
      if (denied.some((entry) => entry.orgId === orgId)) continue;
      pages.push({ orgId, rows, candidates, ended });
    }
    if (denied.length && denied.length === orgs.length) {
      if (denied.every((entry) => entry.status === 401)) return 'needs_signin';
      throw new ProviderRequestError('blocked');
    }
    const chosen = pages.flatMap((page) => page.candidates).sort((a, b) => (b.item.updatedAt ?? '').localeCompare(a.item.updatedAt ?? '') || a.item.id.localeCompare(b.item.id)).slice(0, limit);
    for (const page of pages) {
      const selected = chosen.filter((candidate) => candidate.item.accountScope === page.orgId);
      const allSelected = selected.length === page.candidates.length;
      const consumed = allSelected ? page.rows.length : selected.length ? Math.max(...selected.map((candidate) => candidate.index)) + 1 : page.candidates[0]?.index ?? page.rows.length;
      offsets[page.orgId] = (offsets[page.orgId] ?? 0) + consumed;
      if (allSelected && page.ended) {
        exhausted.push(page.orgId);
      }
    }
    return {
      items: chosen.map((candidate) => candidate.item),
      nextCursor: orgs.every((orgId) => exhausted.includes(orgId) || denied.some((entry) => entry.orgId === orgId)) ? null : JSON.stringify({ offsets, exhausted }),
      ...(denied.length ? { warning: 'claude_accounts_skipped' as const } : {}),
    };
  },
  async get(item, hostFetch) {
    const response = await fetchRespectingRateLimit(
      hostFetch,
      `https://claude.ai/api/organizations/${encodeURIComponent(item.accountScope)}/chat_conversations/${encodeURIComponent(item.id)}`,
    );
    if (response.status === 401) {
      return 'needs_signin';
    }
    if (response.status === 403 || response.body.trim().startsWith('<')) throw new ProviderRequestError('blocked');
    if (!response.ok) {
      return null;
    }
    try {
      const payload = JSON.parse(response.body) as ClaudeRow;
      const settings = await readSettings();
      if (!settings.saveCowork && (payload.task_type === 'cowork' || payload.chat_type === 'cowork')) return null;
      const conversation = conversationFromClaude(payload, `https://claude.ai/chat/${item.id}`);
      if (!conversation || conversation.sourceId !== item.id) {
        return null;
      }
      return {
        ...conversation,
        key: conversationKey('claude', item.accountScope, conversation.sourceId),
        accountScope: item.accountScope,
        sourceUrl: `https://claude.ai/chat/${conversation.sourceId}`,
        title: conversation.title === 'Untitled' ? item.title : conversation.title,
        updatedAt: conversation.updatedAt ?? item.updatedAt,
        projectName: item.projectName,
        projectSlug: item.projectSlug,
      };
    } catch {
      return null;
    }
  },
};

/** A visible page exposes its chat UUID, but not its organization. */
export async function readVisibleClaudeChat(id: string, host: HostFetch) {
  const orgs = await organizations(host);
  if (orgs === 'needs_signin') return orgs;
  let denied = false;
  let signedOut = 0;
  for (const accountScope of orgs) {
    try {
      const conversation = await claudeSyncApi.get({ id, accountScope, title: 'Untitled', updatedAt: null, projectName: null, projectSlug: null }, host);
      if (conversation === 'needs_signin') signedOut += 1;
      else if (conversation) return conversation;
    } catch (error) {
      if (error instanceof ProviderRequestError && error.code === 'blocked') denied = true;
      else throw error;
    }
  }
  if (orgs.length > 0 && signedOut === orgs.length) return 'needs_signin';
  if (denied) throw new ProviderRequestError('blocked');
  return null;
}
