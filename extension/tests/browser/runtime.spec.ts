import { chromium, expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function chromiumExecutable(): string {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;
  const preferred = chromium.executablePath();
  if (existsSync(preferred)) return preferred;
  const cache = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      for (const folder of ['chrome-win64', 'chrome-win']) {
        const candidate = join(cache, entry, folder, 'chrome.exe');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('A Playwright Chromium executable is required for the native extension check.');
}

test('packaged extension starts its real worker and persists settings through real UI messaging', async () => {
  test.setTimeout(60_000);
  const root = resolve('.output/runtime-checks');
  mkdirSync(root, { recursive: true });
  const profile = mkdtempSync(join(root, 'profile-'));
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromiumExecutable(), headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('chrome-extension://' + id + '/options.html');
    const manifest = await page.evaluate(() => chrome.runtime.getManifest());
    const claudeOptionalOrigin = manifest?.optional_host_permissions?.includes('https://claude.ai/*') ?? false;
    const claudeWebAccessible = manifest?.web_accessible_resources?.some((resource) => resource.matches?.some((match) => match.startsWith('https://claude.ai/'))) ?? false;
    expect(claudeWebAccessible).toBe(claudeOptionalOrigin);
    await expect(page.getByText('Chatlog', { exact: true }).first()).toBeVisible();
    const status = await page.evaluate("chrome.runtime.sendMessage({ action: 'status.get' })");
    expect(status).toMatchObject({ folder: 'missing', connected: [], license: { state: 'trial', daysLeft: 14, historyLimit: 25, configured: false } });
    expect(await page.evaluate("chrome.runtime.sendMessage({ action: 'folder.writeTest' })")).toMatchObject({ ok: false, status: 'blocked' });
    if (claudeOptionalOrigin) {
      const connection = await page.evaluate("chrome.runtime.sendMessage({ action: 'provider.check', provider: 'claude' })");
      expect(connection).toMatchObject({ ok: false });
      expect(connection.message).toContain('site access is missing');
      expect(connection.report).toContain('Site access: missing');
      const checkStatus = await page.evaluate("chrome.runtime.sendMessage({ action: 'status.get' })");
      expect(checkStatus.claudeConnection).toMatchObject({ code: 'site_access', ok: false });
      expect(await page.evaluate("chrome.runtime.sendMessage({ action: 'provider.reset', provider: 'claude' })")).toMatchObject({ ok: true });
      const resetStatus = await page.evaluate("chrome.runtime.sendMessage({ action: 'status.get' })");
      expect(resetStatus.claudeConnection).toBeNull();
      await page.evaluate("chrome.runtime.sendMessage({ action: 'settings.set', patch: { onboardingComplete: true } })");
      await page.reload();
      await page.getByRole('button', { name: 'Connections', exact: true }).click();
      await expect(page.locator('.provider-connection[data-provider="claude"]')).toBeVisible();
      await expect(page.locator('.provider-connection[data-provider="claude"]').getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    } else {
      expect(manifest?.optional_host_permissions).not.toContain('https://claude.ai/*');
      expect(manifest?.web_accessible_resources?.flatMap((resource) => resource.matches ?? [])).not.toContain('https://claude.ai/*');
      await page.evaluate(() => chrome.storage.local.set({
        connectedProviders: ['claude'],
        syncStatus: [{ provider: 'claude', state: 'error', lastRunAt: null, discoveredCount: 3, savedCount: 1, error: 'blocked' }],
        claudeConnectionCheck: { provider: 'claude', ok: false, code: 'blocked', message: 'stale Claude report' },
        savedClaudeSentinel: { key: 'claude:workspace:saved', value: 'archive metadata stays' },
      }));
      await page.evaluate("chrome.runtime.sendMessage({ action: 'settings.set', patch: { onboardingComplete: true } })");
      const connection = await page.evaluate("chrome.runtime.sendMessage({ action: 'provider.check', provider: 'claude' })");
      expect(connection).toMatchObject({ ok: false, message: 'Claude is temporarily disabled in this testing build.' });
      expect(await page.evaluate("chrome.runtime.sendMessage({ action: 'provider.reset', provider: 'claude' })")).toMatchObject({ ok: false, message: 'Claude is temporarily disabled in this testing build.' });
      const checkStatus = await page.evaluate("chrome.runtime.sendMessage({ action: 'status.get' })");
      expect(checkStatus.connected).not.toContain('claude');
      expect(checkStatus.sync).not.toContainEqual(expect.objectContaining({ provider: 'claude' }));
      expect(checkStatus.imports).not.toContainEqual(expect.objectContaining({ provider: 'claude' }));
      expect(checkStatus.claudeConnection).toBeNull();
      await page.reload();
      await page.getByRole('button', { name: 'Connections', exact: true }).click();
      await expect(page.locator('.provider-connection[data-provider="claude"]')).toHaveCount(0);
      await page.getByRole('button', { name: /^Capture & history/ }).click();
      await expect(page.locator('.sync-provider[data-provider="claude"]')).toHaveCount(0);
      expect(await page.evaluate("chrome.storage.local.get('savedClaudeSentinel')")).toEqual({ savedClaudeSentinel: { key: 'claude:workspace:saved', value: 'archive metadata stays' } });
    }
    const diagnostics = await page.evaluate("chrome.storage.local.get('lastBackgroundError')");
    expect(diagnostics.lastBackgroundError).toBeUndefined();
    const changed = await page.evaluate("chrome.runtime.sendMessage({ action: 'settings.set', patch: { autoSync: false, theme: 'dark' } })");
    expect(changed).toMatchObject({ autoSync: false, theme: 'dark' });
    await page.reload();
    const reloaded = await page.evaluate("chrome.runtime.sendMessage({ action: 'status.get' })");
    expect(reloaded.settings).toMatchObject({ autoSync: false, theme: 'dark' });
    expect(await page.evaluate("chrome.runtime.sendMessage({ action: 'archive.search', query: 'nothing here' })")).toEqual([]);
    const rejected = await page.evaluate("chrome.runtime.sendMessage({ action: 'settings.set', patch: { autoSync: 'invalid' } })");
    expect(rejected).toBeNull();
    await page.screenshot({ path: join(root, 'options-startup.png'), fullPage: true });
    await page.goto('chrome-extension://' + id + '/popup.html');
    await expect(page.getByText('Chatlog', { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
