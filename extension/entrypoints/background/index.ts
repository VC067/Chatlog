import { registerFolderAccess } from '../../destinations/markdown/register.ts';
import { registerCapture, disconnectProvider } from '../../providers/shared/register.ts';
import { registerArchiveCommands } from '../../platform/commands.ts';
import { runDeliveryQueue } from '../../core/queue/runner.ts';
import { ensureTrialStart, getEntitlementStatus, refreshLicense } from '../../core/licensing/policy.ts';
import { readSettings } from '../../core/settings.ts';
import { discoverPending, recoverSyncWork, startSync } from '../../core/sync/run.ts';
import { CLAUDE_ENABLED } from '../../core/provider-features.ts';

function safely(work: Promise<unknown>): void {
  void work.catch(() => {
    // Keep diagnostics structural: never log payloads, folder paths, tokens or keys.
    void browser.storage.local.set({ lastBackgroundError: 'background_action_failed' }).catch(() => undefined);
  });
}

async function ensureAlarms(): Promise<void> {
  const settings = await readSettings();
  for (const [name, period] of [['vaultdraft-queue', 1], ['vaultdraft-sync', settings.syncIntervalMinutes]] as const) {
    const alarm = await browser.alarms.get(name);
    if (!alarm || alarm.periodInMinutes !== period) await browser.alarms.create(name, { periodInMinutes: period });
  }
}

async function initialize(): Promise<void> {
  for (const area of [browser.storage.local, browser.storage.sync, browser.storage.session]) {
    if (area && typeof area.setAccessLevel === 'function') {
      await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
  }
  await ensureTrialStart();
  if (!CLAUDE_ENABLED) await disconnectProvider('claude');
  await ensureAlarms();
  safely(refreshLicense());
  safely(recoverSyncWork());
  safely(runDeliveryQueue());
}

export default defineBackground(() => {
  registerFolderAccess();
  registerCapture();
  registerArchiveCommands();
  browser.runtime.onInstalled.addListener((details) => {
    safely(initialize());
    if (details.reason === 'install') safely(browser.tabs.create({ url: browser.runtime.getURL('/options.html') }));
  });
  browser.runtime.onStartup.addListener(() => safely(initialize()));
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'vaultdraft-queue') {
      safely(refreshLicense());
      safely(recoverSyncWork());
      safely(runDeliveryQueue());
    } else if (alarm.name === 'vaultdraft-sync') safely(automaticCheck());
  });
  browser.permissions.onRemoved.addListener((details) => {
    for (const [provider, origin] of [['chatgpt', 'https://chatgpt.com/*'], ['claude', 'https://claude.ai/*'], ['grok', 'https://grok.com/*']] as const) {
      if (details.origins?.includes(origin)) safely(disconnectProvider(provider));
    }
  });
  safely(initialize());
});

async function automaticCheck(): Promise<void> {
  const [settings, license] = await Promise.all([readSettings(), getEntitlementStatus()]);
  if (!settings.autoSync || !license.autoCaptureAllowed) return;
  await startSync({ maxItems: settings.latestSaveCount, manual: false });
  await discoverPending(Math.min(settings.latestSaveCount, license.historyLimit ?? 500));
}
