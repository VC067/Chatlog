import { settingsSchema, type Settings } from "../core/settings.ts";
import { CLAUDE_ENABLED } from "../core/provider-features.ts";

export type Provider = "chatgpt" | "claude" | "grok";
export type ArchiveRow = {
  key: string;
  title: string;
  provider: string;
  capturedAt: string;
  preview: string;
  sourceUrl?: string;
  completeness?: string;
  warning?: string | null;
  destinations?: Record<string, string>;
};
export type ChatDetail = ArchiveRow & {
  messages: Array<{ role: string; text: string }>;
  warnings?: string[];
};
export type SyncStatus = {
  provider: string;
  state: string;
  error: string | null;
  errorCode?: string | null;
  savedCount: number;
  discoveredCount?: number;
  lastRunAt?: string | null;
};
export type LicenseStatus = {
  state:
    | "trial"
    | "active"
    | "trial_expired"
    | "license_unavailable"
    | "revoked";
  daysLeft: number;
  autoCaptureAllowed: boolean;
  historyLimit: number | null;
  canImportHistory: boolean;
  checkoutUrl: string | null;
  configured: boolean;
  apiOrigin?: string;
  canDeactivate?: boolean;
};
export type Status = {
  claudeConnection?: {
    ok: boolean;
    code: 'ok' | 'site_access' | 'no_tab' | 'blocked' | 'needs_signin' | 'rate_limited' | 'unavailable' | 'unreadable';
    message: string;
    report: string;
    checkedAt: string;
    source?: 'check' | 'import';
  } | null;
  folder: string;
  folderName: string | null;
  connected: string[];
  notion: boolean;
  notionStatus: {
    state: "disconnected" | "connected" | "error" | "waiting";
    message: string | null;
    errorCode?: string | null;
    nextRetryAt?: string | null;
  };
  settings: Settings;
  sync: SyncStatus[];
  historyUsage?: Array<{ provider: string; used: number; limit: number | null }>;
  pendingJobs: number;
  blockedJobs: number;
  license: LicenseStatus;
  deliveryIssues?: Array<{
    id: string;
    destinationId: string;
    state: string;
    errorCode: string | null;
    title: string;
  }>;
  imports?: Array<{
    id: string;
    provider: string;
    state: string;
    completedCount?: number;
    discoveredCount?: number;
    error?: string | null;
    errorCode?: string | null;
    nextEligibleAt?: string | null;
  }>;
};
export const providers: Provider[] = ["chatgpt", "claude", "grok"].filter(
  (provider) => provider !== "claude" || CLAUDE_ENABLED,
) as Provider[];
export const providerLabel = (provider: string) =>
  ({ chatgpt: "ChatGPT", claude: "Claude", grok: "Grok" })[provider] ??
  provider;
export const providerHost = (provider: Provider) =>
  ({ chatgpt: "chatgpt.com", claude: "claude.ai", grok: "grok.com" })[provider];
