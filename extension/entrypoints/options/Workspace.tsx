import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { branding } from "../../config/branding.ts";
import {
  readRootHandle,
  saveRootHandle,
} from "../../destinations/markdown/handle-store.ts";
import {
  pickerWasCancelled,
  readFolderAccess,
} from "../../destinations/markdown/permission.ts";
import { settingsSchema, type Settings } from "../../core/settings.ts";
import { CLAUDE_ENABLED } from "../../core/provider-features.ts";
import {
  asStatus,
  assertOK,
  deliveryIssueMessage,
  emptyStatus,
  errorMessage,
  licenseLabel,
  providerHost,
  providerLabel,
  providers,
  safeSource,
  send,
  syncMessage,
  when,
  type ArchiveRow,
  type ChatDetail,
  type Provider,
  type Status,
} from "../../ui/api.ts";
import {
  Badge,
  Brand,
  ChatRow,
  Empty,
  Icon,
  Notice,
  ProviderMark,
  radioKeys,
  ThemeEffect,
  Toggle,
} from "../../ui/components.tsx";
import { Select } from "../../ui/Select.tsx";

type Section = "archive" | "connections" | "capture" | "license" | "help";
const sections: Array<{ id: Section; label: string; icon: string }> = [
  { id: "archive", label: "Archive", icon: "archive" },
  { id: "connections", label: "Connections", icon: "link" },
  { id: "capture", label: "Capture & history", icon: "capture" },
  { id: "license", label: "License", icon: "key" },
  { id: "help", label: "Data & help", icon: "help" },
];
const headings: Record<Section, [string, string]> = {
  archive: [
    "A place for your best conversations.",
    "Search the full text of everything you have archived.",
  ],
  connections: [
    "Choose where your conversations go.",
    "Connect your providers and the destinations you trust.",
  ],
  capture: [
    "Save as you go. Keep your history.",
    "Control automatic capture, content and history imports.",
  ],
  license: [
    "Your archive is always yours.",
    "Manage the trial and license for this browser installation.",
  ],
  help: [
    "Make it feel like your workspace.",
    "Appearance and control over your local data.",
  ],
};
type Result = {
  ok?: boolean;
  message?: string;
  error?: string;
  errorCode?: string;
  missingProperties?: string[];
};
type ClaudeProbe = NonNullable<Status["claudeConnection"]>;

