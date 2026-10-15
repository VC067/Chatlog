# Claude organization selection and second-computer test

Date: October 15, 2026. Scope: capability-aware Claude organization selection, regression evidence and a private GitHub source handoff. No browser automation or changes to real chats, quotas or sign-in state.

## Evidence and limit

The user's report shows account access and history for one organization returning 200, while another organization returns 403 through extension and tab. Previously the adapter discarded all capability metadata and tried chat history for every organization UUID. A numbered diagnostic workspace is an internal ordinal, not proof of a second user-visible workspace.

Independent primary implementation evidence distinguishes chat-enabled organizations from API Console organizations by capabilities: [provider implementation](https://github.com/dineshkruplani/Claude-Usage-Badge-Extension/blob/main/src/providers/claude-web.ts), [author's captured findings](https://github.com/dineshkruplani/Claude-Usage-Badge-Extension/blob/main/docs/PHASE1-FINDINGS.md). This supports filtering explicit API-without-chat records. We have not read the user's live capability metadata, so this is a supported adapter correction, not yet proof of the cause in that account.

## Slice map

| Wave | Outcome | Exclusive files | Owner / model / effort |
| --- | --- | --- | --- |
| 0 | Conservative organization selector and safe diagnostic counts | providers/claude/organizations.ts; providers/claude/api.ts; core/sync/samples.ts | Parent SOL; account selection and privacy boundaries |
| 1 | Synthetic regressions | tests/unit/claude-organizations.test.ts; tests/unit/claude-history.test.ts; tests/unit/diagnostics-redact.test.ts | Luna / high; specified contract and behavior |
| Parallel audit | Source publication inventory, read only | No writes | Luna / medium |
| Final | README, ignore rules, test ZIP, private repository push and evidence | Root documentation and packaging | Parent SOL; publication and verified artifact boundary |

Snapshot of changed existing files: .local-backups/claude-capability-before-20261015.

## Verbatim test slice steps

1. Add claude-organizations.test.ts for selectClaudeChatOrganizations(payload). It accepts a direct array or {data: array}, returns null for invalid envelopes or nonempty arrays with no valid uuid, and returns {ids, summary: {total, chatEnabled, apiOnlySkipped, unknown}}. Only a nonempty all-string capabilities array containing api and not chat is excluded. Missing, empty, malformed or unfamiliar capabilities remain eligible as unknown. Chat plus api remains eligible. Duplicate UUIDs count once; chat wins over unknown and api_only, and unknown wins over api_only regardless of order. A legitimate empty list returns empty ids/counts.
2. Add claude-history.test.ts integration cases with mocked transport: chat and API-only organizations yield a successful check and real history import without claude_accounts_skipped; assert no history or conversation request uses the API-only UUID. Include two actual chat organizations where one returns 403 and retain the existing partial-coverage behavior. Add an all-API-only case that fails as unreadable without any history request, rather than reporting empty successful history. Preserve all existing tests and checkpoints/quota behavior.
3. Add diagnostics-redact.test.ts coverage for collectRedactedShapes using mocked getProviderHostFetch and synthetic organizations/payloads. Claude organizationSelection contains only status, kind and aggregate counts; UUIDs, names, email, token-like unknown capability labels and raw capability arrays must never appear. Assert counts remain available when a later history request fails. Preserve existing redaction tests. No live accounts, personal browser, real vault or network calls.

## User test after reload

Run Check connection once to produce a fresh report; old history reports remain historical until another history scan. If the warning persists, use Capture & history → Copy media diagnostic and share only the Claude organizationSelection counts plus the new connection report. Counts distinguish chat-enabled, API-only-skipped and unknown records without disclosing account IDs or names. An actual chat-capable or unknown organization returning 403 remains visible as partial coverage.

Second-computer installation starts with fresh browser-local storage. Sign into the same Claude account first to compare account behavior; using a different account tests a different case. Folder permission, Notion connection and license are configured separately on that computer and are not included in GitHub or the build ZIP.

## Review and gates

Parent reviewed the selector/API/diagnostic diffs and all three test files against the specified behavior. Luna's test slice passed after one bounded correction: an absent optional warning is undefined, not null. No production takeover was needed; parent owned the account-selection and diagnostic boundary from the start. All three test steps are complete. The read-only Luna publication audit found no real credential patterns in the selected source; token-like fixture strings are synthetic.

Gates passed: 245 unit tests across 32 files, TypeScript, lint, WXT production build/ZIP, and two packaged Chromium tests. The previous UI-only slice's 32 journeys remain separate evidence; no UI files changed in this correction. The test archive has 23 entries with manifest.json at its root and no local vault/profile/dependency paths. Live account capability classification and the two-computer comparison remain pending.

Publication includes root README/.gitignore, extension source/config/assets/tests/lockfile, and this focused document. Local vaults, profiles, build directories, other planning documents and the separately developed site are excluded. The ready-to-load ZIP is delivered as a private test release rather than committed generated output.
