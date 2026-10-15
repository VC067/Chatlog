type Capability = 'chat' | 'api_only' | 'unknown';

export interface ClaudeOrganizationSelection {
  ids: string[];
  summary: { total: number; chatEnabled: number; apiOnlySkipped: number; unknown: number };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only an explicit API capability without chat is enough to exclude a record. */
export function selectClaudeChatOrganizations(payload: unknown): ClaudeOrganizationSelection | null {
  const rows = Array.isArray(payload) ? payload : object(payload) && Array.isArray(payload.data) ? payload.data : null;
  if (!rows) return null;
  const organizations = new Map<string, Capability>();
  for (const row of rows) {
    if (!object(row) || typeof row.uuid !== 'string' || !row.uuid.length) continue;
    const capabilities = row.capabilities;
    const known = Array.isArray(capabilities) && capabilities.length > 0 && capabilities.every((value) => typeof value === 'string');
    const capability: Capability = known && capabilities.includes('chat') ? 'chat'
      : known && capabilities.includes('api') ? 'api_only' : 'unknown';
    const previous = organizations.get(row.uuid);
    // Conflicting duplicate metadata must never hide a possible chat organization.
    if (!previous || capability === 'chat' || previous === 'api_only' && capability === 'unknown') organizations.set(row.uuid, capability);
  }
  if (rows.length && !organizations.size) return null;
  const ids: string[] = [];
  const summary = { total: organizations.size, chatEnabled: 0, apiOnlySkipped: 0, unknown: 0 };
  for (const [id, capability] of organizations) {
    if (capability === 'api_only') summary.apiOnlySkipped += 1;
    else {
      ids.push(id);
      if (capability === 'chat') summary.chatEnabled += 1;
      else summary.unknown += 1;
    }
  }
  return { ids, summary };
}