export const emptyStatus: Status = {
  folder: "missing",
  folderName: null,
  connected: [],
  notion: false,
  notionStatus: { state: "disconnected", message: null },
  settings: settingsSchema.parse({}),
  sync: [],
  pendingJobs: 0,
  blockedJobs: 0,
  license: {
    state: "license_unavailable",
    daysLeft: 0,
    autoCaptureAllowed: false,
    historyLimit: 25,
    canImportHistory: false,
    checkoutUrl: null,
    configured: false,
  },
};
export async function send<T>(message: Record<string, unknown>): Promise<T> {
  const result: unknown = await browser.runtime.sendMessage(message);
  if (
    result === undefined ||
    (result === null && message.action !== "archive.get")
  )
    throw new Error(
      "The extension did not respond. Reload it from the extensions page and try again.",
    );
  return result as T;
}
export function asStatus(value: unknown): Status {
  if (!value || typeof value !== "object")
    throw new Error("Status is unavailable. Try again.");
  const raw = value as Partial<Status> & {
    ok?: boolean;
    error?: string;
    message?: string;
  };
  if (raw.ok === false || raw.error || typeof raw.folder !== "string")
    throw new Error(
      raw.message ?? raw.error ?? "Status is unavailable. Try again.",
    );
  const settings = settingsSchema.safeParse(raw.settings ?? {});
  if (
    !settings.success ||
    !raw.settings ||
    typeof raw.settings.onboardingComplete !== "boolean"
  )
    throw new Error(
      "Your settings could not be loaded. Reload this page to try again.",
    );
  return {
    ...emptyStatus,
    ...raw,
    settings: settings.data,
    connected: (Array.isArray(raw.connected) ? raw.connected : []).filter(
      (provider) => provider !== "claude" || CLAUDE_ENABLED,
    ),
    sync: (Array.isArray(raw.sync) ? raw.sync : []).filter(
      (item) => item.provider !== "claude" || CLAUDE_ENABLED,
    ),
    imports: (Array.isArray(raw.imports) ? raw.imports : []).filter(
      (item) => item.provider !== "claude" || CLAUDE_ENABLED,
    ),
    claudeConnection: CLAUDE_ENABLED ? raw.claudeConnection : null,
    notionStatus: raw.notionStatus ?? emptyStatus.notionStatus,
    license: raw.license ?? emptyStatus.license,
  };
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export function deliveryIssueMessage(code: string | null): string {
  const messages: Record<string, string> = {
    permission_required:
      "Folder permission is needed. Reconnect your folder before retrying.",
    destination_disabled:
      "Markdown delivery is disabled. Enable it in Connections to write this file.",
    local_edits:
      "Your Markdown file has local edits. Choose what to keep in the file review below.",
    notion_not_configured:
      "Connect and verify a Notion database before retrying this delivery.",
    notion_unauthorized:
      "Notion rejected the connection token. Update the connection before retrying.",
    notion_forbidden:
      "The connection cannot access this Notion database. Review its page access.",
    notion_write_uncertain:
      "The previous Notion write could not be confirmed. Recheck to reconcile that attempt safely.",
    notion_section_uncertain:
      "The managed Notion section could not be confirmed. Recheck before another delivery attempt.",
    notion_section_changed:
      "The extension's managed section was edited in Notion. Review it in your database, then recheck.",
    notion_duplicate_identity:
      "More than one Notion page matches this conversation. Review duplicate pages in your database, then recheck.",
    notion_duplicate_section:
      "More than one managed section was found. Review the page in Notion, then recheck.",
    notion_workspace_limit:
      "This Notion workspace has reached its available limit. Review the workspace plan before retrying. Your local archive is preserved.",
    notion_api_restricted:
      "Notion restricted this connection's API access. Contact Notion support before rechecking delivery. Your local archive is preserved.",
    rate_limited:
      "The destination asked us to wait. A later retry will respect its rate limit. Your local archive is preserved.",
    service_overload:
      "Notion is temporarily overloaded. It can be retried later. Your local archive is preserved.",
    delivery_unavailable:
      "The destination is temporarily unavailable. Check its connection, then try again.",
  };
  return (
    messages[code ?? ""] ??
    "This destination needs attention. Review the connection or recheck delivery."
  );
}
export function assertOK(
  result: { ok?: boolean; error?: string; message?: string } | null | undefined,
  fallback: string,
) {
  if (!result || result.ok !== true)
    throw new Error(result?.message ?? result?.error ?? fallback);
  return result.message ?? "";
}
export function syncMessage(result: unknown): string {
  if (!Array.isArray(result))
    throw new Error(
      (result as { message?: string; error?: string } | null)?.message ??
        (result as { error?: string } | null)?.error ??
        "The history save could not start. Try again.",
    );
  if (!result.length)
    return CLAUDE_ENABLED
      ? "No connected history providers. Connect ChatGPT or Claude to save history."
      : "No connected history providers. Connect ChatGPT to save history.";
  const items = result as SyncStatus[];
  if (items.some((item) => item.state === "running"))
    return "History save started. Progress appears below; you can close this page while it continues.";
  const count = items.reduce(
    (total, item) => total + (item.savedCount ?? 0),
    0,
  );
  const problems = items.filter(
    (item) =>
      item.error || ["error", "needs_signin", "partial"].includes(item.state),
  );
  if (problems.length)
    return `${count ? `${count} conversations archived. ` : ""}${problems.map((item) => `${providerLabel(item.provider)}: ${item.error ?? item.state}`).join(" ")}`;
  return count
    ? `${count} conversations archived. Destination delivery may continue in the background.`
    : "No new conversations were archived. Check provider status below.";
}
export function when(value?: string | null): string {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "Not checked yet";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
export function licenseLabel(license: LicenseStatus): string {
  return {
    trial: `${license.daysLeft} days left in trial`,
    active: "Lifetime license",
    trial_expired: "Trial ended",
    license_unavailable: "License check unavailable",
    revoked: "License inactive",
  }[license.state];
}
export function safeSource(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      ["chatgpt.com", "claude.ai", "grok.com", "x.com"].includes(
        parsed.hostname,
      )
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
