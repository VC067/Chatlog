/* global console:readonly, process:readonly, window:readonly, structuredClone:readonly, location:readonly, document:readonly, innerWidth:readonly, getComputedStyle:readonly, matchMedia:readonly */
// UI fixture verification. This does not use provider accounts or the worker.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const origin = process.env.UI_TEST_ORIGIN || "http://127.0.0.1:4175";
const output = resolve(".output/ui-verification");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const errors = [];
const requests = [];
const results = [];
const base = {
  folder: "granted",
  folderName: "Ideas",
  connected: ["chatgpt", "claude"],
  notion: false,
  notionStatus: { state: "disconnected", message: null },
  pendingJobs: 1,
  blockedJobs: 1,
  deliveryIssues: [
    {
      id: "notion1",
      destinationId: "notion",
      state: "needs_review",
      errorCode: "notion_write_uncertain",
      title: "A better way to organize your ideas",
    },
  ],
  settings: {
    markdownEnabled: true,
    autoSync: true,
    syncIntervalMinutes: 120,
    saveCreatedFiles: true,
    saveUploadedFiles: true,
    includeSources: false,
    saveClaudeProjects: true,
    saveCodeGallery: true,
    saveCowork: false,
    latestSaveCount: 5,
    folderDiskPath: "",
    theme: "light",
    onboardingComplete: true,
  },
  sync: [
    {
      provider: "chatgpt",
      state: "ok",
      savedCount: 4,
      discoveredCount: 4,
      error: null,
      lastRunAt: "2026-10-10T04:00:00Z",
    },
    {
      provider: "claude",
      state: "needs_signin",
      savedCount: 0,
      discoveredCount: 0,
      error: "Sign in to Claude in this browser, then retry.",
    },
  ],
  license: {
    state: "trial",
    daysLeft: 12,
    autoCaptureAllowed: true,
    historyLimit: 25,
    canImportHistory: true,
    checkoutUrl: null,
    configured: false,
  },
};
const archive = [
  {
    key: "one",
    title: "A better way to organize your ideas",
    provider: "chatgpt",
    capturedAt: "2026-10-10T04:00:00Z",
    preview:
      "A practical structure for keeping the work that matters, with notes, references and useful conversations in one place.",
    completeness: "complete",
    destinations: { markdown: "saved", notion: "not_configured" },
  },
  {
    key: "two",
    title: "Building a small, thoughtful product",
    provider: "claude",
    capturedAt: "2026-10-09T08:00:00Z",
    preview:
      "Start with a focused workflow. Test it with real people, then refine the details that make it easier to use.",
    completeness: "partial",
    warning: "An attachment could not be downloaded.",
    destinations: { markdown: "needs_review", notion: "not_configured" },
  },
  {
    key: "three",
    title: "Weekend reading list",
    provider: "grok",
    capturedAt: "2026-10-08T08:00:00Z",
    preview:
      "Notes on typography, information architecture and the craft of building useful software.",
    completeness: "partial",
    destinations: { markdown: "pending" },
  },
];
async function pageWith(status = base, popup = false, support = false) {
  const context = await browser.newContext({
    viewport: popup
      ? { width: 400, height: 600 }
      : { width: 1280, height: 960 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log("PAGE ERROR: " + error.message);
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith("data:"))
      requests.push(request.url());
  });
  await page.addInitScript(
    ({ status, archive, pendingCount }) => {
      window.__uiCommands = [];
      window.__fixtureStatus = window.sessionStorage.getItem(
        "claude-ui-fixture-state",
      )
        ? JSON.parse(window.sessionStorage.getItem("claude-ui-fixture-state"))
        : structuredClone(status);
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__fixtureClipboard = text;
          },
        },
      });
      let rows = structuredClone(archive);
      let inbox = {
        chats: Array.from({ length: pendingCount }, (_, index) => ({
          provider: "chatgpt",
          id: "pending" + (index + 1),
          accountScope: "default",
          title:
            index === 0
              ? "Designing a daily writing habit"
              : "A useful conversation " + (index + 1),
          updatedAt: "2026-10-10T08:00:00Z",
        })),
        checkedAt: "2026-10-10T08:00:00Z",
      };
      const send = async (message) => {
        window.__uiCommands.push(message);
        const current = window.__fixtureStatus;
        switch (message.action) {
          case "status.get":
            return structuredClone(current);
          case "archive.list":
            return rows.filter(
              (row) => !message.provider || row.provider === message.provider,
            );
          case "archive.search":
            return message.query === "deeptranscript"
              ? [rows[0]]
              : rows.filter((row) =>
                  (row.title + row.preview)
                    .toLowerCase()
                    .includes(message.query.toLowerCase()),
                );
          case "archive.get":
            return {
              ...rows.find((row) => row.key === message.key),
              sourceUrl: "https://chatgpt.com/c/sample",
              messages: [
                {
                  role: "user",
                  text: "How should I organize useful conversations?",
                },
                {
                  role: "assistant",
                  text: "## A useful starting point\nKeep an archive with full-text search.\n\n| Item | Why |\n| --- | --- |\n| Conversations | Ideas worth keeping |\n\n~~~js\nconst archive = new Map();\n~~~\n\n![Image](https://example.com/private-image.png)\n\n<script>window.__unsafe = true</script>",
                },
              ],
            };
          case "settings.set":
            if (window.__failSettings)
              return { ok: false, error: "settings_unavailable" };
            Object.assign(current.settings, message.patch);
            return structuredClone(current.settings);
          case "edits.list":
            return window.__resolved
              ? []
              : [{ id: "edit1", conversationKey: "two" }];
          case "edits.resolve":
            window.__resolved = true;
            return { ok: true, message: "Review resolved." };
          case "provider.connect":
            current.connected.push(message.provider);
            return { ok: true };
          case "provider.check":
            await new Promise((resolve) => window.setTimeout(resolve, 300));
            current.claudeConnection = window.__connectionCheckOK
              ? {
                  ok: true,
                  code: "ok",
                  message: "Claude connection checks passed.",
                  report:
                    "Host permission: granted\nClaude tab: ready\nGET /api/organizations — HTTP 200 (provider tab)",
                }
              : {
                  ok: false,
                  code: "blocked",
                  message:
                    "Claude blocked the connection check. Open Claude, refresh its tab, then check again.",
                  report:
                    "Host permission: granted\nClaude tab: ready\nGET /api/organizations — HTTP 403 (worker)\nGET /api/organizations — HTTP 403 (provider tab)",
                };
            current.claudeConnection.checkedAt = new Date().toISOString();
            window.sessionStorage.setItem(
              "claude-ui-fixture-state",
              JSON.stringify(current),
            );
            return structuredClone(current.claudeConnection);
          case "provider.reset":
            current.claudeConnection = null;
            current.sync = current.sync.map((item) =>
              item.provider === "claude"
                ? { ...item, state: "idle", error: null, errorCode: null }
                : item,
            );
            current.imports = (current.imports ?? []).map((item) =>
              item.provider === "claude"
                ? { ...item, state: "paused", error: null, errorCode: null }
                : item,
            );
            window.sessionStorage.setItem(
              "claude-ui-fixture-state",
              JSON.stringify(current),
            );
            return {
              ok: true,
              message:
                "Local Claude check and failure state reset. Saved chats and import progress stay.",
            };
          case "provider.disconnect":
            current.connected = current.connected.filter(
              (value) => value !== message.provider,
            );
            return { ok: true };
          case "notion.save":
            if (!message.createProperties)
              return {
                ok: false,
                message: "Required archive columns are missing.",
                errorCode: "missing_properties",
                missingProperties: ["Provider", "Conversation ID"],
              };
            current.notion = true;
            current.notionStatus = {
              state: "connected",
              message: "Connection verified.",
            };
            return { ok: true, message: "Notion connection verified." };
          case "notion.disconnect":
            current.notion = false;
            current.notionStatus = { state: "disconnected", message: null };
            return { ok: true };
          case "folder.writeTest":
            return window.__folderTestBlocked
              ? { ok: false, status: "blocked" }
              : { ok: true, status: "written", path: "Ideas/Chatsave-test.md" };
          case "sync.run":
            current.sync = [
              {
                provider: "chatgpt",
                state: "running",
                error: null,
                savedCount: 2,
                discoveredCount: 5,
              },
            ];
            current.imports = [
              {
                id: "import1",
                provider: "chatgpt",
                state: "running",
                completedCount: 2,
                discoveredCount: 5,
              },
            ];
            return structuredClone(current.sync);
          case "sync.pause":
            current.imports[0].state = "paused";
            current.sync[0].state = "ok";
            return { ok: true };
          case "sync.resume":
            if (message.provider) {
              current.sync = current.sync.map((item) =>
                item.provider === message.provider
                  ? { ...item, state: "running", error: null, errorCode: null }
                  : item,
              );
              current.imports = (current.imports ?? []).map((item) =>
                item.provider === message.provider
                  ? { ...item, state: "running", error: null, errorCode: null }
                  : item,
              );
            }
            return current.sync;
          case "archive.clear":
            rows = [];
            return { ok: true };
          case "conversation.save":
            return {
              ok: false,
              message: "Open a supported conversation tab first.",
            };
          case "inbox.read":
            return structuredClone(inbox);
          case "inbox.save":
            inbox.chats = inbox.chats.filter(
              (chat) => chat.id !== message.chat.id,
            );
            rows.unshift({
              ...archive[0],
              key: message.chat.id,
              title: message.chat.title,
              provider: message.chat.provider,
            });
            return { ok: true, message: "Chat saved to your archive." };
          case "inbox.refresh":
            inbox = {
              chats: [],
              checkedAt: "2026-10-10T09:00:00Z",
              notice: "Recent chats checked.",
            };
            return structuredClone(inbox);
          case "queue.run":
            return { written: 2, blocked: 0, skipped: 0 };
          case "job.retry":
            current.deliveryIssues = current.deliveryIssues.filter(
              (issue) => issue.id !== message.jobId,
            );
            return { written: 0, blocked: 0, skipped: 0 };
          case "license.status":
            return { ok: true, license: current.license };
          case "license.deactivate":
            current.license.state = "trial_expired";
            current.license.canDeactivate = false;
            return { ok: true, message: "Installation deactivated." };
          case "diagnostics.copy":
            return "Version: 0.0.0";
          case "samples.export":
            return {
              ok: true,
              message: JSON.stringify({ claude: { conversation: { status: 200, kind: "json", shape: { chat_messages: { type: "array", length: 2 } } } } }),
            };
          default:
            return { ok: false, message: "Unknown fixture command." };
        }
      };
      const fixtureBrowser = {
        runtime: {
          id: "fixture",
          sendMessage: send,
          getURL: (path) => location.origin + path,
          getManifest: () => ({ version: "0.0.0" }),
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => {},
            remove: async () => {},
          },
        },
        permissions: {
          request: async (permission) => {
            window.__uiCommands.push({ permission });
            return true;
          },
        },
        tabs: {
          create: async (tab) => {
            window.__uiCommands.push({ tab });
          },
        },
      };
      window.browser = fixtureBrowser;
      window.chrome = fixtureBrowser;
    },
    {
      status,
      archive: popup
        ? [
            ...archive,
            ...Array.from({ length: 6 }, (_, index) => ({
              ...archive[0],
              key: "extra" + index,
              title: "Saved thought " + (index + 1),
            })),
          ]
        : archive,
      pendingCount: popup ? 7 : 1,
    },
  );
  await page.goto(
    origin + "/entrypoints/" + (popup ? "popup" : "options") + "/index.html" + (support ? "?support=1" : ""),
  );
  await page.locator(".brand").first().waitFor();
  await page.waitForTimeout(450);
  return { page, context };
}
async function check(name, work) {
  await work();
  results.push(name);
  console.log("PASS " + name);
}
try {
  const { page, context } = await pageWith();
  await check("Archive layout and local assets", async () => {
    await expect(
      page.getByRole("heading", {
        name: "A place for your best conversations.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("A better way to organize your ideas", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Markdown · saved", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: output + "/archive-light.png",
      fullPage: true,
    });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      font: getComputedStyle(document.body).fontFamily,
    }));
    expect(layout.overflow).toBe(false);
    expect(layout.font).toContain("DM Sans");
  });
  await check("Search asks worker for transcript matches", async () => {
    await page
      .getByRole("textbox", { name: "Search full conversations" })
      .fill("deeptranscript");
    await expect(
      page.getByText("1 conversation found", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.__uiCommands.some(
          (item) =>
            item.action === "archive.search" && item.query === "deeptranscript",
        ),
      ),
    ).toBe(true);
  });
  await check("Reader renders safe Markdown with no remote media", async () => {
    await page
      .getByRole("button", { name: /A better way to organize/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "A useful starting point" }),
    ).toBeVisible();
    await expect(
      page.getByText("Image: Image — preview unavailable in archive reader"),
    ).toBeVisible();
    expect(await page.evaluate(() => window.__unsafe)).toBeUndefined();
    await page.screenshot({ path: output + "/reader.png", fullPage: true });
  });
  await check("Edit review and import progress controls", async () => {
    await page
      .getByRole("button", { name: "Capture & history", exact: false })
      .first()
      .click();
    await expect(
      page.getByRole("switch", { name: /Canvas & Code gallery/ }),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        /Dedicated ChatGPT Canvas recovery is still unavailable/,
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Keep incoming copy", exact: true })
      .click();
    await expect(
      page.getByText("No Markdown edits waiting for review.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/The previous Notion write could not be confirmed/),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: output + "/delivery-review.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Recheck delivery", exact: true })
      .click();
    await expect(
      page.getByText(
        "Delivery rechecked. Current destination status is shown below.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Recheck delivery", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Save latest 5", exact: true })
      .click();
    await expect(page.getByText(/History save started/)).toBeVisible();
    await expect(
      page.getByText("2 saved this run · 5 found", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: output + "/capture-progress.png",
      fullPage: true,
    });
  });
  await check("Theme switching and failed settings stay honest", async () => {
    await page
      .getByRole("button", { name: "Data & help", exact: true })
      .click();
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: output + "/settings-dark.png",
      fullPage: true,
    });
    await page.evaluate(() => {
      window.__failSettings = true;
    });
    await page.getByRole("radio", { name: "Light", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "That setting was not saved.",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
  await check("Archive clear requires explicit confirmation", async () => {
    await page.getByRole("button", { name: "Clear local archive…" }).click();
    expect(
      await page.evaluate(() =>
        window.__uiCommands.some((item) => item.action === "archive.clear"),
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      await page.evaluate(() =>
        window.__uiCommands.some((item) => item.action === "archive.clear"),
      ),
    ).toBe(false);
  });
  await context.close();
  const connectionStatus = structuredClone(base);
  connectionStatus.sync = [
    {
      provider: "claude",
      state: "needs_signin",
      error: "Sign in to Claude in this browser, then retry.",
      savedCount: 0,
    },
  ];
  connectionStatus.imports = [
    {
      id: "paused-claude-checkpoint",
      provider: "claude",
      state: "paused",
      errorCode: "needs_signin",
      error: "Sign in to Claude in this browser, then retry.",
      completedCount: 3,
      discoveredCount: 8,
    },
  ];
  const connection = await pageWith(connectionStatus, false, true);
  await check(
    "Claude connection result is visible inline, copyable and separate from history errors",
    async () => {
      await connection.page
        .getByRole("button", { name: "Connections", exact: true })
        .click();
      const before = await connection.page.evaluate(() =>
        structuredClone(window.__fixtureStatus),
      );
      const claude = connection.page.locator('[data-provider="claude"]');
      await claude.scrollIntoViewIfNeeded();
      await expect(
        claude.getByText(
          "Uses your signed-in Claude tab. No separate sign-in popup.",
          { exact: true },
        ),
      ).toBeVisible();
      await connection.page
        .getByRole("button", { name: "Check connection", exact: true })
        .click();
      await expect(
        claude
          .getByRole("status")
          .filter({ hasText: "Checking Claude connection…" }),
      ).toBeVisible();
      await expect(claude.getByRole("alert")).toContainText(
        "Claude blocked the connection check.",
      );
      await expect(claude.getByRole("alert")).toContainText(
        "GET /api/organizations — HTTP 403 (worker)",
      );
      await expect(claude.getByRole("alert")).toContainText(
        "GET /api/organizations — HTTP 403 (provider tab)",
      );
      await expect(claude.locator(".claude-report")).toBeInViewport();
      await expect(
        claude.getByRole("button", { name: "Copy report", exact: true }),
      ).toBeInViewport();
      await connection.page.screenshot({
        path: output + "/claude-check-inline-failed.png",
      });
      await claude
        .getByRole("button", { name: "Copy report", exact: true })
        .click();
      await expect(
        claude.getByText("Report copied.", { exact: true }),
      ).toBeVisible();
      const copied = await connection.page.evaluate(
        () => window.__fixtureClipboard,
      );
      expect(copied).toContain("Claude blocked the connection check.");
      expect(copied).toContain("GET /api/organizations — HTTP 403 (worker)");
      expect(copied).toContain("Checked:");
      expect(copied).not.toContain("A better way to organize your ideas");
      const after = await connection.page.evaluate(() => ({
        status: window.__fixtureStatus,
        commands: window.__uiCommands,
      }));
      expect(after.status.sync).toEqual(before.sync);
      expect(after.status.imports).toEqual(before.imports);
      expect(after.status.pendingJobs).toBe(before.pendingJobs);
      expect(after.status.blockedJobs).toBe(before.blockedJobs);
      expect(
        after.commands.filter((message) => message.action === "provider.check"),
      ).toEqual([{ action: "provider.check", provider: "claude" }]);
      expect(
        after.commands.some((message) =>
          ["sync.run", "sync.resume", "conversation.save"].includes(
            message.action,
          ),
        ),
      ).toBe(false);
      await connection.page.evaluate(() => {
        window.__connectionCheckOK = true;
      });
      await connection.page
        .getByRole("button", { name: "Check connection", exact: true })
        .click();
      await expect(claude.locator(".claude-check-result")).toContainText("Claude connected");
      const connectionDetails = claude.locator(".claude-check-result details");
      await expect(connectionDetails).not.toHaveAttribute("open", "");
      await expect(connectionDetails.locator("summary")).toHaveText("Connection details");
      await expect(connectionDetails.locator(".claude-report")).not.toBeVisible();
      await expect(claude.locator(".claude-check-guidance")).toHaveText("Connected Claude chats can be saved.");
      await expect(claude.locator(".connection-row .badge")).toHaveText(
        "Last check passed",
      );
      await expect(claude.locator(".claude-history-issue")).toHaveCount(0);
      await expect(claude.getByRole("button", { name: "View history import", exact: false })).toBeVisible();
      await expect(claude.getByRole("button", { name: "Reset connection", exact: true })).toHaveCount(0);
      await expect(claude.locator(".claude-check-result")).toContainText(
        "Last connection check",
      );
      await expect(
        claude.locator(".claude-check-heading time"),
      ).toHaveAttribute("datetime", /.+/);
      await connectionDetails.locator("summary").click();
      await expect(connectionDetails.locator(".claude-report")).toContainText(
        "GET /api/organizations — HTTP 200 (provider tab)",
      );
      await connectionDetails.getByRole("button", { name: "Copy report", exact: true }).click();
      await expect(claude.getByText("Report copied.", { exact: true })).toBeVisible();
      const successfulCopy = await connection.page.evaluate(() => window.__fixtureClipboard);
      expect(successfulCopy).toContain("Claude connection checks passed.");
      expect(successfulCopy).toContain("GET /api/organizations — HTTP 200 (provider tab)");
      await connection.page.screenshot({
        path: output + "/claude-check-inline-passed.png",
      });
      const finalStatus = await connection.page.evaluate(
        () => window.__fixtureStatus,
      );
      expect(finalStatus.sync).toEqual(before.sync);
      expect(finalStatus.imports).toEqual(before.imports);
      await claude.getByRole("button", { name: "View history import", exact: false }).click();
      const historyClaude = connection.page.locator('.sync-provider[data-provider="claude"]');
      await expect(historyClaude).toBeVisible();
      await expect(historyClaude).toContainText("Sign in to the provider in this browser.");
      await expect(historyClaude.getByRole("button", { name: "Retry Claude", exact: true })).toBeVisible();
      const viewed = await connection.page.evaluate(() => window.__fixtureStatus.imports[0]);
      expect(viewed.id).toBe("paused-claude-checkpoint");
      expect(viewed.state).toBe("paused");
    },
  );
  await check(
    "Last Claude check persists on reload and reset runs a fresh check without losing progress",
    async () => {
      await connection.page.reload();
      await connection.page.getByRole("button", { name: "Connections", exact: true }).click();
      const claude = connection.page.locator('[data-provider="claude"]');
      await expect(claude.locator(".claude-check-result")).toContainText("Claude connected");
      await expect(claude.locator(".claude-check-result details")).not.toHaveAttribute("open", "");
      await expect(claude.locator(".claude-check-result")).toContainText(
        "GET /api/organizations — HTTP 200 (provider tab)",
      );
      await expect(claude.locator(".claude-history-issue")).toHaveCount(0);
      const before = await connection.page.evaluate(() =>
        structuredClone(window.__fixtureStatus),
      );
      await connection.page.evaluate(() => { window.__connectionCheckOK = false; });
      await claude.getByRole("button", { name: "Check connection", exact: true }).click();
      await expect(claude.getByRole("alert")).toContainText("Claude blocked the connection check.");
      await expect(claude.getByRole("button", { name: "Reset connection", exact: true })).toBeVisible();
      await connection.page.evaluate(() => { window.__connectionCheckOK = true; });
      await claude
        .getByRole("button", { name: "Reset connection", exact: true })
        .click();
      await expect(
        claude
          .getByRole("status")
          .filter({ hasText: "Checking Claude connection…" }),
      ).toBeVisible();
      await expect(claude.locator(".claude-check-result")).toContainText("Claude connected");
      await expect(claude.locator(".claude-check-result details")).not.toHaveAttribute("open", "");
      const after = await connection.page.evaluate(() => ({
        status: window.__fixtureStatus,
        commands: window.__uiCommands,
      }));
      expect(
        after.commands.filter((message) =>
          ["provider.reset", "provider.check"].includes(message.action),
        ).slice(-2),
      ).toEqual([
        { action: "provider.reset", provider: "claude" },
        { action: "provider.check", provider: "claude" },
      ]);
      expect(after.status.imports[0].id).toBe(before.imports[0].id);
      expect(after.status.imports[0].completedCount).toBe(
        before.imports[0].completedCount,
      );
      expect(after.status.imports[0].discoveredCount).toBe(
        before.imports[0].discoveredCount,
      );
      expect(after.status.imports[0].state).toBe("paused");
      expect(after.status.pendingJobs).toBe(before.pendingJobs);
      expect(after.status.blockedJobs).toBe(before.blockedJobs);
      expect(
        after.commands.some((message) =>
          [
            "sync.run",
            "sync.resume",
            "conversation.save",
            "archive.clear",
          ].includes(message.action),
        ),
      ).toBe(false);
      await expect(claude.locator(".connection-row .badge")).toHaveText(
        "Last check passed",
      );
      await expect(claude.locator(".claude-history-issue")).toHaveCount(0);
      await expect(claude.getByRole("button", { name: "View history import", exact: false })).toBeVisible();
      await connection.page.screenshot({
        path: output + "/claude-check-after-reset.png",
      });
    },
  );
  await connection.context.close();

  const notionWaiting = structuredClone(base);
  notionWaiting.notion = true;
  notionWaiting.notionStatus = {
    state: "waiting",
    message: "Notion is temporarily busy.",
    errorCode: "service_overload",
    nextRetryAt: "2026-10-12T10:30:00Z",
  };
  const notionUI = await pageWith(notionWaiting);
  await check("Notion waiting state preserves the configured connection", async () => {
    await notionUI.page.getByRole("button", { name: "Connections", exact: true }).click();
    const panel = notionUI.page.locator(".notion-panel");
    await expect(panel.getByText("Waiting", { exact: true })).toBeVisible();
    await expect(panel).toContainText("Notion is temporarily busy.");
    await expect(panel).toContainText("Automatic retry not before");
    await expect(
      panel.locator("p.setting-note").filter({ hasText: "Automatic retry not before" }),
    ).toContainText(/\d{1,2}:\d{2}/);
    await expect(panel.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await expect(panel.getByText(/permission|sign in/i)).toHaveCount(0);
  });
  await notionUI.context.close();

  const workspaceLimit = structuredClone(base);
  workspaceLimit.deliveryIssues = [{
    id: "workspace-limit",
    destinationId: "notion",
    state: "blocked",
    errorCode: "notion_workspace_limit",
    title: "A better way to organize your ideas",
  }];
  const workspaceLimitUI = await pageWith(workspaceLimit);
  await check("Notion workspace limit is displayed in delivery issues", async () => {
    await workspaceLimitUI.page.getByRole("button", { name: "Capture & history", exact: false }).first().click();
    await expect(workspaceLimitUI.page.getByText(/workspace has reached its available limit/)).toBeVisible();
  });
  await workspaceLimitUI.context.close();

  const folderTest = await pageWith(base);
  await check("Folder test note reports its safe path and blocked writes honestly", async () => {
    await folderTest.page.getByRole("button", { name: "Connections", exact: true }).click();
    await folderTest.page.getByRole("button", { name: "Write test note", exact: true }).click();
    await expect(folderTest.page.getByRole("status")).toContainText("Ideas/Chatsave-test.md");
    await expect(folderTest.page.getByRole("status")).toContainText("Check the selected Obsidian vault");
    await folderTest.page.evaluate(() => { window.__folderTestBlocked = true; });
    await folderTest.page.getByRole("button", { name: "Write test note", exact: true }).click();
    await expect(folderTest.page.getByRole("alert")).toContainText("test note could not be written");
    const commands = await folderTest.page.evaluate(() => window.__uiCommands.filter((message) => message.action === "folder.writeTest"));
    expect(commands).toEqual([{ action: "folder.writeTest" }, { action: "folder.writeTest" }]);
  });
  await folderTest.context.close();

  const historyStatus = structuredClone(base);
  historyStatus.sync[1] = { provider: "claude", state: "error", errorCode: "blocked", error: "The provider blocked this request.", savedCount: 0 };
  historyStatus.imports = [
    { id: "finished-chatgpt", provider: "chatgpt", state: "completed", completedCount: 0, discoveredCount: 25, error: null },
    { id: "blocked-claude", provider: "claude", state: "paused", completedCount: 0, discoveredCount: 0, errorCode: "blocked", error: "The provider blocked this request." },
  ];
  const history = await pageWith(historyStatus, false, true);
  await check("Completed history count states saves this run without claiming destination success", async () => {
    await history.page.getByRole("button", { name: /^Capture & history/ }).click();
    const chatgpt = history.page.locator('.sync-provider[data-provider="chatgpt"]');
    await expect(chatgpt).toContainText("0 saved this run · 25 found");
    await expect(chatgpt.locator(".badge")).toHaveText("Check finished");
    await expect(chatgpt).not.toContainText("Up to date");
  });
  await check("Blocked history exposes the connection report in place without restarting the import", async () => {
    const claude = history.page.locator('.sync-provider[data-provider="claude"]');
    await claude.getByRole("button", { name: "Check connection", exact: true }).click();
    await expect(claude.locator(".claude-check-result")).toContainText("HTTP 403");
    await claude.getByRole("button", { name: "Copy report", exact: true }).click();
    await expect(claude.getByText("Report copied.", { exact: true })).toBeVisible();
    const evidence = await history.page.evaluate(() => ({ commands: window.__uiCommands, status: window.__fixtureStatus, copied: window.__fixtureClipboard }));
    expect(evidence.copied).toContain("HTTP 403");
    expect(evidence.status.imports).toEqual(historyStatus.imports);
    expect(evidence.commands.filter((message) => ["sync.resume", "sync.run", "provider.reset"].includes(message.action))).toEqual([]);
    await history.page.evaluate(() => { window.__connectionCheckOK = true; });
    await claude.getByRole("button", { name: "Check connection", exact: true }).click();
    await expect(claude.locator(".claude-check-result")).toContainText("Claude connected");
    await expect(claude.locator(".claude-check-result details")).not.toHaveAttribute("open", "");
    await expect(claude.locator(".sync-row .badge")).toHaveText("Needs attention");
    await history.page.screenshot({ path: output + "/claude-history-report.png", fullPage: true });
  });
  await history.context.close();

  const failedImportReportStatus = structuredClone(base);
  failedImportReportStatus.claudeConnection = {
    ok: true,
    code: "ok",
    message: "Claude connection checks passed.",
    report: "Older successful connection check report.",
    checkedAt: "2026-10-14T07:00:00Z",
    source: "check",
  };
  const failedImportReport = await pageWith(failedImportReportStatus, false, true);
  await check("Failed Claude import report replaces an older successful check and copies without check guidance", async () => {
    await failedImportReport.page.getByRole("button", { name: /^Capture & history/ }).click();
    const claude = failedImportReport.page.locator('.sync-provider[data-provider="claude"]');
    await failedImportReport.page.evaluate(() => { window.__connectionCheckOK = true; });
    await claude.getByRole("button", { name: "Check connection", exact: true }).click();
    await expect(claude.locator(".claude-check-result")).toContainText("Claude connected");
    await expect(claude.locator(".claude-check-heading strong")).toHaveText("Last connection check");
    await expect(claude.locator(".claude-check-result details")).not.toHaveAttribute("open", "");
    await failedImportReport.page.evaluate(() => {
      window.__fixtureStatus.claudeConnection = {
        ok: false,
        code: "blocked",
        message: "Claude history import failed while loading workspace history.",
        report: "Import report: workspace history request returned HTTP 403.",
        checkedAt: new Date(Date.now() + 60000).toISOString(),
        source: "import",
      };
    });
    await expect(claude.locator(".claude-check-heading strong")).toHaveText("Last history import report", { timeout: 10000 });
    await expect(claude.locator(".claude-check-result")).toContainText("Import report: workspace history request returned HTTP 403.", { timeout: 10000 });
    await expect(claude.locator(".claude-check-result")).not.toContainText("Older successful connection check report.");
    await expect(claude.locator(".claude-check-guidance")).toContainText("Share this report");
    await expect(claude.locator(".claude-check-guidance")).not.toContainText("This check does not save chats");
    await claude.getByRole("button", { name: "Copy report", exact: true }).click();
    const copied = await failedImportReport.page.evaluate(() => window.__fixtureClipboard);
    expect(copied).toContain("Claude history import failed while loading workspace history.");
    expect(copied).toContain("Import report: workspace history request returned HTTP 403.");
    expect(copied).not.toContain("Older successful connection check report.");
  });
  await failedImportReport.context.close();

  const partialImportStatus = structuredClone(base);
  const partialCoverageMessage = "Saved accessible Claude history. Some Claude workspaces were unavailable; those chats were not imported.";
  partialImportStatus.sync[1] = { provider: "claude", state: "ok", errorCode: "claude_accounts_skipped", error: partialCoverageMessage, savedCount: 3 };
  partialImportStatus.imports = [{ id: "partial-claude", provider: "claude", state: "completed", completedCount: 3, discoveredCount: 5, error: partialCoverageMessage, errorCode: "claude_accounts_skipped" }];
  partialImportStatus.claudeConnection = {
    ok: true,
    code: "ok",
    message: partialCoverageMessage,
    report: partialCoverageMessage,
    checkedAt: "2026-10-14T08:10:00Z",
    source: "import",
  };
  const partialImport = await pageWith(partialImportStatus, false, true);
  await check("Completed partial Claude import shows calm coverage and optional retry guidance", async () => {
    await partialImport.page.getByRole("button", { name: /^Capture & history/ }).click();
    const claude = partialImport.page.locator('.sync-provider[data-provider="claude"]');
    await expect(claude.locator(".sync-row .badge")).toHaveText("Some workspaces unavailable");
    await expect(claude.locator(".sync-row .badge")).toHaveClass(/warn/);
    await expect(claude).toContainText(partialCoverageMessage);
    await expect(claude).not.toContainText("Sign in needed");
    await expect(claude.locator(".sync-guidance").filter({ hasText: "Saved chats are ready." })).toContainText("Saved chats are ready. Retry later if access to another Claude workspace changes.");
    await expect(claude.locator(".sync-guidance").filter({ hasText: partialCoverageMessage })).toContainText(partialCoverageMessage);
    await expect(claude.locator(".sync-row .inline-error")).toHaveCount(0);
    await expect(claude.getByRole("button", { name: "Retry Claude", exact: true })).toBeVisible();
    await expect(claude.getByRole("button", { name: "Check connection", exact: true })).toBeVisible();
    await expect(claude.locator(".claude-check-heading strong")).toHaveText("Last history import report");
    await expect(claude.locator(".claude-check-result details")).toHaveCount(1);
    const importDetails = claude.locator(".claude-check-result details");
    await expect(importDetails).not.toHaveAttribute("open", "");
    await expect(importDetails.locator("summary")).toHaveText("History import details");
    await expect(importDetails.getByRole("button", { name: "Copy report", exact: true })).toHaveCount(0);
    await partialImport.page.screenshot({ path: output + "/claude-partial-coverage-collapsed.png", fullPage: true });
    await importDetails.locator("summary").click();
    await expect(importDetails.locator(".claude-report")).toContainText(partialCoverageMessage);
    await importDetails.getByRole("button", { name: "Copy report", exact: true }).click();
    await expect(partialImport.page.getByText("Report copied.", { exact: true })).toBeVisible();
    await partialImport.page.screenshot({ path: output + "/claude-partial-coverage-details.png", fullPage: true });
    await expect(claude.locator(".claude-check-result .claude-check-guidance")).toHaveCount(0);
    await partialImport.page.getByRole("button", { name: "Connections", exact: true }).click();
    const connectionClaude = partialImport.page.locator('.provider-connection[data-provider="claude"]');
    await expect(connectionClaude.locator(".connection-row .badge")).toHaveText("Some workspaces unavailable");
    await expect(connectionClaude).toContainText(partialCoverageMessage);
    await expect(connectionClaude).not.toContainText("Last history save needs retry");
    await expect(connectionClaude.getByRole("button", { name: "Reset connection", exact: true })).toHaveCount(0);
  });
  await partialImport.context.close();

  const setupStatus = structuredClone(base);
  setupStatus.settings.onboardingComplete = false;
  setupStatus.folder = "missing";
  setupStatus.folderName = null;
  setupStatus.connected = [];
  setupStatus.sync = [];
  const setup = await pageWith(setupStatus);
  await check("Notion-only setup and explicit schema creation", async () => {
    const page = setup.page;
    await expect(
      page.getByRole("heading", {
        name: "Your conversations. Somewhere you own.",
      }),
    ).toBeVisible();
    await page.screenshot({
      path: output + "/setup-destination.png",
      fullPage: true,
    });
    await page
      .getByRole("radio", { name: /Notion Your connected database/ })
      .click();
    await expect(
      page.getByRole("button", { name: "Choose folder", exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel("Internal connection token")
      .fill("fixture-token-not-real");
    await page.getByLabel("Database URL or ID").fill("fixture-db");
    await page
      .getByRole("button", { name: "Verify & connect", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Create required columns & connect" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Create required columns & connect" })
      .click();
    await expect(
      page.getByText("Connected", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    expect(
      await page.evaluate(
        () => window.__fixtureStatus.settings.markdownEnabled,
      ),
    ).toBe(false);
    await page
      .getByRole("button", { name: "Connect", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Bring in your first conversations." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save latest five", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Save later & continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Pin Chatlog" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Finish setup", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "A place for your best conversations.",
      }),
    ).toBeVisible();
  });
  await setup.context.close();
  const cappedTrial = structuredClone(base);
  cappedTrial.settings.latestSaveCount = 500;
  const trialChoices = await pageWith(cappedTrial);
  await check(
    "Trial history choices respect entitlement and cap existing preferences",
    async () => {
      await trialChoices.page
        .getByRole("button", { name: "Capture & history", exact: false })
        .first()
        .click();
      const select = trialChoices.page.getByRole("combobox", {
        name: "Recent conversations to check",
      });
      await expect(select).toContainText("25 chats");
      await select.click();
      expect(
        await trialChoices.page.getByRole("listbox", { name: "Recent conversations to check" })
          .getByRole("option").evaluateAll((options) => options.map((option) => option.textContent.replace(/[^0-9]/g, ""))),
      ).toEqual(["1", "5", "10", "25"]);
      await select.press("Escape");
      await expect(
        trialChoices.page.getByText(
          "Your trial includes up to 25 unique historical conversations per provider.",
          { exact: true },
        ),
      ).toBeVisible();
      await trialChoices.page.evaluate(() => window.scrollTo(0, 0));
      await trialChoices.page.screenshot({
        path: output + "/trial-history-options.png",
        fullPage: true,
      });
    },
  );
  await trialChoices.context.close();
  const paidFixture = structuredClone(base);
  paidFixture.license.state = "active";
  paidFixture.license.historyLimit = null;
  paidFixture.settings.latestSaveCount = 500;
  const paidChoices = await pageWith(paidFixture);
  await check(
    "Active-license fixture offers larger choices with active-access copy",
    async () => {
      await paidChoices.page
        .getByRole("button", { name: "Capture & history", exact: false })
        .first()
        .click();
      const select = paidChoices.page.getByRole("combobox", {
        name: "Recent conversations to check",
      });
      await expect(select).toContainText("500 chats");
      await select.click();
      expect(
        await paidChoices.page.getByRole("listbox", { name: "Recent conversations to check" })
          .getByRole("option").evaluateAll((options) => options.map((option) => option.textContent.replace(/[^0-9]/g, ""))),
      ).toEqual(["1", "5", "10", "25", "50", "100", "250", "500"]);
      await select.press("Escape");
      await expect(
        paidChoices.page.getByText(
          /Your active license supports larger history checks/,
        ),
      ).toBeVisible();
      await paidChoices.page.screenshot({
        path: output + "/active-history-options-fixture.png",
        fullPage: true,
      });
    },
  );
  await paidChoices.context.close();
  const blockedSetup = structuredClone(base);
  blockedSetup.settings.onboardingComplete = false;
  blockedSetup.settings.theme = "dark";
  blockedSetup.sync = [
    {
      provider: "chatgpt",
      state: "error",
      error: "The provider blocked this request.",
      errorCode: "blocked",
      savedCount: 0,
    },
    {
      provider: "claude",
      state: "running",
      error: "The provider blocked this request.",
      errorCode: "blocked",
      savedCount: 3,
    },
  ];
  blockedSetup.imports = [
    {
      id: "existing-claude-checkpoint",
      provider: "claude",
      state: "running",
      error: "The provider blocked this request.",
      errorCode: "blocked",
      completedCount: 3,
      discoveredCount: 8,
    },
  ];
  const retrySetup = await pageWith(blockedSetup);
  await check(
    "Blocked Claude has a provider-specific checkpoint retry and clean dark Pin step",
    async () => {
      for (let index = 0; index < 2; index++)
        await retrySetup.page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
      await expect(
        retrySetup.page.getByRole("button", {
          name: "Retry Claude",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        retrySetup.page.getByRole("link", { name: "Open Claude", exact: true }),
      ).toBeVisible();
      await expect(
        retrySetup.page.getByRole("button", {
          name: "Saving conversations…",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        retrySetup.page.getByRole("button", {
          name: "Provider needs attention",
          exact: true,
        }),
      ).toBeDisabled();
      await retrySetup.page.screenshot({
        path: output + "/setup-claude-blocked-dark.png",
        fullPage: true,
      });
      await retrySetup.page
        .getByRole("button", { name: "Retry Claude", exact: true })
        .click();
      await expect(
        retrySetup.page
          .getByRole("status")
          .filter({ hasText: "Claude is checking" }),
      ).toContainText("Claude is checking your saved import progress.");
      await expect(
        retrySetup.page
          .getByRole("status")
          .filter({ hasText: "Claude is checking" }),
      ).not.toContainText("still needs attention");
      const evidence = await retrySetup.page.evaluate(() => ({
        commands: window.__uiCommands.filter(
          (message) =>
            message.action === "sync.resume" || message.action === "sync.run",
        ),
        imports: window.__fixtureStatus.imports,
      }));
      expect(evidence.commands).toEqual([
        { action: "sync.resume", provider: "claude" },
      ]);
      expect(evidence.imports[0].id).toBe("existing-claude-checkpoint");
      expect(evidence.imports[0].completedCount).toBe(3);
      await retrySetup.page
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(
        retrySetup.page.getByRole("heading", {
          name: "Pin Chatlog",
          exact: true,
        }),
      ).toBeFocused();
      await expect(
        retrySetup.page.locator(".pin-stage .eyebrow, .browser-toolbar"),
      ).toHaveCount(0);
      await expect(retrySetup.page.getByRole("status")).toHaveCount(0);
      await retrySetup.page.screenshot({
        path: output + "/setup-pin-dark.png",
        fullPage: true,
      });
      await retrySetup.page
        .getByRole("button", { name: "Pin later", exact: true })
        .focus();
      await retrySetup.page
        .getByRole("button", { name: "Pin later", exact: true })
        .press("Enter");
      await expect(
        retrySetup.page.getByRole("heading", {
          name: "A place for your best conversations.",
        }),
      ).toBeVisible();
    },
  );
  await retrySetup.context.close();
  const waitingStatus = structuredClone(base);
  waitingStatus.sync = [
    {
      provider: "claude",
      state: "running",
      error: "Wait before retrying.",
      errorCode: "rate_limited",
      savedCount: 1,
    },
  ];
  waitingStatus.imports = [
    {
      id: "waiting-claude-checkpoint",
      provider: "claude",
      state: "running",
      error: "Wait before retrying.",
      errorCode: "rate_limited",
      completedCount: 1,
      discoveredCount: 2,
      nextEligibleAt: new Date(Date.now() + 120000).toISOString(),
    },
  ];
  const waiting = await pageWith(waitingStatus);
  await check(
    "Provider cooldown is shown as waiting without an immediate Retry action",
    async () => {
      await waiting.page
        .getByRole("button", { name: "Capture & history", exact: false })
        .first()
        .click();
      await expect(
        waiting.page.getByText("Waiting", { exact: true }),
      ).toBeVisible();
      await expect(
        waiting.page.getByText(/Saving will resume automatically after/),
      ).toBeVisible();
      await expect(
        waiting.page.getByRole("button", { name: "Retry Claude", exact: true }),
      ).toHaveCount(0);
      await waiting.page
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      expect(
        await waiting.page.evaluate(() =>
          window.__uiCommands.some(
            (message) => message.action === "sync.resume",
          ),
        ),
      ).toBe(false);
    },
  );
  await waiting.context.close();
  const startedStatus = structuredClone(base);
  startedStatus.settings.onboardingComplete = false;
  startedStatus.connected = ["chatgpt"];
  startedStatus.sync = [];
  startedStatus.imports = [];
  const started = await pageWith(startedStatus);
  await check(
    "Pin step clears the history-start notice and remains compact",
    async () => {
      for (let index = 0; index < 2; index++)
        await started.page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
      await started.page
        .getByRole("button", { name: "Save latest five", exact: true })
        .click();
      await expect(
        started.page
          .getByRole("status")
          .filter({ hasText: "History save started" }),
      ).toContainText("History save started");
      await started.page
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(
        started.page.getByRole("heading", {
          name: "Pin Chatlog",
          exact: true,
        }),
      ).toBeVisible();
      await expect(started.page.getByText(/History save started/)).toHaveCount(
        0,
      );
      await expect(
        started.page.getByRole("button", { name: "Finish setup", exact: true }),
      ).toBeInViewport();
      await expect(started.page.locator(".pin-steps li")).toHaveCount(2);
      await started.page.screenshot({
        path: output + "/setup-pin-light.png",
        fullPage: true,
      });
    },
  );
  await started.context.close();
  const expiredStatus = structuredClone(base);
  expiredStatus.license.state = "trial_expired";
  expiredStatus.license.autoCaptureAllowed = false;
  expiredStatus.license.canImportHistory = false;
  expiredStatus.settings.theme = "dark";
  const expired = await pageWith(expiredStatus);
  await check(
    "Expired trial preserves archive and disables purchase honestly",
    async () => {
      await expired.page
        .getByRole("button", { name: "License", exact: true })
        .click();
      await expect(
        expired.page.getByText("Trial ended", { exact: true }).last(),
      ).toBeVisible();
      await expect(
        expired.page.getByRole("button", {
          name: "Purchase opens after launch setup",
        }),
      ).toBeDisabled();
      await expired.page.screenshot({
        path: output + "/license-expired.png",
        fullPage: true,
      });
      await expired.page
        .getByRole("button", { name: "Archive", exact: true })
        .click();
      await expect(
        expired.page.getByText("A better way to organize your ideas", {
          exact: true,
        }),
      ).toBeVisible();
      await expired.page.setViewportSize({ width: 600, height: 900 });
      expect(
        await expired.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expired.page.screenshot({
        path: output + "/archive-small.png",
        fullPage: true,
      });
    },
  );
  await expired.context.close();
  const popup = await pageWith(base, true);
  await check(
    "Popup starts with To save, compact header and explicit row saves",
    async () => {
      await expect(
        popup.page.getByRole("tab", { name: /^To save/ }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(popup.page.getByRole("button", { name: "Claude history needs sign-in", exact: false })).toBeVisible();
      await expect(
        popup.page.locator(".quick-save, .quick-heading, .local-dot"),
      ).toHaveCount(0);
      await expect(
        popup.page.getByText("Your next idea, saved.", { exact: true }),
      ).toHaveCount(0);
      await expect(
        popup.page.getByRole("textbox", { name: "Search saved chats" }),
      ).toHaveCount(0);
      await expect(
        popup.page.getByRole("button", { name: "Open full archive" }),
      ).toHaveCount(0);
      await expect(popup.page.locator(".inbox-heading")).toContainText(
        "Checked",
      );
      await expect(
        popup.page.getByRole("button", { name: "Refresh recent chats" }),
      ).toBeEnabled();
      await expect(popup.page.locator(".popup-footer")).toBeInViewport();
      await popup.page.screenshot({
        path: output + "/popup-to-save-light.png",
      });
      await popup.page
        .getByRole("button", {
          name: "Save Designing a daily writing habit",
          exact: true,
        })
        .click();
      await expect(popup.page.getByRole("status")).toContainText(
        "Chat saved to your archive.",
      );
      expect(
        await popup.page.evaluate(() =>
          window.__uiCommands.some(
            (item) =>
              item.action === "inbox.save" && item.chat.id === "pending1",
          ),
        ),
      ).toBe(true);
      await expect(
        popup.page.getByRole("button", {
          name: "Save Designing a daily writing habit",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        popup.page.getByRole("tab", { name: /^To save/ }).locator(".tab-count"),
      ).toHaveText("6");
    },
  );
  await check(
    "Saved-only full-text search keeps total count and quiet Open rows",
    async () => {
      await popup.page
        .getByRole("tab", { name: /^To save/ })
        .press("ArrowRight");
      await expect(
        popup.page.getByRole("tab", { name: /^Saved/ }),
      ).toHaveAttribute("aria-selected", "true");
      const total = await popup.page
        .getByRole("tab", { name: /^Saved/ })
        .locator(".tab-count")
        .textContent();
      await expect(
        popup.page.getByRole("textbox", { name: "Search saved chats" }),
      ).toBeVisible();
      await expect(
        popup.page.getByRole("button", { name: "Open full archive" }),
      ).toBeVisible();
      await expect(
        popup.page.locator(
          "#popup-panel-saved .row-save, #popup-panel-saved .badge",
        ),
      ).toHaveCount(0);
      await expect(
        popup.page.getByRole("button", {
          name: "Open A better way to organize your ideas",
          exact: true,
        }),
      ).toBeVisible();
      await popup.page.screenshot({ path: output + "/popup-saved-light.png" });
      await popup.page
        .getByRole("textbox", { name: "Search saved chats" })
        .fill("deeptranscript");
      await expect(popup.page.locator(".saved-heading")).toContainText(
        "1 match",
      );
      await expect(
        popup.page.getByRole("tab", { name: /^Saved/ }).locator(".tab-count"),
      ).toHaveText(total);
      expect(
        await popup.page.evaluate(() =>
          window.__uiCommands.some(
            (item) =>
              item.action === "archive.search" &&
              item.query === "deeptranscript",
          ),
        ),
      ).toBe(true);
      await popup.page.screenshot({ path: output + "/popup-search.png" });
    },
  );
  await check(
    "Save current chat errors stay honest and Saved list scrolls inside 600px",
    async () => {
      await popup.page
        .getByRole("button", { name: "Save current chat", exact: true })
        .click();
      await expect(popup.page.getByRole("alert")).toContainText(
        "Open a supported conversation tab first.",
      );
      await popup.page
        .getByRole("textbox", { name: "Search saved chats" })
        .fill("");
      await expect(
        popup.page.getByText("Saved thought 6", { exact: true }),
      ).toBeAttached();
      const scroll = await popup.page
        .locator(".popup-results")
        .evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        });
      expect(scroll).toBeGreaterThan(0);
      await expect(
        popup.page.getByText("Saved thought 6", { exact: true }),
      ).toBeInViewport();
      await expect(popup.page.locator(".popup-footer")).toBeInViewport();
      expect(
        await popup.page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= 600,
        ),
      ).toBe(true);
      await expect(popup.page.locator(".popup-footer")).not.toContainText(
        "deliveries",
      );
      await popup.page.screenshot({
        path: output + "/popup-saved-scrolled.png",
      });
    },
  );
  await check(
    "Recent bulk save uses configured limit and empty To save can refresh",
    async () => {
      await popup.page.getByRole("tab", { name: /^To save/ }).click();
      await expect(
        popup.page.getByRole("textbox", { name: "Search saved chats" }),
      ).toHaveCount(0);
      await popup.page
        .getByRole("button", { name: "Save recent chats", exact: true })
        .click();
      await expect(popup.page.getByRole("status")).toContainText(
        "Saving recent chats. You can close this popup while it continues.",
      );
      const command = await popup.page.evaluate(() =>
        window.__uiCommands.findLast((item) => item.action === "sync.run"),
      );
      expect(command.limit).toBe(5);
      expect(command.full).toBeUndefined();
      await popup.page.evaluate(() => {
        window.__fixtureStatus.sync = [];
        window.__fixtureStatus.imports = [];
      });
      await popup.page
        .getByRole("button", { name: "Refresh recent chats" })
        .click();
      await expect(
        popup.page.getByText("No recent chats to save", { exact: true }),
      ).toBeVisible();
      await expect(
        popup.page.getByRole("tab", { name: /^To save/ }).locator(".tab-count"),
      ).toHaveText("0");
      await expect(
        popup.page.getByRole("button", { name: "Refresh recent chats" }),
      ).toBeEnabled();
      await expect(popup.page.locator(".popup-footer")).toBeInViewport();
      await popup.page.screenshot({ path: output + "/popup-empty.png" });
    },
  );
  await popup.context.close();
  const darkPopupStatus = structuredClone(base);
  darkPopupStatus.settings.theme = "dark";
  const darkPopup = await pageWith(darkPopupStatus, true);
  await check(
    "Simplified popup respects dark theme and reduced motion",
    async () => {
      await expect(darkPopup.page.locator("html")).toHaveAttribute(
        "data-theme",
        "dark",
      );
      expect(
        await darkPopup.page.evaluate(
          () => matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      ).toBe(true);
      await expect(darkPopup.page.locator(".popup-footer")).toBeInViewport();
      await darkPopup.page.screenshot({
        path: output + "/popup-to-save-dark.png",
      });
    },
  );
  await darkPopup.context.close();
  const failed = await pageWith({
    ok: false,
    error: "storage_unavailable",
    message: "Archive storage unavailable. Reload to retry.",
  });
  await check(
    "Failed worker status opens recovery, not fresh onboarding",
    async () => {
      await expect(
        failed.page.getByRole("heading", {
          name: "Your workspace could not open.",
        }),
      ).toBeVisible();
      await expect(
        failed.page.getByRole("button", { name: "Reload page", exact: true }),
      ).toBeVisible();
      await expect(
        failed.page.getByRole("heading", {
          name: "Your conversations. Somewhere you own.",
        }),
      ).toHaveCount(0);
    },
  );
  await failed.context.close();
  const activeStatus = structuredClone(base);
  activeStatus.license.state = "active";
  activeStatus.license.canDeactivate = true;
  const active = await pageWith(activeStatus);
  await check(
    "License deactivation requests host access after explicit click",
    async () => {
      await active.page
        .getByRole("button", { name: "License", exact: true })
        .click();
      await active.page
        .getByRole("button", {
          name: "Deactivate this installation",
          exact: true,
        })
        .click();
      expect(
        await active.page.evaluate(() =>
          window.__uiCommands.some(
            (message) => message.action === "license.deactivate",
          ),
        ),
      ).toBe(false);
      await active.page
        .getByRole("button", { name: "Deactivate", exact: true })
        .click();
      await expect(
        active.page.getByText("Installation deactivated.", { exact: true }),
      ).toBeVisible();
      const order = await active.page.evaluate(() => {
        const permission = window.__uiCommands.findIndex((message) =>
          message.permission?.origins?.includes(
            "https://live.dodopayments.com/*",
          ),
        );
        const command = window.__uiCommands.findIndex(
          (message) => message.action === "license.deactivate",
        );
        return permission >= 0 && command > permission;
      });
      expect(order).toBe(true);
    },
  );
  await active.context.close();
  const publicStatus = structuredClone(base);
  publicStatus.sync = [{ provider: "claude", state: "ok", savedCount: 5, discoveredCount: 5, error: null }];
  publicStatus.imports = [{ id: "history:claude", provider: "claude", state: "completed", completedCount: 5, discoveredCount: 5, error: null }];
  publicStatus.claudeConnection = { ok: true, code: "ok", source: "import", checkedAt: new Date().toISOString(), message: "Claude history requests succeeded.", report: "Technical fixture trace: HTTP 200 json" };
  const publicUI = await pageWith(publicStatus);
  await check("Normal settings keep successful checks concise and omit testing panels", async () => {
    await publicUI.page.getByRole("button", { name: /^Capture & history/ }).first().click();
    await expect(publicUI.page.locator(".sync-provider[data-provider=claude]")).toContainText("5 saved this run");
    await expect(publicUI.page.locator(".claude-check-result, .claude-report")).toHaveCount(0);
    await expect(publicUI.page.getByRole("button", { name: "Copy report", exact: true })).toHaveCount(0);
    await publicUI.page.screenshot({ path: output + "/clean-history.png", fullPage: true });
    await publicUI.page.getByRole("button", { name: "Connections", exact: true }).click();
    const claude = publicUI.page.locator('.provider-connection[data-provider="claude"]');
    await expect(claude.locator('.badge')).toHaveText("Connected");
    await expect(claude.getByRole("button", { name: "Check connection", exact: true })).toHaveCount(0);
    await expect(claude.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await expect(publicUI.page.locator(".claude-report, pre")).toHaveCount(0);
    await publicUI.page.getByRole("button", { name: "Data & help", exact: true }).click();
    await expect(publicUI.page.getByRole("heading", { name: "Troubleshooting", exact: true })).toHaveCount(0);
    await expect(publicUI.page.getByText("Advanced testing tools", { exact: true })).toHaveCount(0);
    await expect(publicUI.page.getByRole("button", { name: "Copy diagnostics", exact: true })).toHaveCount(0);
  });
  await check("Custom archive menus support pointer, keyboard, focus dismissal and both themes", async () => {
    await publicUI.page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(publicUI.page.locator("select")).toHaveCount(0);
    const filter = publicUI.page.getByRole("combobox", { name: "Filter provider", exact: true });
    const sort = publicUI.page.getByRole("combobox", { name: "Sort conversations", exact: true });
    await filter.press("End");
    await expect(publicUI.page.getByRole("option", { name: "Grok", exact: true })).toHaveClass(/is-active/);
    await filter.press("Enter");
    await expect(filter).toContainText("Grok");
    await filter.press("Home");
    await filter.press("Enter");
    await expect(filter).toContainText("All providers");
    await sort.press("o");
    await expect(publicUI.page.getByRole("option", { name: "Oldest first", exact: true })).toHaveClass(/is-active/);
    await sort.press("Enter");
    await expect(sort).toContainText("Oldest first");
    await filter.click();
    await publicUI.page.getByRole("option", { name: "Claude", exact: true }).click();
    await expect(filter).toContainText("Claude");
    await filter.click();
    await filter.press("Escape");
    await expect(filter).toBeFocused();
    await filter.click();
    await publicUI.page.getByRole("textbox", { name: "Search full conversations" }).click();
    await expect(filter).toHaveAttribute("aria-expanded", "false");
    await sort.click();
    await publicUI.page.screenshot({ path: output + "/custom-menu-light.png", fullPage: true });
    await sort.press("Tab");
    await expect(sort).toHaveAttribute("aria-expanded", "false");
    await publicUI.page.getByRole("button", { name: "Data & help", exact: true }).click();
    await publicUI.page.getByRole("radio", { name: "Dark", exact: true }).click();
    await publicUI.page.emulateMedia({ reducedMotion: "reduce" });
    await publicUI.page.getByRole("button", { name: "Archive", exact: true }).click();
    await sort.click();
    await expect(publicUI.page.getByRole("listbox", { name: "Sort conversations", exact: true })).toBeVisible();
    await expect(publicUI.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await publicUI.page.screenshot({ path: output + "/custom-menu-dark.png", fullPage: true });
  });
  await publicUI.context.close();
  const unverifiedStatus = structuredClone(base);
  unverifiedStatus.sync = [];
  const unverified = await pageWith(unverifiedStatus);
  await check("Unverified Claude permission stays distinct from a confirmed connection and failed checks remain recoverable", async () => {
    await unverified.page.getByRole("button", { name: "Connections", exact: true }).click();
    const claude = unverified.page.locator('.provider-connection[data-provider="claude"]');
    await expect(claude.locator('.badge')).toHaveText("Site access enabled");
    await claude.getByRole("button", { name: "Check connection", exact: true }).click();
    await expect(claude.locator('.badge')).toHaveText("Needs attention");
    await expect(claude.getByRole("button", { name: "Check connection", exact: true })).toBeEnabled();
    await unverified.page.evaluate(() => { window.__connectionCheckOK = true; });
    await claude.getByRole("button", { name: "Check connection", exact: true }).click();
    await expect(claude.locator('.badge')).toHaveText("Connected");
    await expect(claude.getByRole("button", { name: "Check connection", exact: true })).toHaveCount(0);
    await expect(claude.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await unverified.page.screenshot({ path: output + "/claude-connected-clean.png", fullPage: true });
    await unverified.page.evaluate(() => {
      window.__fixtureStatus.sync = [{ provider: 'claude', state: 'needs_signin', errorCode: 'needs_signin', error: 'Sign in again.', lastRunAt: new Date(Date.now() + 60000).toISOString() }];
      window.sessionStorage.setItem('claude-ui-fixture-state', JSON.stringify(window.__fixtureStatus));
    });
    await unverified.page.reload();
    await unverified.page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(claude.locator('.badge')).toHaveText("Needs attention");
    await expect(claude.getByRole("button", { name: "Check connection", exact: true })).toBeVisible();
  });
  await unverified.context.close();
  const isolatedProviderStatus = structuredClone(publicStatus);
  isolatedProviderStatus.sync.unshift({ provider: "chatgpt", state: "running", savedCount: 0, discoveredCount: 5, errorCode: "rate_limited", error: "Wait before retrying." });
  isolatedProviderStatus.imports.unshift({ id: "history:chatgpt", provider: "chatgpt", state: "running", completedCount: 0, discoveredCount: 5, errorCode: "rate_limited", error: "Wait before retrying.", nextEligibleAt: new Date(Date.now() + 120000).toISOString() });
  const providerPicker = await pageWith(isolatedProviderStatus);
  await check("Claude latest-25 selection is usable while ChatGPT waits and preserves command scope", async () => {
    await providerPicker.page.getByRole("button", { name: /^Capture & history/ }).first().click();
    await expect(providerPicker.page.locator('.sync-provider[data-provider="chatgpt"] .inline-error')).toHaveCount(0);
    const provider = providerPicker.page.getByRole("combobox", { name: "History provider", exact: true });
    await provider.click();
    await providerPicker.page.getByRole("option", { name: "Claude", exact: true }).click();
    const count = providerPicker.page.getByRole("combobox", { name: "Number of recent conversations", exact: true });
    await count.click();
    await providerPicker.page.getByRole("option", { name: /25 chats/ }).click();
    const save = providerPicker.page.getByRole("button", { name: "Save latest 25", exact: true });
    await expect(save).toBeEnabled();
    await expect(providerPicker.page.getByRole("button", { name: "Save available trial history", exact: true })).toBeEnabled();
    await save.click();
    const commands = await providerPicker.page.evaluate(() => window.__uiCommands.filter((command) => command.action === "sync.run"));
    expect(commands).toEqual([{ action: "sync.run", limit: 25, provider: "claude" }]);
  });
  await providerPicker.context.close();
  const limitedStatus = structuredClone(base);
  limitedStatus.historyUsage = [{ provider: "claude", used: 25, limit: 25 }];
  limitedStatus.sync = [{ provider: "claude", state: "ok", savedCount: 0, discoveredCount: 25, errorCode: "trial_history_limit", error: "History allowance used." }];
  limitedStatus.imports = [{ id: "history:claude", provider: "claude", state: "completed", completedCount: 0, discoveredCount: 25, errorCode: "trial_history_limit", error: "History allowance used." }];
  const limited = await pageWith(limitedStatus, false, true);
  await check("History allowance is neutral, exposes usage, and allows a safe media diagnostic copy", async () => {
    await limited.page.getByRole("button", { name: /^Capture & history/ }).click();
    const claude = limited.page.locator('.sync-provider[data-provider="claude"]');
    await expect(claude).toContainText("25/25");
    await expect(claude.locator(".inline-error")).toHaveCount(0);
    await expect(claude.locator(".badge")).toContainText("History allowance used");
    await expect(limited.page.getByText(/saving the current chat remains available/)).toBeVisible();
    await limited.page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(limited.page.locator('.provider-connection[data-provider="claude"] .claude-history-issue')).toHaveCount(0);
    await expect(limited.page.getByText(/This applies to history imports/)).toBeVisible();
    await limited.page.getByRole("button", { name: "Data & help", exact: true }).click();
    await limited.page.getByText("Advanced testing tools", { exact: true }).click();
    await limited.page.getByRole("button", { name: "Copy media diagnostic", exact: true }).click();
    await expect(limited.page.getByText("Media diagnostic copied.", { exact: true })).toBeVisible();
    const copied = await limited.page.evaluate(() => window.__fixtureClipboard);
    expect(JSON.parse(copied)).toMatchObject({ claude: { conversation: { status: 200 } } });
  });
  await limited.context.close();
  const openAction = await pageWith(limitedStatus, true);
  await check("Current-chat saving is the first primary action even when history allowance is used", async () => {
    await expect(openAction.page.locator(".popup-actions button").first()).toHaveText("Save current chat");
    await expect(openAction.page.locator(".popup-actions button").first()).toHaveClass("primary");
    await expect(openAction.page.getByRole("button", { name: "Save current chat", exact: true })).toBeEnabled();
    await expect(openAction.page.locator(".automatic-status")).toHaveText("Automatic saving on");
    await expect(openAction.page.locator(".popup-footer")).toBeInViewport();
    await openAction.page.screenshot({ path: output + "/popup-open-chat-primary.png" });
  });
  await openAction.context.close();
  const grokContext = await browser.newContext();
  const grokPage = await grokContext.newPage();
  await grokPage.route(origin + "/grok-fixture", (route) => route.fulfill({ contentType: "text/html", body: '<title>Grok</title><div id="fixture"></div>' }));
  await grokPage.goto(origin + "/grok-fixture");
  await grokPage.evaluate(async () => {
    const { readVisibleGrokConversation } = await import('/providers/grok/page-capture.ts');
    // Rehydrate the function as executeScript does, with no module closure.
    window.__grokReader = new Function('return (' + readVisibleGrokConversation.toString() + ')')();
  });
  await check("Grok bubbles outside main keep speakers, code and order without nested duplicates or toolbar text", async () => {
    await grokPage.locator('#fixture').evaluate((fixture) => {
      fixture.innerHTML = '<aside><div class="message-bubble">Sidebar chat</div></aside>' +
        '<div hidden><div class="message-bubble">Hidden history</div></div>' +
        '<div contenteditable="true"><div class="message-bubble">Draft prompt</div></div>' +
        '<div id="response-user" class="items-end"><div class="message-bubble user"><div class="response-content-markdown"><p>Test prompt</p></div><button>Copy prompt</button></div></div>' +
        '<div id="response-reply" class="items-start"><div class="message-bubble"><div class="response-content-markdown"><p>Test reply</p><pre><code>if (ready) {\n  save();\n}</code></pre><p>Next paragraph</p><span style="display:none">Hidden token</span></div><div class="action-buttons">Retry response</div><script>secretScript()</script></div></div>';
    });
    const capture = await grokPage.evaluate(() => window.__grokReader(location.href));
    expect(capture.turns).toEqual([
      { role: 'user', text: 'Test prompt' },
      { role: 'assistant', text: 'Test reply\nif (ready) {\n  save();\n}\nNext paragraph' },
    ]);
    expect(capture.truncated).toBe(false);
    expect(capture.text).not.toMatch(/Sidebar|Hidden|Draft|Copy|Retry|secretScript/);
    expect(await grokPage.evaluate(() => window.__grokReader(location.href + '#different'))).toBeNull();
  });
  await check("Grok explicit message attributes and markdown fallback keep unknown speakers honest", async () => {
    await grokPage.locator('#fixture').evaluate((fixture) => {
      fixture.innerHTML = '<div data-testid="user-message"><div class="message-bubble user"><p>One prompt</p></div></div>' +
        '<div data-testid="assistant-message"><div class="response-content-markdown"><p>One reply</p></div></div>' +
        '<div class="response-content-markdown"><p>Unattributed text</p></div>';
    });
    expect(await grokPage.evaluate(() => window.__grokReader(location.href).turns)).toEqual([
      { role: 'user', text: 'One prompt' }, { role: 'assistant', text: 'One reply' }, { role: null, text: 'Unattributed text' },
    ]);
    await grokPage.locator('#fixture').evaluate((fixture) => { fixture.innerHTML = '<main><nav>Home</nav><textarea>Draft</textarea></main>'; });
    expect(await grokPage.evaluate(() => window.__grokReader(location.href))).toMatchObject({ turns: [], text: '', truncated: false });
  });
  await check("Grok limits visible capture size and checks navigation during extraction", async () => {
    await grokPage.locator('#fixture').evaluate((fixture) => {
      fixture.innerHTML = '<div class="message-bubble user"></div>';
      fixture.firstChild.textContent = 'x'.repeat(500100);
    });
    const size = await grokPage.evaluate(() => {
      const capture = window.__grokReader(location.href);
      return { length: capture.text.length, turns: capture.turns.length, truncated: capture.truncated };
    });
    expect(size).toEqual({ length: 500000, turns: 1, truncated: true });
    await grokPage.locator('#fixture').evaluate((fixture) => {
      fixture.innerHTML = '<aside>' + '<div class="message-bubble">Hidden sidebar</div>'.repeat(501) + '</aside>' +
        '<div class="message-bubble user">Visible</div>'.repeat(501);
    });
    const roots = await grokPage.evaluate(() => {
      const capture = window.__grokReader(location.href);
      return { turns: capture.turns.length, truncated: capture.truncated, first: capture.turns[0].text };
    });
    expect(roots).toEqual({ turns: 500, truncated: true, first: 'Visible' });
    expect(await grokPage.evaluate(() => {
      const expected = location.href;
      const original = window.getComputedStyle;
      window.getComputedStyle = (...args) => {
        history.replaceState(null, '', '#another-chat');
        return original(...args);
      };
      try { return window.__grokReader(expected); }
      finally { window.getComputedStyle = original; history.replaceState(null, '', expected); }
    })).toBeNull();
  });
  await grokContext.close();
  const observerContext = await browser.newContext();
  const observerPage = await observerContext.newPage();
  await observerPage.route(origin + "/observer-fixture", (route) => route.fulfill({ contentType: "text/html", body: '<main><div class="font-user">Test prompt</div><div class="font-claude">First reply</div></main>' }));
  await observerPage.goto(origin + "/observer-fixture");
  await check("MoveChat Claude selectors trigger capture from real DOM mutations after streaming stops", async () => {
    await observerPage.evaluate(async () => {
      const { installClaudePageObserver } = await import('/providers/claude/page-observer.ts');
      window.__observerSignals = [];
      window.__observerCleanup = installClaudePageObserver({
        document: window.document, location: { origin: 'https://claude.ai', pathname: '/chat/fixture-chat' }, MutationObserver: window.MutationObserver,
        setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), setInterval: window.setInterval.bind(window),
        addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
      }, (id) => window.__observerSignals.push(id));
    });
    await expect.poll(() => observerPage.evaluate(() => window.__observerSignals)).toEqual(['fixture-chat']);
    await observerPage.evaluate(() => {
      document.querySelector('.font-claude').textContent = 'Second reply';
      const stop = document.createElement('button'); stop.id = 'fixture-stop'; stop.setAttribute('aria-label', 'Stop response'); document.body.append(stop);
    });
    await expect.poll(() => observerPage.evaluate(() => document.getElementById('fixture-stop').getClientRects().length)).toBe(1);
    await observerPage.evaluate(() => document.getElementById('fixture-stop').remove());
    await expect.poll(() => observerPage.evaluate(() => window.__observerSignals.length)).toBe(2);
    await observerPage.evaluate(() => window.__observerCleanup());
  });
  await observerContext.close();
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
  console.log(
    JSON.stringify(
      {
        passed: results.length,
        screenshots: output,
        errors,
        externalRequests: requests,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
