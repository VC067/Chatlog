import { openVaultDb } from '../../core/storage/db.ts';

const ROOT_KEY = 'markdown-root';

export async function saveRootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const database = await openVaultDb();
  try {
    await database.put('handles', handle, ROOT_KEY);
  } finally {
    database.close();
  }
}

export async function readRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  const database = await openVaultDb();
  try {
    const handle = await database.get('handles', ROOT_KEY);
    return handle ?? null;
  } finally {
    database.close();
  }
}