export default function Workspace() {
  const supportMode = new URLSearchParams(location.search).get("support") === "1";
  const [status, setStatus] = useState(emptyStatus);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<Section>("archive");
  const [setup, setSetup] = useState(false);
  const [step, setStep] = useState(0);
  const [destination, setDestination] = useState<
    "markdown" | "notion" | "both"
  >("markdown");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [historyProvider, setHistoryProvider] = useState("all");
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [edits, setEdits] = useState<
    Array<{ id: string; conversationKey: string }>
  >([]);
  const [notionToken, setNotionToken] = useState("");
  const [notionDatabase, setNotionDatabase] = useState("");
  const [missingProperties, setMissingProperties] = useState<string[]>([]);
  const [licenseKey, setLicenseKey] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [confirmation, setConfirmation] = useState<
    "clear" | "deactivate" | null
  >(null);
  const [firstSaved, setFirstSaved] = useState(false);
  const [claudeProbe, setClaudeProbe] = useState<ClaudeProbe | null>(null);
  const [claudeToolMessage, setClaudeToolMessage] = useState<string | null>(
    null,
  );
  const claudeResultRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (busy === "check-claude" || busy === "reset-claude" || claudeProbe)
      claudeResultRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "auto",
      });
  }, [busy, claudeProbe]);
  useEffect(() => {
    setNotice(null);
    if (!setup) return;
    const timer = window.setTimeout(
      () =>
        document.querySelector<HTMLHeadingElement>(".setup-stage h1")?.focus(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [step, setup]);

  async function refresh() {
    const next = asStatus(await send({ action: "status.get" }));
    setStatus(next);
    setRefreshKey((value) => value + 1);
    const reviews = await send<unknown>({ action: "edits.list" });
    if (Array.isArray(reviews)) setEdits(reviews);
    return next;
  }
  async function perform(
    name: string,
    work: () => Promise<string | void>,
  ): Promise<boolean> {
    setBusy(name);
    setNotice(null);
    try {
      const message = await work();
      if (message) setNotice({ text: message });
      await refresh();
      return true;
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
      return false;
    } finally {
      setBusy("");
    }
  }
  async function openChat(key: string) {
    setDetailLoading(true);
    try {
      const next = await send<ChatDetail | null>({
        action: "archive.get",
        key,
      });
      if (!next || !Array.isArray(next.messages))
        throw new Error("This conversation is no longer in the archive.");
      setDetail(next);
      location.hash = "chat=" + encodeURIComponent(key);
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    } finally {
      setDetailLoading(false);
    }
  }
  useEffect(() => {
    void refresh()
      .then((next) => {
        if (initialized.current) return;
        initialized.current = true;
        setFolderPath(next.settings.folderDiskPath);
        setDestination(
          next.settings.markdownEnabled
            ? next.notion
              ? "both"
              : "markdown"
            : "notion",
        );
        const hash = location.hash.slice(1);
        setSetup(!next.settings.onboardingComplete || hash === "setup");
        if (hash === "folder") setSection("connections");
        else if (sections.some((item) => item.id === hash))
          setSection(hash as Section);
        const key = new URLSearchParams(hash).get("chat");
        if (key) void openChat(key);
      })
      .catch((error) => setNotice({ text: errorMessage(error), error: true }))
      .finally(() => setLoading(false));
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(
      () => {
        void send<ArchiveRow[]>({
          action: query.trim() ? "archive.search" : "archive.list",
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(filter !== "all" ? { provider: filter } : {}),
        })
          .then((result) => {
            if (active) {
              if (!Array.isArray(result))
                throw new Error("The archive could not be loaded.");
              setRows(result);
            }
          })
          .catch((error) => {
            if (active) setNotice({ text: errorMessage(error), error: true });
          })
          .finally(() => {
            if (active) setSearching(false);
          });
      },
      query ? 220 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, filter, refreshKey]);

  async function settings(patch: Partial<Settings>) {
    const next = await send<Settings | null>({ action: "settings.set", patch });
    const parsed = settingsSchema.strict().safeParse(next);
    if (
      !next ||
      !parsed.success ||
      typeof next.onboardingComplete !== "boolean"
    )
      throw new Error("That setting was not saved. Try again.");
    setStatus((current) => ({ ...current, settings: parsed.data }));
  }
  async function chooseFolder(regrant = false) {
    setBusy("folder");
    setNotice(null);
    try {
      const handle = regrant
        ? await readRootHandle()
        : window.showDirectoryPicker
          ? await window.showDirectoryPicker({ mode: "readwrite" })
          : null;
      if (!handle)
        throw new Error(
          "Folder access is unavailable. Choose a folder in Chrome or use Notion instead.",
        );
      let access = await readFolderAccess(handle);
      if (access !== "granted")
        access = await handle.requestPermission({ mode: "readwrite" });
      if (access !== "granted")
        throw new Error(
          "Folder permission was not granted. Reconnect and allow editing to resume Markdown delivery.",
        );
      await saveRootHandle(handle);
      await browser.storage.local.set({ folderLabel: handle.name });
      await refresh();
      setNotice({ text: "Folder connected: " + handle.name + "." });
    } catch (error) {
      if (!pickerWasCancelled(error))
        setNotice({ text: errorMessage(error), error: true });
    } finally {
      setBusy("");
    }
  }
  async function connect(provider: Provider) {
    setBusy("connect-" + provider);
    setNotice(null);
    try {
      const granted = await browser.permissions.request({
        origins: ["https://" + providerHost(provider) + "/*"],
      });
      if (!granted)
        throw new Error(
          "Site access was not granted. You can connect again whenever you are ready.",
        );
      assertOK(
        await send<Result>({ action: "provider.connect", provider }),
        "Provider connection failed. Try again.",
      );
      await refresh();
      setNotice({
        text:
          providerLabel(provider) +
          " site access enabled. Stay signed in to your provider account.",
      });
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    } finally {
      setBusy("");
    }
  }
  async function connectNotion(createProperties = false) {
    setBusy("notion");
    setNotice(null);
    try {
      if (!notionToken.trim() || !notionDatabase.trim())
        throw new Error(
          "Enter your internal connection token and database URL or ID.",
        );
      const granted = await browser.permissions.request({
        origins: ["https://api.notion.com/*"],
      });
      if (!granted)
        throw new Error(
          "Notion API access was not granted. Click Connect again to allow it.",
        );
      const result = await send<Result>({
        action: "notion.save",
        token: notionToken.trim(),
        databaseId: notionDatabase.trim(),
        ...(createProperties ? { createProperties: true } : {}),
      });
      if (result.errorCode === "missing_properties") {
        setMissingProperties(
          result.missingProperties ?? ["required archive properties"],
        );
        throw new Error(
          result.message ??
            "The database needs archive columns. Review the action below.",
        );
      }
      assertOK(
        result,
        "Notion could not be verified. Check the token and database access.",
      );
      setNotionToken("");
      setMissingProperties([]);
      await refresh();
      setNotice({ text: result.message ?? "Notion connection verified." });
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    } finally {
      setBusy("");
    }
  }
  async function sync(limit: number | null, provider?: "chatgpt" | "claude") {
    await perform("sync", async () => {
      const result = await send({
        action: "sync.run",
        ...(limit === null ? { full: true } : { limit }),
        ...(provider ? { provider } : {}),
      });
      const message = syncMessage(result);
      if (Array.isArray(result) && result.some((item) => item.savedCount > 0))
        setFirstSaved(true);
      return message;
    });
  }
  async function activateLicense() {
    setBusy("activate");
    setNotice(null);
    try {
      if (!licenseKey.trim()) throw new Error("Enter a license key first.");
      if (!status.license.configured)
        throw new Error(
          "License activation is not configured for this build yet.",
        );
      const granted = await browser.permissions.request({
        origins: ["https://live.dodopayments.com/*"],
      });
      if (!granted)
        throw new Error(
          "License service access was not granted. Your key has not been activated.",
        );
      const message = assertOK(
        await send<Result>({
          action: "license.activate",
          licenseKey: licenseKey.trim(),
        }),
        "The license could not be activated.",
      );
      setLicenseKey("");
      await refresh();
      setNotice({
        text: message || "License activated for this installation.",
      });
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    } finally {
      setBusy("");
    }
  }
  async function exportChat(key: string) {
    await perform("export", async () => {
      const markdown = await send<string>({ action: "archive.read", key });
      if (typeof markdown !== "string" || !markdown)
        throw new Error("This conversation could not be exported.");
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        (detail?.title ?? "conversation")
          .replace(/[<>:"/\\|?*]/g, "-")
          .slice(0, 100) + ".md";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return "Markdown export prepared.";
    });
  }
  function navigate(next: Section) {
    setSection(next);
    setDetail(null);
    location.hash = next;
    window.setTimeout(() => headingRef.current?.focus(), 0);
  }
  const destinationReady =
    (destination === "notion" || status.folder === "granted") &&
    (destination === "markdown" || status.notionStatus.state === "connected");
  const historyConnected = status.connected.some(
    (provider) => provider === "chatgpt" || (CLAUDE_ENABLED && provider === "claude"),
  );
  const hasRunningCheckpoint =
    status.sync.some((item) => item.state === "running") ||
    status.imports?.some((item) => item.state === "running") === true;
  const historyRunning =
    status.sync.some(
      (item) => item.state === "running" && !item.error && !item.errorCode,
    ) ||
    status.imports?.some(
      (item) => item.state === "running" && !item.error && !item.errorCode,
    ) === true;
  const hasWaitingCheckpoint =
    status.sync.some((item) => ["rate_limited", "unavailable", "provider_request_failed"].includes(item.errorCode ?? item.error ?? "")) ||
    status.imports?.some((item) => ["rate_limited", "unavailable", "provider_request_failed"].includes(item.errorCode ?? item.error ?? "")) === true;
  const recentCheckLimit = Math.max(
    1,
    Math.min(
      500,
      status.license.historyLimit ??
        (status.license.state === "active" ? 500 : 25),
    ),
  );
  const cappedRecentCount = Math.min(
    status.settings.latestSaveCount,
    recentCheckLimit,
  );
  const recentCheckChoices = [
    ...new Set([
      1,
      5,
      10,
      25,
      ...(status.license.state === "active" ? [50, 100, 250, 500] : []),
      ...(status.license.state === "active" ? [cappedRecentCount] : []),
      recentCheckLimit,
    ]),
  ]
    .filter((count) => count <= recentCheckLimit)
    .sort((a, b) => a - b);
  const effectiveRecentCount = recentCheckChoices.includes(cappedRecentCount)
    ? cappedRecentCount
    : ([...recentCheckChoices]
        .reverse()
        .find((count) => count <= cappedRecentCount) ?? recentCheckChoices[0]);
  const defaultRecentCount =
    effectiveRecentCount ?? recentCheckChoices[0] ?? Math.min(25, recentCheckLimit);
  const selectedRecentCount =
    historyCount !== null && recentCheckChoices.includes(historyCount)
      ? historyCount
      : defaultRecentCount;
  const historyProviderChoices = [
    { value: "all", label: "All connected providers" },
    ...(["chatgpt", "claude"] as const)
      .filter((provider) => (provider !== "claude" || CLAUDE_ENABLED) && status.connected.includes(provider))
      .map((provider) => ({ value: provider, label: providerLabel(provider) })),
  ];
  const selectedHistoryProvider = historyProviderChoices.some((option) => option.value === historyProvider) && historyProvider !== "all"
    ? historyProvider as "chatgpt" | "claude"
    : undefined;
  function providerHasImportLock(provider?: "chatgpt" | "claude") {
    const checkpoints = [...status.sync, ...(status.imports ?? [])];
    const relevant = provider ? checkpoints.filter((item) => item.provider === provider) : checkpoints;
    return relevant.some((item) =>
      item.state === "running" ||
      ["rate_limited", "unavailable", "provider_request_failed"].includes(item.errorCode ?? item.error ?? ""),
    );
  }
  function providerHasRunningCheckpoint(provider?: "chatgpt" | "claude") {
    const checkpoints = [...status.sync, ...(status.imports ?? [])];
    return checkpoints.some(
      (item) =>
        item.state === "running" &&
        !item.error &&
        !item.errorCode &&
        (!provider || item.provider === provider),
    );
  }
  const selectedImportLocked = providerHasImportLock(selectedHistoryProvider);
  const selectedHistoryRunning = providerHasRunningCheckpoint(selectedHistoryProvider);
  async function retryProvider(provider: "chatgpt" | "claude") {
    await perform("retry-" + provider, async () => {
      const result = await send({ action: "sync.resume", provider });
      syncMessage(result);
      const selected = Array.isArray(result)
        ? result.filter((item) => item.provider === provider)
        : [];
      if (
        selected.some((item) =>
          ["rate_limited", "unavailable", "provider_request_failed"].includes(
            item.errorCode ?? item.error,
          ),
        )
      )
        return (
          providerLabel(provider) +
          " is waiting for an automatic retry. Saved progress is kept."
        );
      if (
        selected.some(
          (item) =>
            item.error &&
            ((item.errorCode ?? item.error) !== "claude_accounts_skipped" ||
              ["paused", "failed", "error"].includes(item.state)),
        )
      )
        return (
          providerLabel(provider) +
          " still needs attention. Open the provider in Chrome, refresh its tab, then retry."
        );
      return (
        providerLabel(provider) + " is checking your saved import progress."
      );
    });
  }
  async function checkClaudeConnection(reset = false) {
    setBusy(reset ? "reset-claude" : "check-claude");
    setClaudeToolMessage(null);
    try {
      if (reset) {
        assertOK(
          await send<Result>({ action: "provider.reset", provider: "claude" }),
          "The local connection state could not be reset.",
        );
        setClaudeProbe(null);
        setStatus((current) => ({ ...current, claudeConnection: null }));
        await refresh().catch(() => {});
        setBusy("check-claude");
      }
      const result = await send<ClaudeProbe>({
        action: "provider.check",
        provider: "claude",
      });
      if (
        !result ||
        typeof result.ok !== "boolean" ||
        typeof result.message !== "string" ||
        typeof result.report !== "string"
      )
        throw new Error(
          "The connection check did not return a result. Try again.",
        );
      setClaudeProbe({
        ...result,
        checkedAt:
          typeof result.checkedAt === "string"
            ? result.checkedAt
            : new Date().toISOString(),
      });
    } catch (error) {
      setClaudeProbe({
        ok: false,
        code: "unavailable",
        message: errorMessage(error),
        report: "",
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setBusy("");
    }
  }
  const persistedClaudeProbe = status.claudeConnection ?? null;
  const latestClaudeProbe = !claudeProbe
    ? persistedClaudeProbe
    : !persistedClaudeProbe ||
        (Date.parse(claudeProbe.checkedAt) || 0) >=
          (Date.parse(persistedClaudeProbe.checkedAt) || 0)
      ? claudeProbe
      : persistedClaudeProbe;
  async function copyClaudeReport() {
    if (!latestClaudeProbe) return;
    try {
      await navigator.clipboard.writeText(
        [
          latestClaudeProbe.message,
          "Checked: " + latestClaudeProbe.checkedAt,
          latestClaudeProbe.report,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      setClaudeToolMessage("Report copied.");
    } catch {
      setClaudeToolMessage(
        "Could not copy the report. Select the report text and copy it.",
      );
    }
  }
  function claudeCheckPanel(inHistory = false) {
    const checking = busy === "check-claude" || busy === "reset-claude";
    const probe = latestClaudeProbe;
    if (!supportMode) {
      return (
        <>
          {checking ? (
            <p className="sync-guidance" role="status" aria-live="polite">Checking Claude connection…</p>
          ) : probe && probe.source !== "import" ? (
            <p className={probe.ok ? "sync-guidance" : "inline-error"} role={probe.ok ? "status" : "alert"}>
              {probe.ok ? "Claude is connected." : providerIssueText(probe.code)}
            </p>
          ) : null}
        </>
      );
    }
    return (
      <>
        {checking ? (
          <div className="claude-check-result checking" role="status" aria-live="polite">
            <Icon name="refresh" size={15} />
            {busy === "reset-claude" ? "Resetting local connection state…" : "Checking Claude connection…"}
          </div>
        ) : probe && (
          <div className={"claude-check-result " + (probe.ok ? "passed" : "failed")} role={probe.ok ? "status" : "alert"} aria-live="polite">
            <div className="claude-check-heading">
              <strong>{probe.source === "import" ? "Last history import report" : "Last connection check"}</strong>
              <time dateTime={probe.checkedAt} title={new Date(probe.checkedAt).toLocaleString()}>Checked {when(probe.checkedAt)}</time>
            </div>
            {probe.ok && (
              <p>{probe.source === "import" ? "History check finished" : "Claude connected"}</p>
            )}
            {!probe.ok && <p>{probe.message}</p>}
            <details open={!probe.ok} className="claude-report-details">
              <summary>{probe.source === "import" ? "History import details" : "Connection details"}</summary>
              {probe.ok && <p>{probe.message}</p>}
              {probe.report && <pre className="claude-report">{probe.report}</pre>}
              <div className="actions">
                <button className="secondary" onClick={() => void copyClaudeReport()}>Copy report</button>
                {probe.ok && !inHistory && (
                  <button className="text-button" onClick={() => navigate("capture")}>Capture & history <Icon name="arrow" size={14} /></button>
                )}
              </div>
            </details>
            {probe.source === "import" ? !probe.ok && <p className="claude-check-guidance">Share this report if you need help with the failed history import.</p> : probe.ok && <p className="claude-check-guidance">Connected Claude chats can be saved.</p>}
          </div>
        )}
        {claudeToolMessage && <p className="claude-tool-message" role="status" aria-live="polite">{claudeToolMessage}</p>}
      </>
    );
  }
  const sortedRows = rows
    .filter((row) => filter === "all" || row.provider === filter)
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "oldest"
          ? a.capturedAt.localeCompare(b.capturedAt)
          : b.capturedAt.localeCompare(a.capturedAt),
    );

  function providersPanel() {
    const historyLimited =
      status.sync.some(
        (item) => (item.errorCode ?? item.error) === "trial_history_limit",
      ) ||
      status.imports?.some(
        (item) => (item.errorCode ?? item.error) === "trial_history_limit",
      );
    return (
      <div className="provider-list">
        {providers.map((provider) => {
          const connected = status.connected.includes(provider);
          const item = status.sync.find((entry) => entry.provider === provider);
          const itemWaiting = ["rate_limited", "unavailable", "provider_request_failed"].includes(
            item?.errorCode ?? item?.error ?? "",
          );
          const progress = status.imports?.find(
            (entry) => entry.provider === provider,
          );
          const coverageNotice =
            provider === "claude" &&
            progress?.state === "completed" &&
            (progress.errorCode ?? item?.errorCode) ===
              "claude_accounts_skipped";
          const providerHistoryLimited =
            (progress?.errorCode ?? progress?.error ?? item?.errorCode ?? item?.error) ===
            "trial_history_limit";
          const historyIssue = Boolean(
            !providerHistoryLimited &&
              ((!coverageNotice && (item?.error || progress?.error)) ||
                ["paused", "failed"].includes(progress?.state ?? "")),
          );
          const probe = provider === "claude" ? latestClaudeProbe : null;
          const healthyProbe = Boolean(probe?.ok);
          const failedLatestProbe = Boolean(probe && !probe.ok);
          const itemErrorCode = item?.errorCode ?? item?.error;
          const itemErrorIsCurrent = Boolean(
            !healthyProbe ||
              (item?.lastRunAt &&
                (Date.parse(item.lastRunAt) || 0) >
                  (Date.parse(probe?.checkedAt ?? "") || 0)),
          );
          const actionableItemError = Boolean(
            itemErrorIsCurrent &&
              itemErrorCode !== "trial_history_limit" &&
              !(itemErrorCode === "claude_accounts_skipped" && progress?.state === "completed") &&
              (item?.error ||
                ["error", "needs_signin"].includes(item?.state ?? "")),
          );
          const actionableProgressError = Boolean(
            !healthyProbe &&
              (progress?.errorCode ?? progress?.error) !== "trial_history_limit" &&
              !(
                (progress?.errorCode ?? progress?.error) === "claude_accounts_skipped" &&
                progress?.state === "completed"
              ) &&
              (progress?.error ||
                ["failed", "error", "paused"].includes(progress?.state ?? "")),
          );
          const claudeNeedsAttention = Boolean(
            provider === "claude" &&
              (failedLatestProbe || actionableItemError || actionableProgressError),
          );
          const checking =
            provider === "claude" &&
            (busy === "check-claude" || busy === "reset-claude");
          return (
            <div
              className="provider-connection"
              key={provider}
              data-provider={provider}
            >
              <div className="connection-row">
                <ProviderMark provider={provider} />
                <div className="connection-copy">
                  <strong>{providerLabel(provider)}</strong>
                  <small>
                    {providerHost(provider)}
                    {provider === "grok"
                      ? " · Open chat only"
                      : " · Automatic capture & history"}
                  </small>
                  {item?.error && !providerHistoryLimited && provider !== "claude" && (
                    <span className={itemWaiting ? "sync-guidance" : "inline-error"}>
                      {itemWaiting
                        ? "Waiting for an automatic retry while Chrome is open."
                        : providerIssueText(item.errorCode ?? item.error)}
                    </span>
                  )}
                </div>
                {connected ? (
                  <>
                    <Badge
                      tone={
                        provider === "claude"
                          ? checking
                            ? "blue"
                            : claudeNeedsAttention || supportMode && coverageNotice
                              ? "warn"
                              : supportMode && probe
                              ? probe.ok
                                ? "good"
                                : "warn"
                              : "good"
                          : item?.state === "needs_signin" ||
                              item?.state === "error"
                            ? "warn"
                            : "good"
                      }
                    >
                      {provider === "claude"
                        ? checking
                          ? "Checking"
                          : claudeNeedsAttention
                            ? "Needs attention"
                            : supportMode && coverageNotice
                              ? "Some workspaces unavailable"
                            : supportMode && probe
                              ? probe.source === "import"
                                ? probe.ok
                                  ? "Last import passed"
                                  : "Last import failed"
                                : probe.ok
                                  ? "Last check passed"
                                  : "Last check failed"
                            : healthyProbe
                              ? "Connected"
                              : "Site access enabled"
                        : item?.state === "needs_signin"
                          ? "Sign in needed"
                          : item?.state === "error"
                            ? "Needs attention"
                            : "Site access enabled"}
                    </Badge>
                    {provider === "claude" &&
                      !setup &&
                      (supportMode || checking || !healthyProbe || claudeNeedsAttention) && (
                      <button
                        className="secondary"
                        disabled={!!busy}
                        onClick={() => void checkClaudeConnection()}
                      >
                        {checking ? "Checking…" : "Check connection"}
                      </button>
                    )}
                    {supportMode && provider === "claude" &&
                      !setup &&
                      probe?.source !== "import" && probe?.ok === false && (
                        <button
                          className="text-button"
                          disabled={!!busy}
                          onClick={() => void checkClaudeConnection(true)}
                        >
                          Reset connection
                        </button>
                      )}
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() =>
                        void perform("disconnect", async () =>
                          assertOK(
                            await send({
                              action: "provider.disconnect",
                              provider,
                            }),
                            "Could not disconnect.",
                          ),
                        )
                      }
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => void connect(provider)}
                  >
                    {busy === "connect-" + provider ? "Requesting…" : "Connect"}
                  </button>
                )}
              </div>
              {provider === "claude" && connected && !setup && (supportMode || checking || (probe?.source !== "import" && !!probe)) && (
                <div className="claude-diagnostics" ref={claudeResultRef}>
                  <p className="claude-connection-help">
                    Uses your signed-in Claude tab. No separate sign-in popup.
                  </p>
                  {claudeCheckPanel()}
                  {supportMode && historyIssue && (
                    <button className="text-button" onClick={() => navigate("capture")}>
                      View history import <Icon name="arrow" size={14} />
                    </button>
                  )}
                  {supportMode && coverageNotice && (
                    <p className="sync-guidance">Saved accessible Claude history. Some Claude workspaces were unavailable; those chats were not imported.</p>
                  )}
                  {probe?.source !== "import" && probe?.ok === false && (
                    <p className="claude-reset-note">
                      Reset keeps saved chats, your Claude sign-in and import
                      progress, then runs a fresh connection check.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {historyLimited && (
          <p className="sync-guidance">
            History allowance used. This applies to history imports; saving the
            current chat remains available.
          </p>
        )}
      </div>
    );
  }
  function folderPanel() {
    const testNote = status.folder === "granted" && !busy;
    return (
      <div className="folder-panel">
        <span className="destination-icon">
          <Icon name="folder" size={24} />
        </span>
        <div className="connection-copy">
          <strong>{status.folderName ?? "Choose a folder"}</strong>
          <small>Plain Markdown files · Open this folder in Obsidian</small>
          <small>A test note should appear in the selected Obsidian vault.</small>
          <small>
            {status.folder === "granted"
              ? "Folder access is ready."
              : status.folder === "missing"
                ? "Chrome will ask you to allow editing."
                : "Folder permission needs to be renewed."}
          </small>
        </div>
        <div className="actions">
          <button
            className="secondary"
            disabled={!testNote}
            onClick={() =>
              void perform("folder-test", async () => {
                const result = await send<{
                  ok: boolean;
                  status: "written" | "blocked";
                  path?: string;
                }>({ action: "folder.writeTest" });
                if (!result || result.ok !== true || result.status !== "written")
                  throw new Error("The test note could not be written to the selected folder.");
                return `Test note written: ${result.path ?? "test note"}. Check the selected Obsidian vault.`;
              })
            }
          >
            {busy === "folder-test" ? "Writing test note…" : "Write test note"}
          </button>
          {status.folder !== "missing" && (
            <Badge tone={status.folder === "granted" ? "good" : "warn"}>
              {status.folder === "granted" ? "Connected" : "Permission needed"}
            </Badge>
          )}
          {status.folder !== "missing" && status.folder !== "granted" && (
            <button
              className="primary"
              disabled={!!busy}
              onClick={() => void chooseFolder(true)}
            >
              Reconnect
            </button>
          )}
          <button
            className="secondary"
            disabled={!!busy}
            onClick={() => void chooseFolder()}
          >
            {status.folderName ? "Change folder" : "Choose folder"}
          </button>
        </div>
      </div>
    );
  }
  function notionPanel() {
    return (
      <div className="notion-panel">
        <div className="connection-row">
          <ProviderMark provider="notion" />
          <div className="connection-copy">
            <strong>Notion</strong>
            <small>A direct connection to your database</small>
            <small>Connect your own Notion workspace. Its API and plan limits apply; saving a chat can use multiple requests.</small>
          </div>
          <Badge
            tone={
              status.notionStatus.state === "connected"
                ? "good"
                : status.notionStatus.state === "error"
                  ? "warn"
                  : "neutral"
            }
          >
            {status.notionStatus.state === "connected"
              ? "Connected"
              : status.notionStatus.state === "error"
                ? "Needs attention"
                : status.notionStatus.state === "waiting"
                  ? "Waiting"
                  : "Not connected"}
          </Badge>
          {status.notion && (
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() =>
                void perform("notion-disconnect", async () =>
                  assertOK(
                    await send({ action: "notion.disconnect" }),
                    "Could not disconnect Notion.",
                  ),
                )
              }
            >
              Disconnect
            </button>
          )}
        </div>
        {status.notionStatus.message && (
          <p
            className={
              status.notionStatus.state === "error"
                ? "inline-error"
                : "setting-note"
            }
          >
            {status.notionStatus.message}
          </p>
        )}
        {status.notionStatus.nextRetryAt && (
          <p className="setting-note">
            Automatic retry not before {new Date(status.notionStatus.nextRetryAt).toLocaleString()}.
          </p>
        )}
        <details open={!status.notion}>
          <summary>
            {status.notion
              ? "Update connection"
              : "Set up your Notion connection"}
          </summary>
          <p className="muted">
            Create an internal connection with read, insert and update content
            access. Share your test database with that connection before
            continuing. The token is stored locally in this browser.
          </p>
          <a
            className="inline-link"
            href="https://developers.notion.com/guides/get-started/internal-connections"
            target="_blank"
            rel="noreferrer"
          >
            Open Notion setup guide <Icon name="external" size={13} />
          </a>
          <div className="field-grid">
            <label>
              Internal connection token
              <input
                type="password"
                autoComplete="off"
                value={notionToken}
                onChange={(event) => setNotionToken(event.target.value)}
                placeholder="Enter token locally"
              />
            </label>
            <label>
              Database URL or ID
              <input
                value={notionDatabase}
                onChange={(event) => setNotionDatabase(event.target.value)}
                placeholder="https://www.notion.so/…"
              />
            </label>
          </div>
          {missingProperties.length > 0 && (
            <div className="schema-notice">
              <strong>Database columns needed</strong>
              <p>
                Missing: {missingProperties.join(", ")}. This action adds the
                required columns to your database.
              </p>
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() => void connectNotion(true)}
              >
                Create required columns & connect
              </button>
            </div>
          )}
          <button
            className="primary"
            disabled={!!busy || !notionToken.trim() || !notionDatabase.trim()}
            onClick={() => void connectNotion()}
          >
            {busy === "notion" ? "Verifying…" : "Verify & connect"}
          </button>
        </details>
      </div>
    );
  }
  function capturePanel() {
    const change = (patch: Partial<Settings>) =>
      void perform("settings", () => settings(patch));
    return (
      <>
        <Toggle
          label="Automatic capture"
          description={CLAUDE_ENABLED ? "ChatGPT and Claude while Chrome is open. Grok stays manual." : "ChatGPT while Chrome is open. Grok stays manual."}
          checked={status.settings.autoSync}
          disabled={!!busy || !status.license.autoCaptureAllowed}
          onChange={() => change({ autoSync: !status.settings.autoSync })}
        />
        {!status.license.autoCaptureAllowed && (
          <p className="setting-note">
            {licenseLabel(status.license)}. Your archive and manual Markdown
            exports remain available.
          </p>
        )}
        <Toggle
          label="Created files"
          description="Save supported generated files; unavailable content keeps a readable warning."
          checked={status.settings.saveCreatedFiles}
          disabled={!!busy}
          onChange={() =>
            change({ saveCreatedFiles: !status.settings.saveCreatedFiles })
          }
        />
        <Toggle
          label="Uploaded files"
          description="Save supported attachments. Some provider files may be unavailable."
          checked={status.settings.saveUploadedFiles}
          disabled={!!busy}
          onChange={() =>
            change({ saveUploadedFiles: !status.settings.saveUploadedFiles })
          }
        />
        {CLAUDE_ENABLED && <Toggle
          label="Claude artifacts"
          description="Save supported artifact source contents beside Markdown. Dedicated ChatGPT Canvas recovery is unavailable; inaccessible files are reported in the note."
          checked={status.settings.saveCodeGallery}
          disabled={!!busy}
          onChange={() => change({ saveCodeGallery: !status.settings.saveCodeGallery })}
        />}
        <Toggle
          label="Include sources"
          description="Keep citation markers and source lists where the provider supplies them."
          checked={status.settings.includeSources}
          disabled={!!busy}
          onChange={() =>
            change({ includeSources: !status.settings.includeSources })
          }
        />
        {CLAUDE_ENABLED && <Toggle
          label="Claude project conversations"
          description="Group conversations using project information when provided."
          checked={status.settings.saveClaudeProjects}
          disabled={!!busy}
          onChange={() =>
            change({ saveClaudeProjects: !status.settings.saveClaudeProjects })
          }
        />}
        {CLAUDE_ENABLED && <Toggle
          label="Claude Cowork sessions"
          description="Off by default. Sessions may contain terminal output and local file contents."
          checked={status.settings.saveCowork}
          disabled={!!busy}
          onChange={() => change({ saveCowork: !status.settings.saveCowork })}
        />}
        <p className="availability-note">
          Dedicated ChatGPT Canvas recovery is still unavailable. Inaccessible
          artifact files are reported in the saved note.
        </p>
        <label className="setting-row">
          <span>
            <strong>Recent conversations to check</strong>
            <small>
              {status.license.state === "active" &&
              status.license.historyLimit === null
                ? "Choose how many recent conversations to check per provider. Your active license supports larger history checks."
                : status.license.state === "trial"
                  ? "Your trial includes up to " +
                    recentCheckLimit +
                    " unique historical conversations per provider."
                  : "Checks are limited to " +
                    recentCheckLimit +
                    " per provider. History saving resumes when your access is active."}
            </small>
          </span>
          <Select
            label="Recent conversations to check"
            value={String(effectiveRecentCount)}
            options={recentCheckChoices.map((count) => ({ value: String(count), label: count + " chats" }))}
            disabled={!!busy}
            onChange={(value) => change({ latestSaveCount: Number(value) })}
          />
        </label>
      </>
    );
  }
  function statusPanel() {
    const trialLimited =
      status.sync.some(
        (item) => (item.errorCode ?? item.error) === "trial_history_limit",
      ) ||
      status.imports?.some(
        (item) => (item.errorCode ?? item.error) === "trial_history_limit",
      );
    return (
      <div className="sync-list">
        {trialLimited && (
          <p className="sync-guidance">
            History allowance used. This allowance applies to history imports;
            saving the current chat remains available.
            {status.settings.autoSync && status.license.autoCaptureAllowed
              ? " Automatic new-chat saving is on."
              : ""}
          </p>
        )}
        {(CLAUDE_ENABLED ? ["chatgpt", "claude"] as const : ["chatgpt"] as const)
          .filter((provider) => status.connected.includes(provider))
          .map((provider) => {
            const item = status.sync.find(
              (entry) => entry.provider === provider,
            );
            const progress = status.imports?.find(
              (entry) => entry.provider === provider,
            );
            const error = progress?.error || item?.error;
            const state = progress?.state ?? item?.state ?? "idle";
            const code = progress?.errorCode ?? item?.errorCode ?? error;
            const historyLimited = code === "trial_history_limit";
            const partialCoverage = provider === "claude" && code === "claude_accounts_skipped";
            const waiting = [
              "rate_limited",
              "unavailable",
              "provider_request_failed",
            ].includes(code ?? "");
            const retryable =
              partialCoverage ||
              !waiting &&
              code !== "trial_history_limit" &&
              ([
                "blocked",
                "failed",
                "paused",
                "error",
                "needs_signin",
              ].includes(state) ||
                (state === "running" && Boolean(error)));
            const issue = !partialCoverage && !waiting && error ? providerIssueText(code ?? error) : null;
            return (
              <div className="sync-provider" data-provider={provider} key={provider}>
              <div className="sync-row">
                <ProviderMark provider={provider} />
                <div>
                  <strong>{providerLabel(provider)}</strong>
                  <small>
                    {(() => {
                      const usage = status.historyUsage?.find(
                        (entry) => entry.provider === provider,
                      );
                      const usageText = usage
                        ? usage.limit === null && status.license.state === "active"
                          ? "Full history enabled · "
                          : (historyLimited ? "History allowance used: " : "History imports: ") + usage.used + (usage.limit === null ? "" : "/" + usage.limit) + " · "
                        : "";
                      return usageText + (progress
                      ? (progress.completedCount ?? 0) +
                        " saved this run · " +
                        (progress.discoveredCount ?? 0) +
                        " found"
                      : item
                        ? item.savedCount +
                          " archived · " +
                          when(item.lastRunAt)
                        : "Ready for your first history save");
                    })()}
                  </small>
                  {issue && <span className={historyLimited ? "sync-guidance" : "inline-error"}>{issue}</span>}
                  {partialCoverage && <span className="sync-guidance">Saved accessible Claude history. Some Claude workspaces were unavailable; those chats were not imported.</span>}
                  {(retryable || partialCoverage) && (
                    <span className="sync-guidance">
                      {partialCoverage
                        ? "Saved chats are ready. Retry later if access to another Claude workspace changes."
                        : `Open ${providerLabel(provider)}, refresh its tab, then retry. Saved import progress is kept.`}
                    </span>
                  )}
                  {waiting && (
                    <span className="sync-guidance">
                      {progress?.nextEligibleAt
                        ? "Saving will resume automatically after " +
                          new Date(progress.nextEligibleAt).toLocaleString(undefined, {
                            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                          }) +
                          " while Chrome is open. This is the earliest retry time; the provider may still ask us to wait."
                        : "Saving will resume automatically when the provider is ready while Chrome is open."}{" "}
                      Saved import progress is kept.
                    </span>
                  )}
                </div>
                <Badge
                  tone={
                    partialCoverage || retryable || (error && !historyLimited && !waiting)
                      ? "warn"
                      : item?.state === "ok"
                        ? "good"
                        : "neutral"
                  }
                >
                  {partialCoverage
                    ? "Some workspaces unavailable"
                    : historyLimited
                    ? "History allowance used"
                    : waiting
                    ? "Waiting"
                    : retryable
                      ? state === "paused" && (!error || code === "paused")
                        ? "Paused"
                        : "Needs attention"
                      : state === "running"
                        ? "Saving"
                        : state === "ok" || state === "completed"
                          ? "Check finished"
                          : "Ready"}
                </Badge>
                {retryable && (
                  <div className="sync-actions">
                    <a
                      className="secondary"
                      href={"https://" + providerHost(provider)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open {providerLabel(provider)}{" "}
                      <Icon name="external" size={13} />
                    </a>
                    <button
                      className="secondary"
                      disabled={!!busy || !status.license.canImportHistory}
                      onClick={() => void retryProvider(provider)}
                    >
                      {busy === "retry-" + provider
                        ? "Checking…"
                        : "Retry " + providerLabel(provider)}
                    </button>
                    {supportMode && provider === "claude" && (
                      <button className="secondary" disabled={!!busy} onClick={() => void checkClaudeConnection()}>
                        {busy === "check-claude" ? "Checking…" : "Check connection"}
                      </button>
                    )}
                  </div>
                )}
                {waiting && (
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void perform(
                        "check-provider",
                        async () => "Provider status refreshed.",
                      )
                    }
                  >
                    Check status
                  </button>
                )}
              </div>
              {supportMode && provider === "claude" && (retryable || latestClaudeProbe || busy === "check-claude") && (
                <div className="claude-diagnostics" ref={claudeResultRef}>
                  {retryable && !latestClaudeProbe && busy !== "check-claude" && <p className="claude-connection-help">Check connection to see where access fails. This check does not save chats.</p>}
                  {claudeCheckPanel(true)}
                </div>
              )}
              </div>
            );
          })}
      </div>
    );
  }
  const noticeElement = notice && (
    <Notice error={notice.error} onClose={() => setNotice(null)}>
      <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {notice.text}
      </span>
    </Notice>
  );
  if (!loading && !initialized.current)
    return (
      <>
        <ThemeEffect theme={status.settings.theme} />
        <main className="loading-page">
          <Brand />
          <h1 style={{ fontSize: 25, marginTop: 30 }}>
            Your workspace could not open.
          </h1>
          {noticeElement}
          <button className="primary" onClick={() => location.reload()}>
            Reload page
          </button>
        </main>
      </>
    );
  if (loading)
    return (
      <>
        <ThemeEffect theme={status.settings.theme} />
        <main className="loading-page">
          <Brand />
          <div className="loading-line" />
          <p>Opening your workspace…</p>
          {noticeElement}
        </main>
      </>
    );

  if (setup) {
    const steps = ["Destination", "Providers", "First save", "Pin"];
    const advance = async () => {
      if (
        step === 0 &&
        (!(await perform("settings", () =>
          settings({ markdownEnabled: destination !== "notion" }),
        )) ||
          !destinationReady)
      )
        return;
      if (step === 3) {
        if (
          await perform("finish", () => settings({ onboardingComplete: true }))
        ) {
          setSetup(false);
          navigate("archive");
        }
      } else {
        setStep(step + 1);
        window.scrollTo({ top: 0 });
      }
    };
    return (
      <>
        <ThemeEffect theme={status.settings.theme} />
        <main className={"onboarding" + (step === 3 ? " pin-onboarding" : "")}>
          <header className="setup-header">
            <Brand compact />
            {step !== 3 && (
              <Badge tone="blue">Your workspace, your choice</Badge>
            )}
          </header>
          <ol className="setup-progress">
            {steps.map((name, index) => (
              <li
                key={name}
                className={
                  step === index ? "current" : step > index ? "done" : ""
                }
                aria-current={step === index ? "step" : undefined}
              >
                <span>
                  {step > index ? <Icon name="check" size={14} /> : index + 1}
                </span>
                {name}
              </li>
            ))}
          </ol>
          <section
            className={"setup-stage" + (step === 3 ? " pin-stage" : "")}
            key={step}
          >
            {step !== 3 && (
              <p className="eyebrow">LET’S MAKE ROOM FOR YOUR IDEAS</p>
            )}
            {step === 0 && (
              <>
                <h1>
                  Your conversations.
                  <br />
                  Somewhere you own.
                </h1>
                <p className="lead">
                  Keep useful AI conversations as Markdown files, send them
                  directly to Notion, or save to both.
                </p>
                <div
                  className="destination-choices"
                  role="radiogroup"
                  onKeyDown={radioKeys}
                  aria-label="Save destination"
                >
                  {(
                    [
                      {
                        id: "markdown",
                        label: "Markdown & Obsidian",
                        text: "Your vault or a local folder",
                        icon: "folder",
                      },
                      {
                        id: "notion",
                        label: "Notion",
                        text: "Your connected database",
                        icon: "link",
                      },
                      {
                        id: "both",
                        label: "Both",
                        text: "Local files and Notion",
                        icon: "archive",
                      },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      role="radio"
                      aria-checked={destination === item.id}
                      className={
                        "destination-choice " +
                        (destination === item.id ? "selected" : "")
                      }
                      disabled={!!busy}
                      onClick={() => {
                        setDestination(item.id);
                      }}
                    >
                      <Icon name={item.icon} size={24} />
                      <strong>{item.label}</strong>
                      <small>{item.text}</small>
                      <span className="radio-dot" />
                    </button>
                  ))}
                </div>
                {destination !== "notion" && folderPanel()}
                {destination !== "markdown" && notionPanel()}
                <p className="privacy-line">
                  <Icon name="check" size={14} />
                  Local archive. Optional direct transfer to your Notion
                  workspace.
                </p>
              </>
            )}
            {step === 1 && (
              <>
                <h1>Connect the sites you use.</h1>
                <p className="lead">
                  Chrome will ask to read and change data on each site. That
                  access lets {branding.productName} read conversations from
                  your signed-in account.
                </p>
                {providersPanel()}
                <p className="setting-note">
                  Site access and account sign-in are separate. Stay signed in
                  to each provider. Grok saves the conversation currently open
                  in your tab.
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <h1>Bring in your first conversations.</h1>
                <p className="lead">
                  Start with the latest five conversations from each connected
                  history provider.
                  {status.license.state === "trial"
                    ? " Your trial includes up to " +
                      recentCheckLimit +
                      " unique historical conversations per provider."
                    : status.license.state === "active"
                      ? " You can check more history later in Capture & history."
                      : " History saving needs active trial or license access."}
                </p>
                <div className="panel no-padding">{capturePanel()}</div>
                <div className="panel">
                  {statusPanel()}
                  {!historyConnected && (
                    <Empty title="Grok is ready in your toolbar" icon="capture">
                      Open a Grok conversation, then use Save current chat
                      in the popup.
                    </Empty>
                  )}
                  <div className="first-save-action">
                    <button
                      className="primary"
                      disabled={
                        !!busy ||
                        hasRunningCheckpoint ||
                        hasWaitingCheckpoint ||
                        !historyConnected ||
                        !status.license.canImportHistory ||
                        !destinationReady
                      }
                      onClick={() => void sync(5)}
                    >
                      {busy === "sync" || historyRunning
                        ? "Saving conversations…"
                        : hasWaitingCheckpoint
                          ? "Waiting to continue"
                          : hasRunningCheckpoint
                            ? "Provider needs attention"
                          : firstSaved
                            ? "Check latest five again"
                            : "Save latest five"}
                      <Icon name="arrow" size={17} />
                    </button>
                    <small>
                      {status.sync.reduce((sum, item) => sum + item.savedCount, 0) > 0
                        ? "Saved " + status.sync.reduce((sum, item) => sum + item.savedCount, 0) + " so far."
                        : "Progress is recorded as chats are archived."}
                    </small>
                  </div>
                </div>
                {status.pendingJobs > 0 && (
                  <Notice>
                    {status.pendingJobs} deliveries pending. Your destination
                    may need a moment.
                  </Notice>
                )}
              </>
            )}
            {step === 3 && (
              <>
                <h1 tabIndex={-1}>Pin {branding.productName}</h1>
                <p className="lead">
                  Make the popup easy to open from Chrome’s toolbar.
                </p>
                <ol className="pin-steps">
                  <li>
                    <span className="step-number">1</span>
                    <div>
                      <strong>Open the extensions menu</strong>
                      <p>Click the puzzle-piece icon in Chrome’s toolbar.</p>
                    </div>
                    <span className="pin-menu-icon" aria-hidden="true">
                      <ExtensionsIcon />
                    </span>
                  </li>
                  <li>
                    <span className="step-number">2</span>
                    <div>
                      <strong>Pin {branding.productName}</strong>
                      <p>
                        Find it in the list, then click the pin beside its name.
                      </p>
                      <div className="pin-example" aria-hidden="true">
                        <img src="/assets/chat-archive-logo-v1.png" alt="" />
                        <span>{branding.productName}</span>
                        <Icon name="pin" size={17} />
                      </div>
                    </div>
                  </li>
                </ol>
                <p className="pin-ready">
                  <Icon name="check" size={16} />
                  Setup preferences are ready.
                </p>
                <p className="setting-note">
                  Chrome controls pinning. You can finish now and pin it later.
                </p>
                {(status.sync.some(
                  (item) =>
                    item.error &&
                    ((item.errorCode ?? item.error) !== "claude_accounts_skipped" ||
                      ["paused", "failed", "error"].includes(item.state)),
                ) ||
                  status.imports?.some(
                    (item) =>
                      item.error &&
                      ((item.errorCode ?? item.error) !== "claude_accounts_skipped" ||
                        ["paused", "failed", "error"].includes(item.state)),
                  )) && (
                  <p className="setting-note">
                    A provider still needs attention. Review Capture & history
                    after setup.
                  </p>
                )}
              </>
            )}
            {noticeElement}
          </section>
          <footer className="setup-footer">
            <button
              className="text-button"
              disabled={step === 0 || !!busy}
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
            <span className="muted">{step + 1} / 4</span>
            <div className="setup-finish-actions">
              {step === 3 && (
                <button
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => void advance()}
                >
                  Pin later
                </button>
              )}
              <button
                className="primary"
                disabled={
                  !!busy ||
                  (step === 0 && !destinationReady) ||
                  (step === 1 && status.connected.length === 0)
                }
                onClick={() => void advance()}
              >
                {step === 3
                  ? "Finish setup"
                  : step === 2 && !firstSaved && !historyRunning
                    ? "Save later & continue"
                    : "Continue"}
                <Icon name="arrow" size={17} />
              </button>
            </div>
          </footer>
          {status.settings.onboardingComplete && (
            <button
              className="text-button exit-setup"
              onClick={() => {
                setSetup(false);
                navigate("connections");
              }}
            >
              Return to workspace
            </button>
          )}
        </main>
      </>
    );
  }
  const sectionHeading = headings[section];
  return (
    <>
      <ThemeEffect theme={status.settings.theme} />
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="workspace">
        <aside className="sidebar">
          <Brand />
          <nav aria-label="Workspace">
            {sections.map((item) => (
              <button
                key={item.id}
                className={section === item.id ? "selected" : ""}
                onClick={() => navigate(item.id)}
                aria-current={section === item.id ? "page" : undefined}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.id === "capture" && status.blockedJobs > 0 && (
                  <span className="nav-count">{status.blockedJobs}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <span className="local-indicator">
              <i />
              Stored in this browser
            </span>
            <button className="trial-card" onClick={() => navigate("license")}>
              <Icon name="key" size={17} />
              <span>
                {licenseLabel(status.license)}
                <small>
                  {status.license.state === "trial"
                    ? "No card required"
                    : "Manage this installation"}
                </small>
              </span>
              <Icon name="arrow" size={14} />
            </button>
            <small className="version">
              {branding.productName} · {browser.runtime.getManifest().version}
            </small>
          </div>
        </aside>
        <main className="workspace-main" id="main-content">
          <header className="page-header">
            <div>
              <p className="eyebrow">
                {sections
                  .find((item) => item.id === section)
                  ?.label.toUpperCase()}
              </p>
              <h1 ref={headingRef} tabIndex={-1}>
                {detail ? detail.title : sectionHeading[0]}
              </h1>
              <p>
                {detail
                  ? providerLabel(detail.provider) +
                    " · " +
                    detail.messages.length +
                    " messages"
                  : sectionHeading[1]}
              </p>
            </div>
            {section === "archive" && !detail && (
              <button className="secondary" onClick={() => navigate("capture")}>
                <Icon name="capture" size={16} />
                Save history
              </button>
            )}
          </header>
          {noticeElement}
          {detailLoading && <Notice>Opening conversation…</Notice>}
          {detail ? (
            <>
              <div className="reader-toolbar">
                <button
                  className="secondary"
                  onClick={() => {
                    setDetail(null);
                    location.hash = "archive";
                  }}
                >
                  ← Back to archive
                </button>
                <div className="actions">
                  {safeSource(detail.sourceUrl) && (
                    <a
                      className="secondary"
                      href={safeSource(detail.sourceUrl)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open original <Icon name="external" size={14} />
                    </a>
                  )}
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() => void exportChat(detail.key)}
                  >
                    <Icon name="export" size={16} />
                    Export Markdown
                  </button>
                </div>
              </div>
              {detail.warning && <Notice error>{detail.warning}</Notice>}
              {detail.warnings?.map((warning) => (
                <Notice key={warning}>{warning}</Notice>
              ))}
              <article className="reader">
                {detail.messages.map((message, index) => (
                  <section className="message" key={index}>
                    <div className="message-label">
                      <span>
                        {message.role === "user"
                          ? "Human"
                          : message.role === "assistant"
                            ? "Assistant"
                            : message.role}
                      </span>
                      <small>{String(index + 1).padStart(2, "0")}</small>
                    </div>
                    <div className="markdown">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        skipHtml
                        components={{
                          img: ({ alt }) => (
                            <span className="media-placeholder">
                              Image: {alt || "image"} — preview unavailable in
                              archive reader
                            </span>
                          ),
                          a: ({ href, children }) => (
                            <a
                              href={
                                href && /^https?:\/\//.test(href)
                                  ? href
                                  : undefined
                              }
                              target="_blank"
                              rel="noreferrer"
                            >
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {message.text}
                      </ReactMarkdown>
                    </div>
                  </section>
                ))}
              </article>
            </>
          ) : section === "archive" ? (
            <>
              <div className="archive-tools">
                <label className="search-field">
                  <Icon name="search" size={19} />
                  <input
                    aria-label="Search full conversations"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search conversations, ideas, code…"
                  />
                  {query && (
                    <button
                      className="icon-button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                    >
                      <Icon name="close" size={16} />
                    </button>
                  )}
                </label>
                <label className="sr-only" htmlFor="provider-filter">
                  Filter provider
                </label>
                <Select
                  id="provider-filter"
                  label="Filter provider"
                  value={filter}
                  options={[
                    { value: "all", label: "All providers" },
                    ...providers.map((provider) => ({ value: provider, label: providerLabel(provider) })),
                  ]}
                  onChange={setFilter}
                />
                <label className="sr-only" htmlFor="archive-sort">
                  Sort conversations
                </label>
                <Select
                  id="archive-sort"
                  label="Sort conversations"
                  value={sort}
                  options={[
                    { value: "recent", label: "Newest first" },
                    { value: "oldest", label: "Oldest first" },
                    { value: "title", label: "Title A–Z" },
                  ]}
                  onChange={setSort}
                />
              </div>
              <div className="archive-summary">
                <span>
                  {searching
                    ? "Searching your archive…"
                    : rows.length +
                      " conversation" +
                      (rows.length === 1 ? "" : "s") +
                      (query ? " found" : "")}
                </span>
                <span>Full-text search · Local archive</span>
              </div>
              <div className="archive-list" aria-busy={searching}>
                {sortedRows.length ? (
                  sortedRows.map((row) => (
                    <ChatRow
                      key={row.key}
                      row={row}
                      onOpen={() => void openChat(row.key)}
                    />
                  ))
                ) : (
                  <Empty
                    title={
                      searching
                        ? "Searching…"
                        : query
                          ? "No matching conversations"
                          : "Your ideas have a home now."
                    }
                    icon={query ? "search" : "archive"}
                  >
                    {query
                      ? "Try a different phrase or provider. Search includes transcript text and code."
                      : "Save the current chat from the toolbar or bring in history from Capture & history."}
                  </Empty>
                )}
              </div>
              {status.blockedJobs > 0 && (
                <div className="footer-callout">
                  <Icon name="clock" />
                  <span>
                    {status.blockedJobs} deliveries need your attention.
                  </span>
                  <button
                    className="text-button"
                    onClick={() => navigate("capture")}
                  >
                    Review
                  </button>
                </div>
              )}
            </>
          ) : section === "connections" ? (
            <>
              <Panel
                title="Save destinations"
                description="Your local archive is kept even when a destination needs attention."
              >
                <Toggle
                  label="Markdown & Obsidian"
                  description="Save to an Obsidian vault or any local folder. Optional for Notion-only setups."
                  checked={status.settings.markdownEnabled}
                  disabled={!!busy}
                  onChange={() =>
                    void perform("settings", () =>
                      settings({
                        markdownEnabled: !status.settings.markdownEnabled,
                      }),
                    )
                  }
                />
                {status.settings.markdownEnabled && folderPanel()}
                {notionPanel()}
              </Panel>
              <Panel
                title="Providers"
                description="Enable site access, then keep your provider account signed in."
              >
                {providersPanel()}
                <p className="setting-note">
                  No provider API key is needed. Only the sites you connect
                  receive host permission.
                </p>
              </Panel>
              <Panel
                title="Folder location on disk"
                description="Optional. Chrome cannot discover an absolute folder path automatically."
              >
                <label className="wide-field">
                  Absolute path
                  <input
                    value={folderPath}
                    onChange={(event) => setFolderPath(event.target.value)}
                    placeholder="D:\My vault"
                    maxLength={500}
                  />
                </label>
                <button
                  className="secondary"
                  disabled={
                    !!busy || folderPath === status.settings.folderDiskPath
                  }
                  onClick={() =>
                    void perform("path", async () => {
                      await settings({ folderDiskPath: folderPath });
                      return "Folder path saved.";
                    })
                  }
                >
                  Save path
                </button>
              </Panel>
              <button
                className="text-button"
                onClick={() => {
                  setSetup(true);
                  setStep(0);
                }}
              >
                Review guided setup <Icon name="arrow" size={15} />
              </button>
            </>
          ) : section === "capture" ? (
            <>
              <Panel
                title="Capture preferences"
                description="Rich content support depends on what each provider makes available."
              >
                {capturePanel()}
                <label className="setting-row">
                  <span>
                    <strong>Background check interval</strong>
                    <small>
                      Checks connected history providers while Chrome is open.
                    </small>
                  </span>
                  <Select
                    label="Background check interval"
                    value={String(status.settings.syncIntervalMinutes)}
                    options={[30, 60, 120, 240, 720, 1440].map((minutes) => ({
                      value: String(minutes),
                      label: minutes < 60 ? minutes + " minutes" : minutes / 60 + " hours",
                    }))}
                    disabled={!!busy}
                    onChange={(value) =>
                      void perform("settings", () =>
                        settings({
                          syncIntervalMinutes: Number(value),
                        }),
                      )
                    }
                  />
                </label>
              </Panel>
              <Panel
                title="Bring in your history"
                description={
                  status.license.historyLimit
                    ? "Import up to " +
                      status.license.historyLimit +
                      " historical chats per provider during your trial. This is separate from saving open chats. Repeats update existing chats."
                      : CLAUDE_ENABLED ? "Save available history from ChatGPT and Claude. Repeated saves update existing conversations." : "Save available history from ChatGPT. Repeated saves update existing conversations."
                }
              >
                {statusPanel()}
                <div className="history-actions">
                  <Select
                    className="history-choice"
                    label="History provider"
                    value={selectedHistoryProvider ?? "all"}
                    options={historyProviderChoices}
                    disabled={!!busy || !historyConnected}
                    onChange={setHistoryProvider}
                  />
                  <Select
                    className="history-choice history-count-choice"
                    label="Number of recent conversations"
                    value={String(selectedRecentCount)}
                    options={recentCheckChoices.map((count) => ({ value: String(count), label: count + " chats" }))}
                    disabled={!!busy}
                    onChange={(value) => setHistoryCount(Number(value))}
                  />
                  <button
                    className="primary"
                    disabled={
                      !!busy ||
                      selectedImportLocked ||
                      !(selectedHistoryProvider ? status.connected.includes(selectedHistoryProvider) : historyConnected) ||
                      !status.license.canImportHistory
                    }
                    onClick={() => void sync(selectedRecentCount, selectedHistoryProvider)}
                  >
                    {busy === "sync" || selectedHistoryRunning
                      ? "Saving…"
                      : selectedImportLocked
                        ? "Waiting to continue"
                        : "Save latest " + selectedRecentCount}
                  </button>
                  <button
                    className="secondary"
                    disabled={
                      !!busy ||
                      selectedImportLocked ||
                      !historyConnected ||
                      !status.license.canImportHistory
                    }
                    onClick={() => void sync(null, selectedHistoryProvider)}
                  >
                    {status.license.historyLimit
                      ? "Save available trial history"
                      : "Save all available history"}
                  </button>
                  <button
                    className="text-button"
                    disabled={
                      busy !== "sync" &&
                      !status.imports?.some((item) => item.state === "running")
                    }
                    onClick={() =>
                      void perform("pause", async () =>
                        assertOK(
                          await send({ action: "sync.pause" }),
                          "Could not pause.",
                        ),
                      )
                    }
                  >
                    Pause
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy || !status.license.canImportHistory}
                    onClick={() =>
                      void perform("resume", async () =>
                        syncMessage(await send({ action: "sync.resume" })),
                      )
                    }
                  >
                    Resume
                  </button>
                </div>
                <p className="setting-note">
                  Grok history import is unavailable. Save a currently open Grok
                  conversation from the popup. Counts show archived
                  conversations; destination delivery can continue afterward.
                </p>
              </Panel>
              <Panel
                title="Delivery & edit review"
                description="A file you edited needs a choice before the archive replaces it."
              >
                <div className="delivery-overview">
                  <Badge tone={status.pendingJobs ? "blue" : "neutral"}>
                    {status.pendingJobs} pending
                  </Badge>
                  <Badge tone={status.blockedJobs ? "warn" : "good"}>
                    {status.blockedJobs} need attention
                  </Badge>
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void perform("retry", async () => {
                        const result = await send<{ written?: number }>({
                          action: "queue.run",
                        });
                        if (typeof result.written !== "number")
                          throw new Error(
                            "Destination delivery could not be retried. Try again.",
                          );
                        return (
                          (result.written ?? 0) +
                          " deliveries completed. Check remaining destination status."
                        );
                      })
                    }
                  >
                    <Icon name="refresh" size={15} />
                    Retry delivery
                  </button>
                </div>
                {edits.length ? (
                  edits.map((edit) => (
                    <div className="edit-review" key={edit.id}>
                      <strong>
                        {rows.find((row) => row.key === edit.conversationKey)
                          ?.title ?? "Edited Markdown file"}
                      </strong>
                      <p>
                        Your local edits were detected. Keep your file, accept
                        the incoming copy, or explicitly replace it with the
                        archived version.
                      </p>
                      <div className="actions">
                        {(
                          [
                            { choice: "keep", label: "Keep mine" },
                            { choice: "copy", label: "Keep incoming copy" },
                            { choice: "replace", label: "Replace my file" },
                          ] as const
                        ).map((item) => (
                          <button
                            key={item.choice}
                            className={
                              item.choice === "replace"
                                ? "danger-secondary"
                                : "secondary"
                            }
                            disabled={!!busy}
                            onClick={() =>
                              void perform("edit", async () =>
                                assertOK(
                                  await send({
                                    action: "edits.resolve",
                                    jobId: edit.id,
                                    choice: item.choice,
                                  }),
                                  "Edit review could not be resolved.",
                                ),
                              )
                            }
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="muted">No Markdown edits waiting for review.</p>
                )}
                {status.deliveryIssues
                  ?.filter(
                    (issue) =>
                      issue.destinationId !== "markdown" ||
                      issue.state !== "needs_review",
                  )
                  .map((issue) => (
                    <div className="delivery-issue" key={issue.id}>
                      <div className="delivery-issue-heading">
                        <strong>
                          {issue.title || "Conversation delivery"}
                        </strong>
                        <Badge tone="warn">
                          {issue.destinationId === "notion"
                            ? "Notion"
                            : "Markdown"}{" "}
                          ·{" "}
                          {issue.state === "needs_review"
                            ? "Needs review"
                            : issue.state}
                        </Badge>
                      </div>
                      <p>{deliveryIssueMessage(issue.errorCode)}</p>
                      <div className="actions">
                        {[
                          "permission_required",
                          "destination_disabled",
                          "notion_not_configured",
                          "notion_unauthorized",
                          "notion_forbidden",
                        ].includes(issue.errorCode ?? "") && (
                          <button
                            className="secondary"
                            onClick={() => navigate("connections")}
                          >
                            Review connection <Icon name="arrow" size={14} />
                          </button>
                        )}
                        {issue.destinationId === "notion" && (
                          <button
                            className="secondary"
                            disabled={!!busy}
                            onClick={() =>
                              void perform("delivery-recheck", async () => {
                                const result = await send<{
                                  ok?: boolean;
                                  message?: string;
                                  written?: number;
                                }>({ action: "job.retry", jobId: issue.id });
                                if (
                                  result.ok === false ||
                                  typeof result.written !== "number"
                                )
                                  throw new Error(
                                    result.message ??
                                      "Delivery could not be rechecked. Try again.",
                                  );
                                return "Delivery rechecked. Current destination status is shown below.";
                              })
                            }
                          >
                            <Icon name="refresh" size={14} />
                            Recheck delivery
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
              </Panel>
            </>
          ) : section === "license" ? (
            <>
              <Panel
                title="Your access"
                description="The archive remains readable and exportable after your trial or license becomes inactive."
              >
                <div className="license-overview">
                  <span className="destination-icon">
                    <Icon name="key" size={27} />
                  </span>
                  <div>
                    <Badge
                      tone={
                        status.license.state === "active"
                          ? "good"
                          : status.license.state === "trial"
                            ? "blue"
                            : "warn"
                      }
                    >
                      {licenseLabel(status.license)}
                    </Badge>
                    <h3>
                      {status.license.state === "active"
                        ? "One payment. A lifetime of saving."
                        : status.license.state === "trial"
                          ? "Try your own conversation archive."
                          : status.license.state === "license_unavailable"
                            ? "We could not verify your access."
                            : "Keep your archive. Resume saving when ready."}
                    </h3>
                    <p>
                      {status.license.state === "trial"
                        ? "14-day trial, no payment card. Latest 25 historical conversations per provider."
                        : status.license.state === "license_unavailable"
                          ? "A network or configuration issue may be preventing verification. Check again or review activation below."
                          : "Your conversations stay stored in this browser. Search and manual Markdown export remain available."}
                    </p>
                  </div>
                </div>
                <div className="actions">
                  {status.license.checkoutUrl ? (
                    <a
                      className="primary"
                      href={status.license.checkoutUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Get a lifetime license <Icon name="external" size={14} />
                    </a>
                  ) : (
                    <button className="primary" disabled>
                      Purchase opens after launch setup
                    </button>
                  )}
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void perform("license-check", async () => {
                        const result = await send<Result>({
                          action: "license.status",
                        });
                        if (result.ok === false)
                          throw new Error(
                            result.message ??
                              "License verification is unavailable.",
                          );
                        return result.message ?? "License status refreshed.";
                      })
                    }
                  >
                    <Icon name="refresh" size={16} />
                    Check status
                  </button>
                </div>
                <p className="setting-note">
                  Lifetime license: five personal browser installations.
                  Purchase configuration awaits the final product name and
                  account setup.
                </p>
              </Panel>
              <Panel
                title="Activate a license"
                description="Enter a key here. This browser will request access to the license verification service."
              >
                <label className="wide-field">
                  License key
                  <input
                    type="password"
                    autoComplete="off"
                    value={licenseKey}
                    onChange={(event) => setLicenseKey(event.target.value)}
                    placeholder="Enter your license key"
                  />
                </label>
                <button
                  className="primary"
                  disabled={
                    !!busy || !licenseKey.trim() || !status.license.configured
                  }
                  onClick={() => void activateLicense()}
                >
                  {busy === "activate"
                    ? "Activating…"
                    : "Activate this browser"}
                </button>
                {!status.license.configured && (
                  <p className="setting-note">
                    Activation is unavailable until payment configuration is
                    complete.
                  </p>
                )}
                {(status.license.state === "active" ||
                  status.license.canDeactivate) && (
                  <div className="deactivation">
                    <button
                      className="text-button danger-text"
                      onClick={() => setConfirmation("deactivate")}
                    >
                      Deactivate this installation
                    </button>
                  </div>
                )}
              </Panel>
            </>
          ) : (
            <>
              <Panel
                title="Appearance"
                description="A quiet workspace, in the light that suits you."
              >
                <div
                  className="theme-picker"
                  role="radiogroup"
                  onKeyDown={radioKeys}
                  aria-label="Theme"
                >
                  {(["system", "light", "dark"] as const).map((theme) => (
                    <button
                      key={theme}
                      role="radio"
                      aria-checked={status.settings.theme === theme}
                      className={
                        status.settings.theme === theme ? "selected" : ""
                      }
                      disabled={!!busy}
                      onClick={() =>
                        void perform("theme", () => settings({ theme }))
                      }
                    >
                      <span className={"theme-preview " + theme}>
                        <i />
                        <i />
                        <i />
                      </span>
                      <strong>
                        {theme.charAt(0).toUpperCase() + theme.slice(1)}
                      </strong>
                      {status.settings.theme === theme && (
                        <Icon name="check" size={14} />
                      )}
                    </button>
                  ))}
                </div>
              </Panel>
              {supportMode && <Panel
                title="Troubleshooting"
                description="Check site access, provider sign-in and folder permissions first."
              >
                <p className="muted">
                  If a save fails, open the provider in a signed-in tab, check
                  Connections, then retry in Capture & history. A partial
                  capture includes a warning so you can see what was missed.
                </p>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void perform("diagnostics", async () => {
                      const text = await send<string>({
                        action: "diagnostics.copy",
                      });
                      if (typeof text !== "string" || !text)
                        throw new Error(
                          "Diagnostics could not be read. Try again.",
                        );
                      await navigator.clipboard.writeText(text);
                      return "Diagnostics copied. Review them before sharing.";
                    })
                  }
                >
                  Copy diagnostics
                </button>
                <details className="advanced-tools">
                  <summary>Advanced testing tools</summary>
                  <p className="muted">
                    Only field names, safe type labels and counts are included.
                  </p>
                  <button
                    className="secondary"
                    disabled={!!busy || !historyConnected}
                    onClick={() =>
                      void perform("samples", async () => {
                        const result = await send<Result>({
                          action: "samples.export",
                        });
                        if (result?.ok !== true || typeof result.message !== "string")
                          throw new Error(result?.message ?? result?.error ?? "Media diagnostic could not be prepared.");
                        await navigator.clipboard.writeText(result.message);
                        return "Media diagnostic copied.";
                      })
                    }
                  >
                    Copy media diagnostic
                  </button>
                </details>
              </Panel>}
              <Panel
                title="Your data"
                description="Archive data lives in this browser. Markdown files and Notion pages are separate destination copies."
              >
                <p className="muted">
                  Clear local transcripts and search history. Import progress
                  and pending delivery jobs are removed. File and page
                  references are kept to prevent duplicate exports; existing
                  files and Notion pages stay.
                </p>
                <button
                  className="danger-secondary"
                  onClick={() => setConfirmation("clear")}
                >
                  Clear local archive…
                </button>
              </Panel>
              <p className="settings-footer">
                {branding.productName} keeps conversations on this device.
              </p>
            </>
          )}
          {confirmation && (
            <div className="inline-confirm">
              <strong>
                {confirmation === "clear"
                  ? "Clear all archived conversations?"
                  : "Free this installation slot?"}
              </strong>
              <p>
                {confirmation === "clear"
                  ? "This action cannot be undone. Export anything you need first. File and page references are kept to prevent duplicate exports; existing files and Notion pages stay."
                  : "Licensed capture stops in this browser. Your archive stays available."}
              </p>
              <div className="actions">
                <button
                  className="danger-primary"
                  disabled={!!busy}
                  onClick={() =>
                    void perform("confirm", async () => {
                      if (confirmation === "deactivate") {
                        const granted = await browser.permissions.request({
                          origins: ["https://live.dodopayments.com/*"],
                        });
                        if (!granted)
                          throw new Error(
                            "License service access was not granted. This installation has not been deactivated.",
                          );
                      }
                      const message = assertOK(
                        await send({
                          action:
                            confirmation === "clear"
                              ? "archive.clear"
                              : "license.deactivate",
                        }),
                        "The action did not complete.",
                      );
                      if (confirmation === "clear") setRows([]);
                      setConfirmation(null);
                      return message || "Done.";
                    })
                  }
                >
                  {confirmation === "clear"
                    ? "Yes, clear the archive"
                    : "Deactivate"}
                </button>
                <button
                  className="secondary"
                  autoFocus
                  onClick={() => setConfirmation(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}
function providerIssueText(code: string): string {
  return (
    (
      {
        blocked: "The provider blocked this request.",
        unreadable: "The provider returned a response we could not read.",
        site_access: "Allow site access in Chrome to check Claude.",
        no_tab: "Open Claude in a signed-in tab, then check again.",
        needs_signin: "Sign in to the provider in this browser.",
        unavailable: "The provider is temporarily unavailable.",
        provider_request_failed: "The provider request could not be completed.",
        rate_limited: "Claude asked us to wait. Saving will retry automatically while Chrome is open.",
        paused: "Saving is paused.",
        trial_history_limit: "History allowance used.",
      } as Record<string, string>
    )[code] ?? "The provider needs attention."
  );
}
function ExtensionsIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 9h4a3 3 0 1 1 6 0h5v5a3 3 0 1 1 0 6v2H4v-5a3 3 0 1 0 0-6V9Z" />
    </svg>
  );
}
