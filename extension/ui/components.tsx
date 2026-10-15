import { useEffect, type KeyboardEvent, type ReactNode } from "react";
import { branding } from "../config/branding.ts";
import { providerLabel, type ArchiveRow, type Status } from "./api.ts";

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    archive: (
      <>
        <path d="M4 8h16v12H4zM3 4h18v4H3z" />
        <path d="M9 12h6" />
      </>
    ),
    folder: <path d="M3 6h6l2 2h10v12H3z" />,
    link: (
      <>
        <path
          d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 1 1 6 6l-4 4a4 4 0 0 1-6 0"
          transform="translate(1 0) scale(.9)"
        />
      </>
    ),
    capture: (
      <>
        <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
        <circle cx="12" cy="12" r="4" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="9" r="5" />
        <path d="m11 13 8 8 3-3-2-2-2 2-2-2" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 8a3 3 0 0 1 6 1c0 2-3 2-3 4M12 17h.01" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    refresh: (
      <>
        <path d="M20 10a8 8 0 1 0-2 8M20 3v7h-7" />
      </>
    ),
    export: (
      <>
        <path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    pin: (
      <>
        <path d="M8 3h8l-1 7 4 4H5l4-4zM12 14v8" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.archive}
    </svg>
  );
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark logo-mark" aria-hidden="true">
        <img src="/assets/chat-archive-logo-v1.png" alt="" />
      </span>
      <span>
        {branding.productName}
        {!compact && <small>Conversation archive</small>}
      </span>
    </div>
  );
}
export function ProviderMark({ provider }: { provider: string }) {
  return (
    <span className={`provider-mark ${provider}`} aria-hidden="true">
      <img src={`/assets/${provider}.svg`} alt="" />
    </span>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "blue";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Notice({
  children,
  error = false,
  onClose,
}: {
  children: ReactNode;
  error?: boolean;
  onClose?: () => void;
}) {
  return (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      <span>{children}</span>
      {onClose && (
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Dismiss message"
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <label className={`setting-row ${disabled ? "unavailable" : ""}`}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}
export function Empty({
  title,
  children,
  icon = "archive",
}: {
  title: string;
  children: ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function ChatRow({
  row,
  onOpen,
  compact = false,
}: {
  row: ArchiveRow;
  onOpen: () => void;
  compact?: boolean;
}) {
  return (
    <button className={`chat-row ${compact ? "compact" : ""}`} onClick={onOpen}>
      <ProviderMark provider={row.provider} />
      <span className="chat-copy">
        <strong>{row.title || "Untitled conversation"}</strong>
        <small>
          {providerLabel(row.provider)} ·{" "}
          {new Date(row.capturedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
          {row.completeness === "partial" ? " · Partial capture" : ""}
        </small>
        {!compact && <p>{row.preview || "Open to read this conversation."}</p>}
        {row.destinations && (
          <span className="row-destinations">
            {Object.entries(row.destinations)
              .filter(([, state]) => !compact || state !== "not_configured")
              .map(([destination, state]) => (
                <Badge
                  key={destination}
                  tone={
                    state === "saved"
                      ? "good"
                      : state === "pending"
                        ? "blue"
                        : state === "blocked" || state === "needs_review"
                          ? "warn"
                          : "neutral"
                  }
                >
                  {destination === "markdown"
                    ? "Markdown"
                    : destination === "notion"
                      ? "Notion"
                      : destination}{" "}
                  ·{" "}
                  {state === "needs_review"
                    ? "Edit review"
                    : state === "not_configured"
                      ? "Not configured"
                      : state}
                </Badge>
              ))}
          </span>
        )}
      </span>
      <Icon name="arrow" size={17} />
    </button>
  );
}
export function radioKeys(event: KeyboardEvent<HTMLElement>) {
  if (
    ![
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ].includes(event.key)
  )
    return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]:not(:disabled)',
    ),
  );
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  if (!buttons.length || current < 0) return;
  event.preventDefault();
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current +
            (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
            buttons.length) %
          buttons.length;
  buttons[index]?.focus();
  buttons[index]?.click();
}
export function ThemeEffect({ theme }: { theme: Status["settings"]["theme"] }) {
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
  return null;
}
