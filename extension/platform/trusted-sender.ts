export function isTrustedExtensionSender(sender: { id?: string; url?: string; tab?: { url?: string } }): boolean {
  if (sender.id !== browser.runtime.id) return false;
  try {
    const own = new URL(browser.runtime.getURL(''));
    const page = new URL(sender.url ?? sender.tab?.url ?? '');
    return page.protocol === own.protocol && page.host === own.host &&
      (page.pathname === '/options.html' || page.pathname === '/popup.html');
  } catch { return false; }
}
