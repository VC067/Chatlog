# Chatlog — extension testing build

Save AI conversations to a browser-local archive, Markdown files (including an Obsidian vault), and a connected Notion database. This is a private development/testing repository, not the Chrome Web Store release.

## Install on another computer

1. Sign into the GitHub account that can access this private repository. Open [Releases](https://github.com/VedantChhajed/Chatlog/releases) and download the latest Chatlog test ZIP.
2. Extract the ZIP to a permanent folder. Keep that folder in place while testing.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
4. Open Chatlog's settings. Choose a new disposable Markdown folder or Obsidian test vault. Grant folder access on this computer.
5. Sign into Claude and ChatGPT in the same Chrome profile, connect their site access in Chatlog, and refresh the provider tabs once.
6. Notion is optional. Enter your connection token only in Chatlog's local settings and connect a test database. Keep the token private.

Each computer has its own archive, settings, trial/history usage and folder permissions. GitHub and the ZIP contain no saved chats, browser session or Notion credentials.

## Compare the Claude warning

Use the **same Claude account** on the second computer first; otherwise the account data differs and the comparison cannot isolate the computer/profile.

1. Open **Connections → Claude → Check connection**. Record the fresh result and expanded report.
2. Create a disposable Claude conversation with a short prompt and reply. Wait a few seconds after the reply finishes, then check **Archive** and the selected local folder for the note.
3. Use **Save open chat** as a separate manual-save check.
4. Run one small history scan. A repeated scan of unchanged archived chats can save zero additional conversations. The trial allows 25 unique historical conversations per provider; automatic new-chat capture and manual open-chat saving are separate from that historical allowance while the trial is active.
5. If **Some workspaces unavailable** persists, open **Capture & history → Copy media diagnostic**. Report the `claude.organizationSelection` counts and the fresh connection/import report. The diagnostic uses aggregate counts and redacted structure; no raw organization response is needed.

This build skips organizations explicitly marked API-capable without chat capability. Missing or unfamiliar capability metadata stays eligible, and denied access to a genuine/unknown chat organization still produces a coverage warning. The user's live cause is not confirmed until fresh diagnostic evidence is available. See [the fix and evidence](docs/CLAUDE_ORGANIZATION_FIX.md).

## Build from source

Use Node.js 22 and npm. From the cloned repository:

```sh
cd extension
npm ci
npm run build
```

Load `extension/.output/chrome-mv3` through **Load unpacked**. To produce a ZIP, run `npm run zip` from `extension/`.

Development checks, also from `extension/`:

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

Install the browser for packaged checks with `npx playwright install chromium` before running `npm run test:e2e`. The synthetic UI verifier is `node ui/verify.mjs` with the local preview server configured by `extension/ui/verify.vite.mjs`; it uses isolated test profiles and the Chrome channel.

## Testing status

Ordinary Claude automatic/manual capture and basic Notion delivery have live user confirmation. Image/artifact fidelity, repeated destination updates, user-edit preservation, dedicated Canvas handling and final store acceptance still need completion. Grok supports manual open-chat capture; Grok history import is unavailable. Production checkout is unconfigured.

Local vaults, browser test profiles, credentials, dependencies and generated build output are excluded from source control. The test ZIP is attached separately to the private release. This handoff contains the extension and focused test documentation; the separately developed marketing site and private planning documents remain local.
