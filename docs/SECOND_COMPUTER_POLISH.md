# Second-computer product polish

October 15, 2026. User confirmed five Claude history saves on the Mac. ChatGPT found five chats but returned a rate-limit wait, not a sign-in refusal. Claude media is missing from Markdown written to the selected local folder. Keep provider cooldowns, saved chats, license/history ledgers and user-edited files intact. No personal-browser automation.

## Workflow and ownership

- [x] Analyze reported UI and source paths; separate cooldown from authentication.
- [x] Publish the slice map and shared control contract.
- [x] Wave 0 custom select, then diff review.
- [x] Wave 1 workspace polish and icon assets, then diff review.
- [x] Parent media repair based on documented explicit fields; no invented download endpoints.
- [x] Integration UI/behavior coverage and production ZIP. Private GitHub test update follows the packaged-runtime gate.

| Wave | Slice | Exclusive files | Owner / effort | Parallel |
| --- | --- | --- | --- | --- |
| 0 | Accessible custom dropdown | ui/Select.tsx; ui/select.css | Luna high | With parent media investigation |
| 1 | Normal product UI, provider import controls and logo | options/Workspace.tsx; options/workspace.css; public/icon-{16,32,48,128}.png | Luna high | After control review; with parent media |
| Parent | Media/transport investigation and verified repair | providers/shared/normalize.ts; Claude media adapter as needed; Markdown media code; core/sync/samples.ts; corresponding focused unit tests | Parent SOL; request/identity/file boundaries | Disjoint from UI |
| Final | UI journeys, review, source/release packaging | ui/verify.mjs; README; this document | Parent SOL | After implementations |

Design: preserve the existing mint/white/teal identity. Colors: page #f5f8f6, surface #ffffff, ink #182923, muted #52645d, teal #007b72, selected #e2f3ee. DM Sans remains the typeface. Controls align with search rows, reserve a 16px right inset for a drawn chevron and use a theme-matched menu. Selected items use a quiet teal state and checkmark. Motion only answers opening/selection and respects reduced motion. Existing layout/theme tokens take precedence over a redesign.

## Wave 0 verbatim steps

1. Create ui/Select.tsx exporting Select and SelectOption. Props: id?: string; label: string; value: string; options: readonly SelectOption[] where SelectOption is {value: string; label: string}; disabled?: boolean; onChange: (value: string) => void; className?: string. Import ./select.css. Implement a custom button role=combobox with aria-label, aria-expanded, aria-controls, aria-haspopup=listbox and aria-activedescendant while open. Render a role=listbox with role=option children and aria-selected. No native select or external packages.
2. Support pointer selection, ArrowUp/ArrowDown, Home/End, Enter/Space to open/commit, Escape to dismiss, Tab dismissal without trapping focus, outside pointer dismissal, and printable-character typeahead. Keep focus on the trigger while using active-descendant; scroll the active option into view. A disabled control cannot open or change. Prop value/options updates stay synchronized and never emit changes automatically. Empty lists are safe. Close on focus leaving the whole control and on disable.
3. Style with existing --surface/--text/--border/--blue/--blue-soft/--muted theme tokens. Give trigger min-height 44px, clear focus ring, 16px right inset, separate chevron, and truncation without overlap. Position menu below with z-index, bounded height and scrolling; current selection shows a checkmark. Support both themes and reduced motion. Keep CSS scoped to .custom-select classes. Do not modify existing consumers or tests in this wave.

## Wave 1 verbatim steps

1. Import Select from ../../ui/Select.tsx and replace all four native selects in Workspace.tsx (archive provider filter, archive sort, recent-count preference, background interval) with this component, preserving labels, option values, busy/entitlement gates and command handlers. Preserve selected values and sort/search behavior. Use the current palette and improve spacing rather than redesign the page.
2. Define supportMode once from new URLSearchParams(location.search).get('support') === '1'. Remove raw connection/import report panels and the Troubleshooting/Advanced testing tools panel from the normal UI. Retain existing diagnostic tools only when supportMode is true. In normal Connections, an explicit check shows a short connected/checking or plain error message; do not show raw traces, Copy report or report headings. In normal Capture & history, retain provider status, counts, real cooldown/retry actions and plain coverage/errors, but no diagnostic panel even after success. Update Data & help description to omit troubleshooting.
3. Add local history provider/count selections at Bring in your history: provider choices All connected providers plus connected ChatGPT/Claude, count choices from recentCheckChoices with default effectiveRecentCount. Extend sync(limit, provider?) to send the existing optional provider field. The primary action reads Save latest N and uses the selected count/provider; retain full-history action and trial caps. For one selected provider, compute running/waiting lock from that provider only, so ChatGPT waiting cannot block a Claude scan. Retain the all-provider lock, cooldown checks in the backend, Pause/Resume and per-provider retry controls. No backend changes or cooldown bypass.
4. For rate-limited rows use a calm waiting message explaining that saving resumes automatically after the displayed earliest retry time while Chrome is open. Reserve red error styling for actionable failures. Setup's interrupted/waiting action must use neutral status wording rather than Provider needs attention for a cooldown. Do not imply the exact time guarantees immediate provider success.
5. Replace the archive placeholder in the Pin example with the existing /assets/chat-archive-logo-v1.png brand image. Generate public/icon-16.png, icon-32.png, icon-48.png and icon-128.png from that same existing PNG so Chrome's toolbar/extension manager match the product logo. Use ordinary deterministic asset resizing; no new logo concept, dependency or image-generation request. Keep each PNG's exact required dimensions and transparency. Do not alter any other asset.

