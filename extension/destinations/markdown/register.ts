import { saveRootHandle } from './handle-store.ts';
import { writeTestFile } from './writer.ts';
import { isTrustedExtensionSender } from '../../platform/trusted-sender.ts';

export function registerFolderAccess(): void {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedExtensionSender(sender)) {
      return;
    }
    if (!message || typeof message !== 'object' || !('action' in message)) {
      return;
    }
    const action = message.action;
    if (action === 'folder.saveHandle') {
      const handle = message.handle as FileSystemDirectoryHandle | undefined;
      if (!handle || typeof handle.queryPermission !== 'function') {
        sendResponse({ ok: false, message: 'Chrome did not pass the folder through.' });
        return true;
      }
      void saveRootHandle(handle).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false, status: 'blocked' }),
      );
      return true;
    }
    if (action === 'folder.writeTest') {
      void writeTestFile().then(
        (result) => sendResponse({
          ok: result.status === 'written',
          status: result.status,
          ...(result.status === 'written' ? { path: result.path } : {}),
        }),
        () => sendResponse({ ok: false, status: 'blocked' }),
      );
      return true;
    }
    return;
  });
}
