import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  asStatus,
  assertOK,
  emptyStatus,
  errorMessage,
  licenseLabel,
  providerLabel,
  send,
  syncMessage,
  when,
  type ArchiveRow,
} from "../../ui/api.ts";
import { CLAUDE_ENABLED } from "../../core/provider-features.ts";
import {
  Brand,
  Icon,
  Notice,
  ProviderMark,
  ThemeEffect,
} from "../../ui/components.tsx";

type PendingChat = {
  provider: "chatgpt" | "claude";
  id: string;
  accountScope: string;
  title: string;
  updatedAt: string | null;
  projectName?: string | null;
  projectSlug?: string | null;
};
type Inbox = {
  chats?: PendingChat[];
  notice?: string | null;
  checkedAt?: string | null;
};
type Result = { ok?: boolean; message?: string; error?: string };
type Tab = "inbox" | "saved";

export default function Popup() {
  const [status, setStatus] = useState(emptyStatus);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [allRows, setAllRows] = useState<ArchiveRow[]>([]);
  const [searchRows, setSearchRows] = useState<ArchiveRow[]>([]);
  const [pending, setPending] = useState<PendingChat[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("inbox");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function applyInbox(inbox: Inbox) {
    if (!inbox || !Array.isArray(inbox.chats))
      throw new Error("Recent chats could not be checked. Try again.");
    setPending(inbox.chats);
    setCheckedAt(inbox.checkedAt ?? null);
  }
  async function refresh() {
    const [rawStatus, archive, inbox] = await Promise.all([
      send({ action: "status.get" }),
      send<ArchiveRow[]>({ action: "archive.list" }),
      send<Inbox>({ action: "inbox.read" }),
    ]);
    const next = asStatus(rawStatus);
    if (!Array.isArray(archive))
      throw new Error("Saved chats could not be loaded. Try again.");
    setStatus(next);
    setAllRows(archive);
    applyInbox(inbox);
    setReady(true);
    setRefreshKey((value) => value + 1);
  }
  useEffect(() => {
    void refresh()
      .catch((error) => setNotice({ text: errorMessage(error), error: true }))
      .finally(() => setLoading(false));
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (tab !== "saved" || !query.trim()) {
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void send<ArchiveRow[]>({ action: "archive.search", query: query.trim() })
        .then((rows) => {
          if (!Array.isArray(rows))
            throw new Error("Search is unavailable. Try again.");
          if (active) setSearchRows(rows);
        })
        .catch((error) => {
          if (active) {
            setSearchRows([]);
            setNotice({ text: errorMessage(error), error: true });
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, tab, refreshKey]);

  async function openOptions(hash = "archive") {
    await browser.tabs.create({
      url: browser.runtime.getURL("/options.html") + "#" + hash,
    });
    window.close();
  }
  async function action(name: string, work: () => Promise<string>) {
    setBusy(name);
    setNotice(null);
    try {
      const text = await work();
      setNotice({ text });
      await refresh();
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    } finally {
      setBusy("");
    }
  }
  function checkRecent() {
    void action("check", async () => {
      const inbox = await send<Inbox>({ action: "inbox.refresh" });
      applyInbox(inbox);
      return inbox.notice ?? "Recent chats checked.";
    });
  }
  function saveOpen() {
    void action(
      "active",
      async () =>
        assertOK(
          await send<Result>({ action: "conversation.save" }),
          "Open a supported conversation tab, then try again.",
        ) || "Chat saved to your archive.",
    );
  }
  function tabsKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: Tab =
      event.key === "Home"
        ? "inbox"
        : event.key === "End"
          ? "saved"
          : tab === "inbox"
            ? "saved"
            : "inbox";
    setTab(next);
    document.getElementById("popup-tab-" + next)?.focus();
  }

  const running =
    status.sync.some((item) => item.state === "running") ||
    status.imports?.some((item) => item.state === "running") === true;
  const historyConnected = status.connected.some(
    (provider) => provider === "chatgpt" || (CLAUDE_ENABLED && provider === "claude"),
  );
  const setupNeeded = ready && !status.settings.onboardingComplete;
  const destinationProblem =
    ready &&
    ((status.settings.markdownEnabled && status.folder !== "granted") ||
      (status.notion && status.notionStatus.state !== "connected"));
  const signIn = status.sync.filter(
    (item) => item.state === "needs_signin" || item.state === "error",
  );
  const visible = query.trim() ? searchRows : allRows;
  const destination = !ready
    ? "Loading…"
    : status.settings.markdownEnabled
      ? (status.folderName ?? "Choose folder")
      : status.notion
        ? "Notion"
        : "Choose destination";
  const trialText =
    status.license.state === "trial"
      ? "Trial · " + status.license.daysLeft + " days left"
      : status.license.state === "active"
        ? "Lifetime license"
        : licenseLabel(status.license);
  const automaticText = !ready
    ? "Unavailable"
    : status.settings.autoSync && status.license.autoCaptureAllowed
      ? "Automatic saving on"
      : "Automatic saving off";
  const canCheck =
    ready &&
    !busy &&
    !setupNeeded &&
    historyConnected &&
    status.license.canImportHistory;

  return (
    <>
      <ThemeEffect theme={status.settings.theme} />
      <main className="popup">
        <header className="popup-header">
          <Brand compact />
          <div className="header-actions">
            <button
              className="destination-chip"
              title={destination}
              onClick={() => void openOptions("connections")}
            >
              <Icon
                name={status.settings.markdownEnabled ? "folder" : "link"}
                size={14}
              />
              <span>{destination}</span>
            </button>
            <button
              className="icon-button"
              aria-label="Open settings"
              onClick={() => void openOptions("connections")}
            >
              <SettingsGear />
            </button>
          </div>
        </header>
        <div className="popup-tabs" role="tablist" aria-label="Chats">
          <button
            id="popup-tab-inbox"
            role="tab"
            aria-selected={tab === "inbox"}
            aria-controls="popup-panel-inbox"
            tabIndex={tab === "inbox" ? 0 : -1}
            onKeyDown={tabsKeyboard}
            onClick={() => setTab("inbox")}
          >
            To save<span className="tab-count">{pending.length}</span>
          </button>
          <button
            id="popup-tab-saved"
            role="tab"
            aria-selected={tab === "saved"}
            aria-controls="popup-panel-saved"
            tabIndex={tab === "saved" ? 0 : -1}
            onKeyDown={tabsKeyboard}
            onClick={() => setTab("saved")}
          >
            Saved<span className="tab-count">{allRows.length}</span>
          </button>
        </div>
        <div className="popup-alerts">
          {setupNeeded && (
            <button
              className="compact-alert"
              onClick={() => void openOptions("setup")}
            >
              <Icon name="settings" size={15} />
              <span>Finish setup to start saving</span>
              <Icon name="arrow" size={14} />
            </button>
          )}
          {!setupNeeded && destinationProblem && (
            <button
              className="compact-alert warning"
              onClick={() => void openOptions("connections")}
            >
              <Icon name="folder" size={15} />
              <span>
                {status.settings.markdownEnabled && status.folder !== "granted"
                  ? "Reconnect your folder to write saved files"
                  : "Review your Notion connection"}
              </span>
              <Icon name="arrow" size={14} />
            </button>
          )}
          {ready && !status.license.autoCaptureAllowed && (
            <button
              className="compact-alert warning"
              onClick={() => void openOptions("license")}
            >
              <Icon name="key" size={15} />
              <span>{licenseLabel(status.license)} · Review access</span>
              <Icon name="arrow" size={14} />
            </button>
          )}
          {!setupNeeded &&
            signIn.map((item) => (
              <button
                key={item.provider}
                className="compact-alert"
                title={item.error ?? undefined}
                onClick={() => void openOptions("capture")}
              >
                <ProviderMark provider={item.provider} />
                <span>
                  {providerLabel(item.provider)} history{" "}
                  {item.state === "needs_signin"
                    ? "needs sign-in"
                    : "needs attention"}
                </span>
                <Icon name="arrow" size={14} />
              </button>
            ))}
          {ready &&
            status.blockedJobs > 0 &&
            !destinationProblem &&
            signIn.length === 0 && (
              <button
                className="compact-alert warning"
                onClick={() => void openOptions("capture")}
              >
                <Icon name="clock" size={15} />
                <span>Review chats that need attention</span>
                <Icon name="arrow" size={14} />
              </button>
            )}
          {notice && (
            <Notice error={notice.error} onClose={() => setNotice(null)}>
              {notice.text}
            </Notice>
          )}
          {!ready && !loading && (
            <button
              className="secondary recovery-button"
              onClick={() => location.reload()}
            >
              Retry connection
            </button>
          )}
        </div>
        {tab === "inbox" ? (
          <section
            className="popup-pane"
            id="popup-panel-inbox"
            role="tabpanel"
            aria-labelledby="popup-tab-inbox"
          >
            <div className="inbox-heading">
              <span>
                {busy === "check"
                  ? "Checking recent chats…"
                  : checkedAt
                    ? "Checked " + when(checkedAt)
                    : "Not checked yet"}
              </span>
              <button
                className="icon-button"
                aria-label="Refresh recent chats"
                title="Check connected providers"
                disabled={!canCheck}
                onClick={checkRecent}
              >
                <Icon name="refresh" size={16} />
              </button>
            </div>
            <div
              className="popup-results"
              aria-busy={loading || busy === "check"}
            >
              {loading ? (
                <PopupEmpty title="Loading recent chats…" />
              ) : pending.length ? (
                pending.map((chat) => (
                  <div
                    className="pending-row"
                    key={chat.provider + ":" + chat.id}
                  >
                    <ProviderMark provider={chat.provider} />
                    <span className="row-copy">
                      <strong title={chat.title}>
                        {chat.title || "Untitled conversation"}
                      </strong>
                      <small>
                        {providerLabel(chat.provider)}
                        {chat.updatedAt ? " · " + when(chat.updatedAt) : ""}
                      </small>
                    </span>
                    <button
                      className="row-save"
                      aria-label={"Save " + chat.title}
                      disabled={
                        !!busy ||
                        !status.license.canImportHistory ||
                        setupNeeded
                      }
                      onClick={() =>
                        void action("pending-" + chat.id, async () => {
                          const result = await send<Result>({
                            action: "inbox.save",
                            chat,
                          });
                          return (
                            assertOK(
                              result,
                              "This chat could not be saved. Try again.",
                            ) || "Chat saved to your archive."
                          );
                        })
                      }
                    >
                      <Icon name="export" size={16} />
                      <span>
                        {busy === "pending-" + chat.id ? "Saving…" : "Save"}
                      </span>
                    </button>
                  </div>
                ))
              ) : (
                <PopupEmpty
                  title={
                    !ready
                      ? "Recent chats unavailable"
                      : "No recent chats to save"
                  }
                >
                  {!ready
                    ? "Retry the connection above."
                    : historyConnected
                      ? "Use refresh above to check your connected providers."
                      : CLAUDE_ENABLED ? "Connect ChatGPT or Claude in Settings. Grok saves from the open tab." : "Connect ChatGPT in Settings. Grok saves from the open tab."}
                </PopupEmpty>
              )}
            </div>
          </section>
        ) : (
          <section
            className="popup-pane"
            id="popup-panel-saved"
            role="tabpanel"
            aria-labelledby="popup-tab-saved"
          >
            <label className="search-field popup-search">
              <Icon name="search" size={16} />
              <input
                aria-label="Search saved chats"
                placeholder="Search saved chats…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  className="icon-button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </label>
            <div className="saved-heading">
              <span>
                {query.trim()
                  ? searching
                    ? "Searching…"
                    : visible.length +
                      " match" +
                      (visible.length === 1 ? "" : "es")
                  : "Your saved conversations"}
              </span>
              <button
                className="text-button"
                onClick={() => void openOptions("archive")}
              >
                Open full archive <Icon name="external" size={12} />
              </button>
            </div>
            <div className="popup-results" aria-busy={searching || loading}>
              {loading ? (
                <PopupEmpty title="Loading saved chats…" />
              ) : visible.length ? (
                visible.map((row) => {
                  const issue = Object.values(row.destinations ?? {}).some(
                    (state) =>
                      ["blocked", "needs_review", "failed"].includes(state),
                  );
                  return (
                    <button
                      className="saved-row"
                      key={row.key}
                      aria-label={"Open " + row.title}
                      onClick={() =>
                        void openOptions("chat=" + encodeURIComponent(row.key))
                      }
                    >
                      <ProviderMark provider={row.provider} />
                      <span className="row-copy">
                        <strong title={row.title}>
                          {row.title || "Untitled conversation"}
                        </strong>
                        <small>
                          {providerLabel(row.provider)} · {when(row.capturedAt)}
                        </small>
                        {(row.completeness === "partial" || issue) && (
                          <span className="row-exception">
                            {[
                              row.completeness === "partial"
                                ? "Partial capture"
                                : "",
                              issue ? "Needs attention" : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </span>
                      <Icon name="arrow" size={15} />
                    </button>
                  );
                })
              ) : (
                <PopupEmpty
                  title={
                    searching
                      ? "Searching…"
                      : query.trim()
                        ? "No matching chats"
                        : "No saved chats yet"
                  }
                >
                  {query.trim()
                    ? "Try another phrase. Search includes the full conversation."
                    : "Save the current chat, or check recent conversations."}
                </PopupEmpty>
              )}
            </div>
          </section>
        )}
        <div className="popup-actions">
          {setupNeeded ? (
            <button
              className="primary"
              onClick={() => void openOptions("setup")}
            >
              Finish setup
              <Icon name="arrow" size={16} />
            </button>
          ) : (
            <>
              <button
                className="primary"
                disabled={!ready || !!busy}
                onClick={saveOpen}
              >
                <Icon name="capture" size={16} />
                {busy === "active" ? "Saving current chat…" : "Save current chat"}
              </button>
              {tab === "inbox" && (
                <button
                  className="secondary"
                  disabled={
                    !ready ||
                    !!busy ||
                    running ||
                    !historyConnected ||
                    !status.license.canImportHistory
                  }
                  onClick={() =>
                    void action("history", async () => {
                      const result = await send({
                        action: "sync.run",
                        limit: status.settings.latestSaveCount,
                      });
                      const message = syncMessage(result);
                      return Array.isArray(result) &&
                        result.some((item) => item.state === "running")
                        ? "Saving recent chats. You can close this popup while it continues."
                        : message;
                    })
                  }
                >
                  {busy === "history" || running
                    ? "Saving recent chats…"
                    : "Save recent chats"}
                  <Icon name="export" size={16} />
                </button>
              )}
            </>
          )}
        </div>
        <footer className="popup-footer">
          <button
            className="trial-status"
            onClick={() => void openOptions("license")}
          >
            {ready ? trialText : "Loading…"}
          </button>
          <button
            className="automatic-status"
            onClick={() => void openOptions("capture")}
          >
            <i
              className={
                running
                  ? "working"
                  : status.settings.autoSync &&
                      status.license.autoCaptureAllowed
                    ? "on"
                    : ""
              }
            />
            {automaticText}
          </button>
        </footer>
      </main>
    </>
  );
}
function PopupEmpty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="popup-empty">
      <Icon name="archive" size={23} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
function SettingsGear() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 2h5l.5 2.5 2 1.2 2.5-.8L22 9.2l-1.9 1.7v2.3l1.9 1.7-2.5 4.3-2.5-.8-2 1.2-.5 2.4h-5L9 19.6l-2-1.2-2.5.8L2 14.9l1.9-1.7v-2.3L2 9.2l2.5-4.3 2.5.8 2-1.2L9.5 2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
