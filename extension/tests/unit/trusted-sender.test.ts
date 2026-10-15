import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isTrustedExtensionSender } from '../../platform/trusted-sender.ts';
beforeEach(() => vi.stubGlobal('browser', { runtime: { id: 'self', getURL: (path: string) => 'chrome-extension://self/' + path } }));
afterEach(() => vi.unstubAllGlobals());
it('allows only the actual extension UI pages with matching identity', () => {
  expect(isTrustedExtensionSender({ id: 'self', url: 'chrome-extension://self/options.html#license' })).toBe(true);
  expect(isTrustedExtensionSender({ id: 'self', url: 'chrome-extension://self/popup.html' })).toBe(true);
});
it('rejects provider pages, unknown extension pages and tab-less unknown senders', () => {
  expect(isTrustedExtensionSender({ id: 'self', url: 'https://chatgpt.com/c/one' })).toBe(false);
  expect(isTrustedExtensionSender({ id: 'self', url: 'chrome-extension://self/provider-main.js' })).toBe(false);
  expect(isTrustedExtensionSender({ id: 'self' })).toBe(false);
});
it('does not confuse identical paths or opaque origins on other hosts with trusted pages', () => {
  expect(isTrustedExtensionSender({ id: 'other', url: 'chrome-extension://self/options.html' })).toBe(false);
  expect(isTrustedExtensionSender({ id: 'self', url: 'chrome-extension://other/options.html' })).toBe(false);
  expect(isTrustedExtensionSender({ id: 'self', url: 'https://self/options.html' })).toBe(false);
});
