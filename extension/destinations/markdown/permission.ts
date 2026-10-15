export type FolderAccess = 'missing' | 'prompt' | 'granted' | 'denied';

export function accessFromPermission(
  handlePresent: boolean,
  state: PermissionState | null,
): FolderAccess {
  if (!handlePresent) {
    return 'missing';
  }
  if (state === 'granted') {
    return 'granted';
  }
  if (state === 'denied') {
    return 'denied';
  }
  return 'prompt';
}

export async function readFolderAccess(
  handle: FileSystemDirectoryHandle | null,
): Promise<FolderAccess> {
  if (!handle || typeof handle.queryPermission !== 'function') {
    return handle ? 'prompt' : 'missing';
  }
  try {
    const state = await handle.queryPermission({ mode: 'readwrite' });
    return accessFromPermission(true, state);
  } catch {
    return 'prompt';
  }
}

export function pickerWasCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
