# Chatlog — extension testing build

Save AI conversations to a browser-local archive, Markdown files (including an Obsidian vault), and a connected Notion database. This is a private development/testing repository, not the Chrome Web Store release.

## Install on another computer

1. Sign into the GitHub account that can access this private repository. Open [Releases](https://github.com/VC067/Chatlog/releases) and download the latest Chatlog test ZIP.
2. Extract the ZIP to a permanent folder. Keep that folder in place while testing.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
4. Open Chatlog's settings. Choose a new disposable Markdown folder or Obsidian test vault. Grant folder access on this computer.
5. Sign into Claude and ChatGPT in the same Chrome profile, connect their site access in Chatlog, and refresh the provider tabs once.
6. Notion is optional. Enter your connection token only in Chatlog's local settings and connect a test database. Keep the token private.

To update an existing unpacked test installation, replace the build files inside the same permanent folder, then use **Reload** for Chatlog in chrome://extensions and refresh its settings/provider tabs. Keeping the original installation folder preserves the existing extension identity and browser-local test data.

Each computer has its own archive, settings, trial/history usage and folder permissions. GitHub and the ZIP contain no saved chats, browser session or Notion credentials.

## Compare the Claude warning

Use the **same Claude account** on the second computer first; otherwise the account data differs and the comparison cannot isolate the computer/profile.

1. Open **Connections → Claude**. A successful check or history import shows **Connected**; the extra check button is hidden in that healthy state. If only site permission is known, or access needs attention, use **Check connection**. Detailed reports are available in support mode.
2. Create a disposable Claude conversation with a short prompt and reply. Wait a few seconds after the reply finishes, then check **Archive** and the selected local folder for the note.
3. Use **Save current chat** as a separate manual-save check.
4. In **Capture & history → Bring in your history**, select **Claude**, select **25 chats**, then choose **Save latest 25**. A repeated scan of unchanged archived chats can save zero additional conversations. The trial allows 25 unique historical conversations per provider; the five already imported use five of those slots. Automatic new-chat capture and manual open-chat saving are separate from that historical allowance while the trial is active. A ChatGPT cooldown does not lock a Claude-only history scan.
5. A **Waiting** status with HTTP 429 means the provider rate-limited a request. The saved checkpoint resumes after its earliest retry time while Chrome is running; a later provider response can extend the wait.

Raw reports and testing panels are absent from normal product pages. For an explicitly requested support investigation only, add `?support=1` before the hash in the settings URL, for example `options.html?support=1#help`. The support-only Copy media diagnostic action provides aggregate counts and redacted structure. Keep tokens and raw account responses private.

This build skips organizations explicitly marked API-capable without chat capability. Missing or unfamiliar capability metadata stays eligible, and denied access to a genuine/unknown chat organization still produces a coverage warning. The user's live cause is not confirmed until fresh diagnostic evidence is available. See [the fix and evidence](docs/CLAUDE_ORGANIZATION_FIX.md).

## Claude images in the local vault

The selected folder holds Markdown plus image side files. Keep the provider's `files/` subfolders with the notes so relative image links continue to work. This build reads explicit Claude image previews in `files[].preview_asset.url` or `preview_url`, preferring a supplied original download URL. Available same-provider image bytes are copied locally with the correct image extension. Preview-only recovery preserves the supplied preview, not a guarantee of the original upload resolution.

After updating, test with a disposable Claude image upload and **Save current chat**, then inspect both the note and the new file under `claude/files/`. To repair an already archived image conversation, open it in Claude and choose Save current chat; unchanged historical scans can reuse old archive data. Opening the note in Obsidian is also a useful rendering check alongside the macOS preview. Rendering and binary availability are separate checks.

A PDF preview or a filename alone cannot recover the original PDF. An explicit available document download URL is saved; otherwise the note states the original attachment could not be copied. Keep the original chat available for those files. [Polish and media verification](docs/SECOND_COMPUTER_POLISH.md) records the evidence and remaining live acceptance.

## Save the current Grok chat

Open an individual conversation on **grok.com**, wait for the reply to finish, then open Chatlog and choose **Save current chat**. Load older messages first if you want them included. This manual capture saves the rendered text and is marked partial; Grok automatic capture, history import and media backup are unavailable in this build.

The reader targets Grok message bubbles and explicit message containers, including layouts outside `<main>`. It excludes navigation and action controls, preserves code indentation, and checks that the tab has not changed conversations during capture. [Repair checks](docs/GROK_CURRENT_CHAT_REPAIR.md) distinguish synthetic verification from the remaining live account test.

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

Ordinary Claude automatic/manual capture and basic Notion delivery have live user confirmation. Image/artifact fidelity, repeated destination updates, user-edit preservation, dedicated Canvas handling and final store acceptance still need completion. Grok supports manual current-chat capture; Grok history import is unavailable. Production checkout is unconfigured.

Local vaults, browser test profiles, credentials, dependencies and generated build output are excluded from source control. The test ZIP is attached separately to the private release. This handoff contains the extension and focused test documentation; the separately developed marketing site and private planning documents remain local.
