# Current-chat capture repair

Scope: grok.com manual capture, current-chat wording, and simpler healthy Claude connection controls. No automatic Grok capture, permission changes, authentication changes, or archive resets.

| Wave | Slice | Files (exclusive) | Owner / model / effort | Parallel |
| --- | --- | --- | --- | --- |
| 1 | Grok DOM reader | `extension/providers/grok/page-capture.ts` (create) | Luna / gpt-6-luna / high | With UI |
| 1 | UI wording and healthy connection | `extension/entrypoints/popup/Popup.tsx`, `extension/entrypoints/options/Workspace.tsx` | Luna / gpt-6-luna / medium | With reader |
| 2 | URL binding, command integration, checks and handoff | `extension/providers/grok/url.ts`, `extension/platform/commands.ts`, `extension/tests/unit/grok-capture.test.ts`, `extension/ui/verify.mjs`, `README.md`, this file | Parent / SOL | After review; tab identity and cross-file wiring need parent ownership |

## Grok reader steps

1. Create a self-contained exported `readVisibleGrokConversation(expectedUrl: string)` function in `extension/providers/grok/page-capture.ts`. It must work when serialized by `browser.scripting.executeScript`, with no imported or outer runtime helpers. Return null if location.href differs from expectedUrl before or after extraction. Otherwise return `{ turns: Array<{ role: 'user' | 'assistant' | null; text: string }>, text: string, truncated: boolean, title: string }`.
2. Find specific message roots across the document: `.message-bubble`, explicit user/assistant message test IDs or author-role attributes, then `.response-content-markdown` fallback. Do not depend on `<main>`, use whole-body text, or use alternating roles. Dedupe nested candidate roots and preserve document order.
3. Exclude hidden roots, navigation, sidebars, headers, footers, forms, editors, buttons, action bars, and loading controls. Extract visible prose/code with line breaks. Attribute speakers only using explicit role attributes/test IDs, `.message-bubble.user`, or the nearest response wrapper's items-end/items-start alignment. Unknown roles stay null.
4. Bound extraction to 500,000 characters and 500 roots; return an honest truncated flag when bounded. Empty pages return empty turns/text. Do not add network requests or dependencies.

## UI steps

1. Rename the popup action and busy state to `Save current chat` and `Saving current chat…`. Update popup empty guidance and options references to this action consistently.
2. On the Claude Connections row, treat a successful latest Claude probe as confirmed connection when there is no current actionable provider error. Show `Connected` for that healthy state. Keep `Site access enabled` for permission-only state. Show `Needs attention` for a failed latest probe or actionable provider error. History allowance and completed partial-workspace coverage alone are not connection failures.
3. In normal Connections UI, show `Check connection` only while checking, when unverified, or when there is an actionable connection problem. Hide it for a confirmed healthy connection. Keep it available in support mode. Keep Disconnect and existing failure recovery intact. Do not add controls, CSS, or diagnostics.

## Parent integration steps

1. Validate known Grok conversation routes and bind capture to the single active tab selected by Save current chat; reject route changes. Replace the old main-only extractor with the serializable reader. Preserve manual-only partial text capture and existing delivery behavior.
2. Add unit coverage for supported/unsupported URLs and trusted-command integration. Add isolated real-DOM coverage for current Grok markup outside main, role attribution, nested deduplication, UI exclusion, empty content, limits and route changes. Update existing UI assertions for wording and healthy/problem Claude controls.
3. Review actual Luna diffs, run typecheck, lint, unit tests, isolated UI journeys, build/ZIP and packaged extension tests. Update README wording, commit intended files only, push the private repository and provide an updated test ZIP.

## Verification and review

All planned steps are complete. No automatic Grok feature, permissions, authentication, destination configuration, or archive data were changed.

- Reader: Luna high, reviewed and resumed once for code indentation, linear ancestor deduplication, and filtering hidden roots before the limit. Final full-file review passed.
- UI: Luna medium, reviewed and resumed once to include successful import probes and distinguish stale history errors from current connection failures. Parent reconciled the existing support-only coverage badge after the UI gate caught that regression. Final diff review passed.
- Integration and verification: parent-owned because tab selection, navigation binding and cross-file command wiring require one owner. The save command selects the active tab once, checks the expected URL inside the injected reader, and rechecks that tab before ingestion. Trusted-provider pages cannot invoke the extension UI command.
- Plan coverage: reader, wording, connection states, URL binding, tests, README and test-package handoff done; no skipped implementation steps.

Gates on 2026-10-15: typecheck and lint passed; **274 unit tests in 33 files**, **39 isolated UI/DOM journeys**, and **2 packaged Chromium checks** passed. UI verification recorded no page errors or external requests. Production build and ZIP passed. The ZIP has 23 entries with manifest.json at its root and no test profiles, vaults or credentials.

The real-DOM fixtures verify serialized-function execution, Grok bubbles outside main, explicit test IDs, markdown fallback, deduplication, toolbar/hidden/sidebar exclusion, unknown speakers, code indentation, empty content, size/root limits and navigation changes. UI checks cover permission-only Claude state, healthy check/import state, failed checks, recovery, and a newer sign-in failure overriding an older success.

Test package: `Chatlog-test-2026-10-15-current-chat.zip`, SHA256 `22d5039e5ae0459adb9579648a26ca0491674f31b50a385b998d49a184675c4c`.

Live grok.com account verification remains a user check; synthetic fixtures do not establish live provider compatibility. Reload the extension, refresh a Grok chat, wait for its reply to finish, and choose **Save current chat**. Check the archive and local note. The capture remains text-only and partial; loading older messages before saving includes those rendered messages.

## Markup references

The user's MoveChat project has no Grok scraper to reuse. The Grok selector evidence comes from the [navigator's recorded live DOM structure](https://github.com/JoonJ14/ai-conversation-navigator/blob/main/DOM-REFERENCE.md), [enhanced exporter source history](https://github.com/iikoshteruu/enhanced-grok-export/blob/main/CHANGELOG.md), and [an independent Grok exporter](https://gist.github.com/mikesmullin/a1917c77dc1fd6c14bf5ba61e4d6166e). These are implementation references, not a provider API guarantee.
