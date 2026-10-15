const MESSAGE_SELECTOR =
  '.font-user, .font-claude, [data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response, .font-claude-message, .font-user-message';
const STOP_SELECTOR =
  'button[aria-label*="Stop"], button[aria-label*="stop"], [data-testid="stop-button"]';
const CLEANUP_KEY = '__chatlogClaudePageCleanup';
const MAX_MESSAGES = 500;
const MAX_MESSAGE_TEXT = 20_000;
const MAX_TOTAL_TEXT = 500_000;
const MAX_IMAGES_PER_MESSAGE = 50;
const MAX_IMAGE_SOURCE = 2_000;

type ObserverWindow = Window & {
  [CLEANUP_KEY]?: () => void;
  MutationObserver: typeof MutationObserver;
};

function conversationIdFor(target: Window): string | null {
  try {
    if (target.location.origin !== 'https://claude.ai') return null;
    const match = /^\/chat\/([A-Za-z0-9-]{1,100})\/?$/.exec(target.location.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function isAssistant(element: Element): boolean {
  return (
    element.classList.contains('font-claude') ||
    element.classList.contains('font-claude-response') ||
    element.classList.contains('font-claude-message') ||
    element.getAttribute('data-testid') === 'assistant-message' ||
    element.querySelector('[class*="claude-avatar"]') !== null
  );
}

function signatureFor(document: Document): { value: string; hasAssistant: boolean } {
  const matches = Array.from(document.querySelectorAll(MESSAGE_SELECTOR)).slice(0, MAX_MESSAGES);
  const innermost = matches.filter(
    (element) => !matches.some((other) => other !== element && element.contains(other)),
  );
  let totalText = 0;
  let hasAssistant = false;
  let hash = 2166136261;
  const add = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 255;
    hash = Math.imul(hash, 16777619);
  };

  for (const element of innermost) {
    const assistant = isAssistant(element);
    hasAssistant ||= assistant;
    const remaining = Math.max(0, MAX_TOTAL_TEXT - totalText);
    const text = (element.textContent ?? '').slice(0, Math.min(MAX_MESSAGE_TEXT, remaining));
    totalText += text.length;
    add(assistant ? 'assistant' : 'user');
    add(text);

    const images = Array.from(element.querySelectorAll('img')).slice(0, MAX_IMAGES_PER_MESSAGE);
    for (const image of images) add((image.getAttribute('src') ?? '').slice(0, MAX_IMAGE_SOURCE));
  }
  return { value: `${innermost.length}:${hash >>> 0}`, hasAssistant };
}

export function installClaudePageObserver(
  target: Window,
  emit: (conversationId: string) => void,
): () => void {
  const observerTarget = target as ObserverWindow;
  try {
    observerTarget[CLEANUP_KEY]?.();
  } catch {
    // A stale observer must not prevent the new observer from being installed.
  }

  let disposed = false;
  let observer: MutationObserver | null = null;
  let debounceTimer: number | undefined;
  let pollTimer: number | undefined;
  let conversationId: string | null = null;
  let lastSignature: string | null = null;
  let stableSince = 0;
  let lastEmitted: string | null = null;

  const clearTimer = (timer: number | undefined) => {
    if (timer !== undefined) target.clearTimeout(timer);
  };

  const inspect = () => {
    if (disposed) return;
    const nextId = conversationIdFor(target);
    if (nextId !== conversationId) {
      conversationId = nextId;
      lastSignature = null;
      stableSince = Date.now();
      lastEmitted = null;
    }
    if (!conversationId) return;
    try {
      const body = target.document.body;
      if (!body) return;
      const current = signatureFor(target.document);
      const signature = `${conversationId}|${current.value}`;
      const now = Date.now();
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = now;
        return;
      }
      if (!current.hasAssistant || lastEmitted === signature) return;
      const stopControl = body.querySelector(STOP_SELECTOR) as HTMLElement | null;
      const stopIsVisible =
        !!stopControl &&
        !stopControl.hidden &&
        (typeof stopControl.getClientRects !== 'function' || stopControl.getClientRects().length > 0);
      if (stopIsVisible) return;
      if (now - stableSince < 1500) return;
      lastEmitted = signature;
      try {
        emit(conversationId);
      } catch {
        // Capture callbacks must not affect the provider page.
      }
    } catch {
      // DOM changes during navigation are expected; polling will retry.
    }
  };

  const attach = () => {
    if (disposed || observer || !target.document.body) return;
    try {
      const instance = new observerTarget.MutationObserver(() => {
        if (disposed) return;
        clearTimer(debounceTimer);
        debounceTimer = undefined;
        inspect();
        debounceTimer = target.setTimeout(() => {
          debounceTimer = undefined;
          inspect();
        }, 1500);
      });
      observer = instance;
      instance.observe(target.document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      inspect();
    } catch {
      observer?.disconnect();
      observer = null;
    }
  };

  const onDomReady = () => attach();
  try {
    observerTarget.addEventListener('DOMContentLoaded', onDomReady);
    attach();
    pollTimer = target.setInterval(() => {
      attach();
      inspect();
    }, 1000);
  } catch {
    // Installation is best-effort on partially initialized documents.
  }

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimer(debounceTimer);
    clearTimer(pollTimer);
    debounceTimer = undefined;
    pollTimer = undefined;
    try {
      observer?.disconnect();
      observerTarget.removeEventListener('DOMContentLoaded', onDomReady);
    } catch {
      // Cleanup remains safe if the document has already gone away.
    }
    observer = null;
    if (observerTarget[CLEANUP_KEY] === cleanup) delete observerTarget[CLEANUP_KEY];
  };

  observerTarget[CLEANUP_KEY] = cleanup;
  return cleanup;
}
