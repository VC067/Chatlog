import { parseTrustedCommand } from '../../core/contracts/messages.ts';
import { queueCaptureSignal } from '../../core/sync/run.ts';
import { validateCaptureSignal } from './validate.ts';
import { getEntitlementStatus } from '../../core/licensing/policy.ts';
import { readSettings } from '../../core/settings.ts';
import { CLAUDE_ENABLED } from '../../core/provider-features.ts';

export const REFRESH_CONNECTED_TAB_HINT =
  CLAUDE_ENABLED ? 'Refresh an open ChatGPT or Claude tab after connecting it.' : 'Refresh an open ChatGPT tab after connecting it.';

const MAIN_ID = 'vaultdraft-provider-main';
const RELAY_ID = 'vaultdraft-provider-relay';

function matchesFor(connected: string[]): string[] {
  const matches: string[] = [];
  if (connected.includes('chatgpt')) {
    matches.push('https://chatgpt.com/*');
  }
  if (CLAUDE_ENABLED && connected.includes('claude')) {
    matches.push('https://claude.ai/*');
  }
  return matches;
}

async function readConnected(): Promise<string[]> {
  const stored = await browser.storage.local.get('connectedProviders');
  return Array.isArray(stored.connectedProviders)
    ? stored.connectedProviders.filter((value): value is string => typeof value === 'string')
    : [];
}

let registration: Promise<void> = Promise.resolve();

export function syncCaptureScripts(): Promise<void> {
  registration = registration.then(installCaptureScripts, installCaptureScripts);
  return registration;
}

async function installCaptureScripts(): Promise<void> {
  const matches = matchesFor(await readConnected());
  try {
    await browser.scripting.unregisterContentScripts({ ids: [MAIN_ID, RELAY_ID] });
  } catch {
    // Chrome throws when those ids are not registered yet.
  }
  if (matches.length === 0) {
    return;
  }
  await browser.scripting.registerContentScripts([
    {
      id: MAIN_ID,
      js: ['content-scripts/provider-main.js'],
      matches,
      runAt: 'document_start',
      world: 'MAIN',
    },
    {
      id: RELAY_ID,
      js: ['content-scripts/provider-relay.js'],
      matches,
      runAt: 'document_start',
      world: 'ISOLATED',
    },
  ]);
  // Registration covers future navigations. Reconnect/reload must also attach
  // the relay to already open pages whose old extension context was invalidated.
  const tabs = await browser.tabs?.query({ url: matches }) ?? [];
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded || tab.status === 'loading') continue;
    let origin: string;
    try { origin = new URL(tab.url ?? '').origin; } catch { continue; }
    if (!matches.includes(`${origin}/*`)) continue;
    try {
      await browser.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['/content-scripts/provider-relay.js'] });
      await browser.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['/content-scripts/provider-main.js'] });
    } catch {
      // A tab can navigate or lose permission between the query and injection.
    }
  }
}

export async function disconnectProvider(provider: 'chatgpt' | 'claude' | 'grok'): Promise<void> {
  const current = await readConnected();
  await browser.storage.local.set({
    connectedProviders: current.filter((item) => item !== provider),
  });
  await syncCaptureScripts();
}

export async function connectProvider(provider: 'chatgpt' | 'claude' | 'grok'): Promise<void> {
  if (provider === 'claude' && !CLAUDE_ENABLED) throw new Error('Claude is temporarily disabled in this testing build.');
  const current = await readConnected();
  const next = current.includes(provider) ? current : [...current, provider];
  await browser.storage.local.set({ connectedProviders: next });
  try {
    await syncCaptureScripts();
  } catch {
    // The site permission can be saved even when the content script is not registered yet.
  }
}

export function registerCapture(): void {
  browser.runtime.onInstalled.addListener(() => {
    void syncCaptureScripts().catch(() => undefined);
  });
  browser.runtime.onStartup.addListener(() => {
    void syncCaptureScripts().catch(() => undefined);
  });
  void syncCaptureScripts().catch(() => undefined);
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) {
      return;
    }
    const extensionPage =
      sender.url?.startsWith(browser.runtime.getURL('')) === true ||
      sender.tab?.url?.startsWith(browser.runtime.getURL('')) === true;
    const command = extensionPage ? parseTrustedCommand(message) : null;
    if (command?.success && command.data.action === 'provider.connect') {
      void connectProvider(command.data.provider).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    if (command?.success && command.data.action === 'provider.disconnect') {
      void disconnectProvider(command.data.provider).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    if (!sender.tab || extensionPage) {
      return;
    }
    if (message && typeof message === 'object' && message.type === 'CLAUDE_PAGE_CHANGED') {
      if (!CLAUDE_ENABLED || message.source !== 'chatlog-page' || message.pageOrigin !== 'https://claude.ai' ||
        typeof message.conversationId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(message.conversationId) ||
        Object.keys(message).some((key) => !['source', 'type', 'pageOrigin', 'conversationId'].includes(key))) return;
      try {
        const tabUrl = new URL(sender.tab.url ?? '');
        if (tabUrl.origin !== 'https://claude.ai' || tabUrl.pathname !== `/chat/${message.conversationId}` ||
          sender.url && new URL(sender.url).origin !== tabUrl.origin || sender.frameId && sender.frameId !== 0) return;
      } catch { return; }
      void captureAllowed('claude').then(async (allowed) => {
        if (!allowed) { sendResponse({ ok: false, reason: 'capture_paused' }); return; }
        await queueCaptureSignal('claude', '__visible__', message.conversationId, 'visible');
        sendResponse({ ok: true });
      }).catch(() => sendResponse({ ok: false, reason: 'capture_persistence_failed' }));
      return true;
    }
    let signalOrigin = '';
    try {
      signalOrigin = new URL(sender.tab.url ?? '').origin;
      if (sender.url && new URL(sender.url).origin !== signalOrigin) return;
    } catch {
      signalOrigin = '';
    }
    const signal = validateCaptureSignal(message, signalOrigin);
    if (signal) {
      void captureAllowed(signal.provider).then(async (allowed) => {
        if (!allowed) { sendResponse({ ok: false, reason: 'capture_paused' }); return; }
        await queueCaptureSignal(signal.provider, signal.accountScope, signal.conversationId);
        sendResponse({ ok: true });
      }).catch(() => sendResponse({ ok: false, reason: 'capture_persistence_failed' }));
      return true;
    }
  });
}

async function captureAllowed(provider: 'chatgpt' | 'claude'): Promise<boolean> {
  if (provider === 'claude' && !CLAUDE_ENABLED) return false;
  const settings = await readSettings();
  const entitlement = await getEntitlementStatus();
  return settings.autoSync && entitlement.autoCaptureAllowed && (await readConnected()).includes(provider);
}
