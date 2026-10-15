import { getProviderHostFetch } from './run.ts';
import type { HostFetch } from './transport.ts';
import { claudeSyncApi } from '../../providers/claude/api.ts';
import { selectClaudeChatOrganizations } from '../../providers/claude/organizations.ts';
import { CLAUDE_ENABLED } from '../provider-features.ts';

const MAX_DEPTH = 10;
const MAX_KEYS = 80;
const SAFE_FIELDS = new Set('uuid id name title conversation conversation_id chat_messages messages content text parts type source url data media_type mime_type content_type file_type file_name filename file_kind file_uuid file_size extracted_content image_url download_url file_url preview_url thumbnail_url preview_asset thumbnail_asset asset_pointer attachments files input output command identifier artifact_id language old_str new_str created_at updated_at sender role parent_message_uuid current_leaf_message_uuid parent children author create_time update_time metadata mapping current_node linear_conversation model model_slug is_visually_hidden_from_conversation project project_uuid task_type chat_type size width height stop_reason status value result tool_use_id'.split(' '));
const SAFE_LABELS = new Set(['text', 'image', 'image_asset_pointer', 'file', 'attachment', 'artifact', 'tool_use', 'tool_result', 'thinking', 'artifacts', 'create', 'rewrite', 'update', 'base64', 'url', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'text/html', 'text/markdown', 'application/vnd.ant.code']);

/** Field names and kinds only, plus a fixed allowlist of non-personal type labels. */
export function redactStructure(value: unknown, depth = 0, parentKey = '', budget = { remaining: 1500 }): unknown {
  if (--budget.remaining < 0) return 'truncated';
  if (depth > MAX_DEPTH) return 'max_depth';
  if (value === null) return null;
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) {
    const samples: unknown[] = [];
    const seen = new Set<string>();
    for (const child of value.slice(0, 100)) {
      const sample = redactStructure(child, depth + 1, parentKey, budget);
      const signature = JSON.stringify(sample);
      if (!seen.has(signature)) { seen.add(signature); samples.push(sample); }
      if (samples.length >= 6 || budget.remaining < 0) break;
    }
    return { type: 'array', length: value.length, first: samples[0] ?? null, samples };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, MAX_KEYS);
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      const safeKey = parentKey === 'mapping' || !SAFE_FIELDS.has(key) ? `entry_${Object.keys(redacted).length}` : key;
      redacted[safeKey] = redactStructure(child, depth + 1, key, budget);
      if (['type', 'content_type', 'media_type', 'mime_type', 'name', 'command'].includes(key) && typeof child === 'string' && SAFE_LABELS.has(child)) redacted[`${safeKey}_label`] = child;
    }
    if (Object.keys(value).length > MAX_KEYS) redacted.__truncatedKeyCount = Object.keys(value).length;
    return redacted;
  }
  return typeof value;
}

function firstId(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstId(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length < 80) return candidate;
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === 'object') {
      const found = firstId(child, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function readJson(host: HostFetch, url: string): Promise<{ status: number; kind: 'json' | 'html' | 'empty' | 'other'; json: unknown | null }> {
  const response = await host(url);
  const trimmed = response.body.trim();
  const kind = !trimmed ? 'empty' : trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : trimmed.startsWith('<') ? 'html' : 'other';
  if (kind !== 'json') return { status: response.status, kind, json: null };
  try {
    return { status: response.status, kind, json: JSON.parse(response.body) as unknown };
  } catch {
    return { status: response.status, kind: 'other', json: null };
  }
}

function shapeOf(result: { status: number; kind: string; json: unknown | null }): { status: number; kind: string; shape: unknown } {
  return { status: result.status, kind: result.kind, shape: result.json === null ? null : redactStructure(result.json) };
}

async function claudeShapes(host: HostFetch): Promise<Record<string, unknown>> {
  const organizations = await readJson(host, 'https://claude.ai/api/organizations');
  const selection = selectClaudeChatOrganizations(organizations.json);
  const organizationSelection = { status: organizations.status, kind: organizations.kind, ...(selection ? selection.summary : { unreadable: true }) };
  try {
    const page = await claudeSyncApi.list(null, 1, host);
    if (page === 'needs_signin') return { organizationSelection, skipped: 'needs_signin' };
    const item = page.items[0];
    if (!item) return { organizationSelection, skipped: 'no_conversation' };
    const conversation = await readJson(host, `https://claude.ai/api/organizations/${encodeURIComponent(item.accountScope)}/chat_conversations/${encodeURIComponent(item.id)}`);
    return { organizationSelection, conversation: shapeOf(conversation), ...(page.warning ? { coverage: 'some_workspaces_unavailable' } : {}) };
  } catch {
    return { organizationSelection, error: 'unavailable' };
  }
}

async function chatGptShapes(host: HostFetch): Promise<Record<string, unknown>> {
  const list = await readJson(host, 'https://chatgpt.com/backend-api/conversations?offset=0&limit=1&order=updated');
  const conversationId = firstId(list.json, ['id']);
  if (!conversationId) return { list: shapeOf(list), conversation: { skipped: 'no_conversation' } };
  const conversation = await readJson(host, `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`);
  return { list: shapeOf(list), conversation: shapeOf(conversation) };
}

export async function collectRedactedShapes(): Promise<Record<string, unknown>> {
  const stored = await browser.storage.local.get('connectedProviders');
  const connected = Array.isArray(stored.connectedProviders) ? stored.connectedProviders.filter((item): item is string => typeof item === 'string') : [];
  const shapes: Record<string, unknown> = {};
  if (!CLAUDE_ENABLED || !connected.includes('claude')) shapes.claude = { skipped: 'not_connected' };
  else {
    try { shapes.claude = await claudeShapes(getProviderHostFetch('claude')); }
    catch { shapes.claude = { error: 'unavailable' }; }
  }
  if (!connected.includes('chatgpt')) shapes.chatgpt = { skipped: 'not_connected' };
  else {
    try { shapes.chatgpt = await chatGptShapes(getProviderHostFetch('chatgpt')); }
    catch { shapes.chatgpt = { error: 'unavailable' }; }
  }
  return shapes;
}

export async function exportSamplePayloads(): Promise<{ ok: boolean; message: string }> {
  try {
    return { ok: true, message: JSON.stringify(await collectRedactedShapes(), null, 2) };
  } catch {
    return { ok: false, message: 'Diagnostics could not be read. No conversation text was stored.' };
  }
}