## Acceptance

Normal setup/settings show no report/preformatted debug text, Copy report, Troubleshooting or Advanced testing tools. Explicit support view retains safe copy/report capability for development. Dropdown pointer/keyboard selection, focus dismissal, dark theme and reduced motion pass synthetic UI checks. Claude-only Save latest 25 sends provider=claude and limit=25 while ChatGPT is waiting. Trial cannot select paid-only counts. Logo is the same PNG family in Pin and Chrome manifest icons. Media success requires actual side-file bytes and a relative image link, with unavailable/unsupported files honestly distinguished. Live original-PDF recovery is not claimed without a verified byte source.

## Parent media scope and evidence

User clarification: affected provider is Claude; files were written by setup history saving into the chosen local folder, then opened with macOS default preview. Both pasted diagnostic excerpts were ChatGPT shapes; one explicitly confirms conversation HTTP 429. Claude live media shape has not yet been received, and no account-specific fix is certified.

The parser ignored file_kind=image, preview_url and preview_asset.url on Claude files. Primary exporter evidence: [Claude exporter API/schema notes](https://github.com/glebmish/claude-exporter/blob/main/docs/claude-ai-api.md). These file fields are source-derived evidence, not a capture from the user's account. The repair accepts those explicit preview URLs only for image entries, gives direct download URLs precedence, and preserves filename-only image references without inventing an endpoint. Document/PDF previews must not become fake original PDFs. Authenticated downloads remain same-provider HTTPS, bounded, no redirects. Saved image extensions follow actual image MIME. Filename-only unavailable documents use concise human-readable copy.

## Media-test slice verbatim steps

1. Extend media-normalize.test.ts with synthetic Claude files: file_kind=image plus preview_asset.url and preview_url (asset takes precedence), preview_url-only image, direct download_url overriding preview URLs, and an opaque file_uuid-only image retained with sourceRef=null. Verify relative URLs resolve to Claude, uploaded origin is retained, and preview metadata on a PDF/document attachment is never treated as original image/PDF bytes. Preserve existing image/branch/artifact tests and no guessed endpoints.
2. Extend offline-media.test.ts with a synthetic Claude history payload using files[].file_kind=image and a same-origin preview_asset.url. Mock fetch to return the existing PNG bytes and verify exact bytes are written, Markdown contains an image link resolving relative to the note, repeat saving creates no duplicate side file, and an original .jpg filename with PNG preview bytes gets a .png side-file suffix. Verify actual document download_url bytes can still produce a file link, while filename-only PDF remains unavailable without any invented fetch. No network, live vault or browser accounts.
3. Update the one stale attachment-copy expectation in markdown-render.test.ts to the new concise original-attachment-unavailable wording, retaining filename and no claim of recovered bytes. Add diagnostics-redact.test.ts coverage that fixed Claude preview/file field names are retained but actual file UUID, preview URL, filename and extracted text are redacted. Do not change production code or loosen existing safety assertions.

## Review verdicts and coverage

- Custom Select: Luna high, two new files, reviewed after one bounded resume corrected initial Home/End/typeahead indices being overwritten by the opening effect. Parent integration checks passed pointer, keyboard, outside/Tab/Escape dismissal, light/dark themes and reduced motion.
- Workspace and icons: Luna high, six files, reviewed after one bounded resume corrected scoped full-history locks, active-versus-waiting labels and plain check guidance. Parent one-line glue restored the genuine interrupted-setup action label; cooldowns keep neutral wording. No backend reset or cooldown bypass. Four RGBA icons were checked at exactly 16, 32, 48 and 128 pixels.
- Media tests: Luna high, four test files, reviewed pass without resume. Exact preview/document bytes, MIME extension, repeat-file stability, relative image links, no invented PDF endpoint and diagnostic privacy are covered.
- Parent-owned: parser/Markdown/diagnostic changes and UI integration tests. Reason: provider identity, file-download constraints and cross-slice behavior. Parent corrected its own fallback so malformed base64 remains rejected. No source takeover from Luna was necessary.
- Read-only Luna audit confirmed 429 checkpoint recovery and that MoveChat has no original-PDF download endpoint to copy. It did not change files or inspect private chats.

All requested code steps are covered. Normal pages have no raw reports/testing panels; an explicit support URL retains diagnostic tools. The fresh synthetic clean history and custom menu screenshots were visually inspected. Passing gates: 248 unit tests /32 files; 35 UI/real-DOM journeys with zero page errors/external requests; TypeScript, lint, production build and ZIP. Packaged-runtime result is recorded in the private test release.

Live limits: the user supplied ChatGPT-only diagnostic excerpts confirming 429, not a Claude media payload. Real Mac image/preview recovery remains to be tested. Filename-only original PDFs are still unavailable; this is disclosed in notes. Existing archived chats need an explicit open-chat re-save to re-read newer media metadata. No private files, archive data, browser profile or connection credentials are included in GitHub or release artifacts.
