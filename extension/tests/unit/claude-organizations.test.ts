import { expect, it } from 'vitest';
import { selectClaudeChatOrganizations } from '../../providers/claude/organizations.ts';

it('accepts direct arrays and data envelopes and reports conservative capability counts', () => {
  const organizations = [
    { uuid: 'chat', capabilities: ['chat'] },
    { uuid: 'api', capabilities: ['api'] },
    { uuid: 'both', capabilities: ['api', 'chat'] },
    { uuid: 'missing' },
    { uuid: 'empty', capabilities: [] },
    { uuid: 'malformed', capabilities: ['api', 7] },
    { uuid: 'unfamiliar', capabilities: ['future-capability-token'] },
  ];
  const expected = {
    ids: ['chat', 'both', 'missing', 'empty', 'malformed', 'unfamiliar'],
    summary: { total: 7, chatEnabled: 2, apiOnlySkipped: 1, unknown: 4 },
  };
  expect(selectClaudeChatOrganizations(organizations)).toEqual(expected);
  expect(selectClaudeChatOrganizations({ data: organizations })).toEqual(expected);
});

it('returns null for invalid envelopes and nonempty arrays without a valid UUID', () => {
  expect(selectClaudeChatOrganizations(null)).toBeNull();
  expect(selectClaudeChatOrganizations({ data: 'not an array' })).toBeNull();
  expect(selectClaudeChatOrganizations({})).toBeNull();
  expect(selectClaudeChatOrganizations([{ uuid: '' }, { uuid: 3 }, null])).toBeNull();
});

it('counts duplicate UUIDs once and resolves metadata conflicts independent of order', () => {
  const rows = [
    { uuid: 'api-then-unknown', capabilities: ['api'] },
    { uuid: 'api-then-unknown', capabilities: ['future'] },
    { uuid: 'unknown-then-api', capabilities: ['future'] },
    { uuid: 'unknown-then-api', capabilities: ['api'] },
    { uuid: 'api-then-chat', capabilities: ['api'] },
    { uuid: 'api-then-chat', capabilities: ['chat'] },
    { uuid: 'chat-then-api', capabilities: ['chat'] },
    { uuid: 'chat-then-api', capabilities: ['api'] },
    { uuid: 'duplicates', capabilities: ['api'] },
    { uuid: 'duplicates', capabilities: ['api'] },
  ];
  expect(selectClaudeChatOrganizations(rows)).toEqual({
    ids: ['api-then-unknown', 'unknown-then-api', 'api-then-chat', 'chat-then-api'],
    summary: { total: 5, chatEnabled: 2, apiOnlySkipped: 1, unknown: 2 },
  });
});

it('returns a valid empty selection for a legitimate empty list', () => {
  expect(selectClaudeChatOrganizations([])).toEqual({
    ids: [], summary: { total: 0, chatEnabled: 0, apiOnlySkipped: 0, unknown: 0 },
  });
  expect(selectClaudeChatOrganizations({ data: [] })).toEqual({
    ids: [], summary: { total: 0, chatEnabled: 0, apiOnlySkipped: 0, unknown: 0 },
  });
});
