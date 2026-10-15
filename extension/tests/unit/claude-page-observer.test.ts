import { afterEach, expect, it, vi } from 'vitest';
import { installClaudePageObserver } from '../../providers/claude/page-observer.ts';

class FakeElement {
  classList: { contains: (name: string) => boolean };
  children: FakeElement[] = [];
  images: FakeImage[] = [];
  textContent: string;
  testId: string | null;
  stop = false;
  hidden = false;

  constructor(options: { text?: string; classes?: string[]; testId?: string; stop?: boolean; hidden?: boolean } = {}) {
    const classes = new Set(options.classes ?? []);
    this.classList = { contains: (name) => classes.has(name) };
    this.textContent = options.text ?? '';
    this.testId = options.testId ?? null;
    this.stop = options.stop ?? false;
    this.hidden = options.hidden ?? false;
  }

  getAttribute(name: string): string | null {
    return name === 'data-testid' ? this.testId : null;
  }

  contains(other: Element): boolean {
    return this.children.some(
      (child) => (child as unknown as Element) === other || child.contains(other),
    );
  }

  querySelector(selector: string): Element | null {
    return selector === '[class*="claude-avatar"]' && this.avatar ? ({} as Element) : null;
  }

  avatar = false;

  querySelectorAll(selector: string): Element[] {
    if (selector === 'img') return this.images as unknown as Element[];
    return this.children as unknown as Element[];
  }
}

class FakeImage {
  constructor(private readonly src: string) {}
  getAttribute(name: string): string | null {
    return name === 'src' ? this.src : null;
  }
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  disconnected = false;
  callback: MutationCallback;

  constructor(callback: MutationCallback) {
    this.callback = callback;
    FakeMutationObserver.instances.push(this);
  }

  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  trigger(): void {
    this.callback([], this as unknown as MutationObserver);
  }
}

class FakeDocument extends EventTarget {
  body: FakeElement | null = new FakeElement();
  messages: FakeElement[] = [];

  constructor() {
    super();
    this.body!.querySelector = (selector: string) =>
      selector === 'button[aria-label*="Stop"], button[aria-label*="stop"], [data-testid="stop-button"]'
        ? ((this.messages.find((message) => message.stop) as unknown as Element | undefined) ?? null)
        : null;
  }

  querySelectorAll(selector: string): Element[] {
    return selector.includes('.font-user') || selector.includes('data-testid')
      ? (this.messages.filter((message) => message.testId === 'user-message' || message.testId === 'assistant-message' || ['font-user', 'font-claude', 'font-claude-response', 'font-claude-message', 'font-user-message'].some((name) => message.classList.contains(name))) as unknown as Element[])
      : [];
  }
}

function fixture(pathname = '/chat/chat-1') {
  const document = new FakeDocument();
  const location = { origin: 'https://claude.ai', pathname };
  const fakeWindow = {
    document,
    location,
    MutationObserver: FakeMutationObserver,
    addEventListener: document.addEventListener.bind(document),
    removeEventListener: document.removeEventListener.bind(document),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  } as unknown as Window;
  return { target: fakeWindow, document, location };
}

function assistant(text: string): FakeElement {
  return new FakeElement({ text, classes: ['font-claude'] });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  FakeMutationObserver.instances = [];
});

it('emits once after a stable completed reply', async () => {
  vi.useFakeTimers();
  const { target, document } = fixture();
  document.messages = [assistant('Hello')];
  const emit = vi.fn();
  const cleanup = installClaudePageObserver(target, emit);
  await vi.advanceTimersByTimeAsync(3500);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith('chat-1');
  await vi.advanceTimersByTimeAsync(3000);
  expect(emit).toHaveBeenCalledTimes(1);
  cleanup();
});

it('waits while streaming and emits after the stop control disappears', async () => {
  vi.useFakeTimers();
  const { target, document } = fixture();
  const reply = assistant('Still writing');
  const stop = new FakeElement({ testId: 'stop-button', stop: true });
  document.messages = [reply, stop];
  const emit = vi.fn();
  const cleanup = installClaudePageObserver(target, emit);
  await vi.advanceTimersByTimeAsync(3000);
  expect(emit).not.toHaveBeenCalled();
  document.messages = [reply];
  await vi.advanceTimersByTimeAsync(1000);
  expect(emit).toHaveBeenCalledWith('chat-1');
  cleanup();
});

it('emits again for a later completed reply', async () => {
  vi.useFakeTimers();
  const { target, document } = fixture();
  const reply = assistant('First reply');
  document.messages = [reply];
  const emit = vi.fn();
  const cleanup = installClaudePageObserver(target, emit);
  await vi.advanceTimersByTimeAsync(2500);
  expect(emit).toHaveBeenCalledTimes(1);
  reply.textContent = 'Second reply';
  FakeMutationObserver.instances[0]!.trigger();
  await vi.advanceTimersByTimeAsync(1500);
  expect(emit).toHaveBeenCalledTimes(2);
  cleanup();
});

it('binds a route change to its new conversation ID', async () => {
  vi.useFakeTimers();
  const { target, document, location } = fixture();
  document.messages = [assistant('Reply')];
  const emit = vi.fn();
  const cleanup = installClaudePageObserver(target, emit);
  await vi.advanceTimersByTimeAsync(2500);
  expect(emit).toHaveBeenLastCalledWith('chat-1');
  location.pathname = '/chat/chat-2';
  await vi.advanceTimersByTimeAsync(2500);
  expect(emit).toHaveBeenCalledTimes(2);
  expect(emit).toHaveBeenLastCalledWith('chat-2');
  cleanup();
});

it('cleans up on reinjection and prevents duplicate timers', async () => {
  vi.useFakeTimers();
  const { target, document } = fixture();
  document.messages = [assistant('Reply')];
  const emit = vi.fn();
  const cleanupFirst = installClaudePageObserver(target, emit);
  const firstObserver = FakeMutationObserver.instances[0]!;
  const cleanupSecond = installClaudePageObserver(target, emit);
  expect(firstObserver.disconnected).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(2500);
  expect(emit).toHaveBeenCalledTimes(1);
  cleanupFirst();
  cleanupSecond();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not let a hidden stop control block a completed reply', async () => {
  vi.useFakeTimers();
  const { target, document } = fixture();
  document.messages = [assistant('Reply'), new FakeElement({ testId: 'stop-button', hidden: true })];
  const emit = vi.fn();
  const cleanup = installClaudePageObserver(target, emit);
  await vi.advanceTimersByTimeAsync(2500);
  expect(emit).toHaveBeenCalledWith('chat-1');
  cleanup();
});

it('does not emit without an assistant reply or on an invalid Claude route', async () => {
  vi.useFakeTimers();
  const noAssistant = fixture();
  noAssistant.document.messages = [new FakeElement({ text: 'Question', classes: ['font-user'] })];
  const firstEmit = vi.fn();
  const cleanupFirst = installClaudePageObserver(noAssistant.target, firstEmit);
  await vi.advanceTimersByTimeAsync(2500);
  expect(firstEmit).not.toHaveBeenCalled();
  cleanupFirst();

  const invalid = fixture('/chat/too_long_' + 'x'.repeat(101));
  invalid.document.messages = [assistant('Reply')];
  const secondEmit = vi.fn();
  const cleanupSecond = installClaudePageObserver(invalid.target, secondEmit);
  await vi.advanceTimersByTimeAsync(2500);
  expect(secondEmit).not.toHaveBeenCalled();
  cleanupSecond();
});
