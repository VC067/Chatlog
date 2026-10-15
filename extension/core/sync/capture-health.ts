type Provider = 'chatgpt' | 'claude';
type Outcome = 'queued' | 'saved' | 'needs_signin' | 'unreadable' | 'blocked' | 'rate_limited' | 'history_limit' | 'unavailable';
export async function recordCaptureHealth(provider: Provider, outcome: Outcome, source?: 'fetch' | 'visible'): Promise<void> {
  try {
    const key = `capture-health:${provider}`;
    const stored = await browser.storage.local.get(key);
    const previous = stored[key] && typeof stored[key] === 'object' ? stored[key] as Record<string, unknown> : {};
    const at = new Date().toISOString();
    await browser.storage.local.set({ [key]: {
      provider, outcome, at,
      lastSignalAt: outcome === 'queued' ? at : previous.lastSignalAt ?? null,
      lastSaveAt: outcome === 'saved' ? at : previous.lastSaveAt ?? null,
      source: source ?? previous.source ?? null,
    } });
  } catch { /* Health metadata must never interrupt a save. */ }
}
export async function readCaptureHealth(): Promise<unknown[]> {
  const stored = await browser.storage.local.get(['capture-health:chatgpt', 'capture-health:claude']);
  return ['chatgpt', 'claude'].map((provider) => stored[`capture-health:${provider}`] ?? { provider, outcome: 'no_signal_received' });
}

export async function collectCaptureRuntime() {
  const result: unknown[] = [];
  let registered: string[] = [];
  try { registered = (await browser.scripting.getRegisteredContentScripts({ ids: ['vaultdraft-provider-relay', 'vaultdraft-provider-main'] })).flatMap((script) => script.matches ?? []); } catch { /* Unavailable is reported per tab below. */ }
  for (const provider of ['chatgpt', 'claude'] as const) {
    const origin = provider === 'claude' ? 'https://claude.ai' : 'https://chatgpt.com';
    const states: unknown[] = [];
    try {
      const tabs = await browser.tabs.query({ url: `${origin}/*` });
      for (const tab of tabs.slice(0, 5)) {
        if (tab.id == null || tab.discarded || tab.status === 'loading') continue;
        const [entry] = await browser.scripting.executeScript({
          target: { tabId: tab.id }, world: 'ISOLATED',
          func: () => ({
            relayInstalled: typeof (window as Window & { __chatlogRelayListener?: unknown }).__chatlogRelayListener === 'function',
            visibleObserverInstalled: typeof (window as Window & { __chatlogClaudePageCleanup?: unknown }).__chatlogClaudePageCleanup === 'function',
            userBlocks: document.querySelectorAll('.font-user, [data-testid="user-message"], .font-user-message').length,
            assistantBlocks: document.querySelectorAll('.font-claude, [data-testid="assistant-message"], .font-claude-response, .font-claude-message').length,
          }),
        });
        states.push(entry?.result ?? { unavailable: true });
      }
    } catch { states.push({ unavailable: true }); }
    result.push({ provider, registered: registered.includes(`${origin}/*`), tabs: states });
  }
  return result;
}
