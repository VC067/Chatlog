import { validateCaptureSignal } from '../../providers/shared/validate.ts';
import { installClaudePageObserver } from '../../providers/claude/page-observer.ts';

export default defineContentScript({
  matches: [],
  runAt: 'document_start',
  world: 'ISOLATED',
  registration: 'runtime',
  main(ctx) {
    if (location.origin === 'https://claude.ai') {
      const cleanup = installClaudePageObserver(window, (conversationId) => {
        void browser.runtime.sendMessage({ source: 'chatlog-page', type: 'CLAUDE_PAGE_CHANGED', pageOrigin: location.origin, conversationId }).catch(() => undefined);
      });
      ctx.onInvalidated(cleanup);
    }
    const relayWindow = window as Window & { __chatlogRelayListener?: (event: MessageEvent) => void };
    if (relayWindow.__chatlogRelayListener) window.removeEventListener('message', relayWindow.__chatlogRelayListener);
    const listener = (event: MessageEvent) => {
      if (event.source !== window) {
        return;
      }
      const signal = validateCaptureSignal(event.data, event.origin);
      if (!signal) {
        return;
      }
      if (browser.runtime?.sendMessage) {
        void browser.runtime.sendMessage(signal).catch(() => undefined);
      }
    };
    relayWindow.__chatlogRelayListener = listener;
    window.addEventListener('message', listener);
  },
});
