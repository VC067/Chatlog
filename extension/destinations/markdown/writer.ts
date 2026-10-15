import { readRootHandle } from './handle-store.ts';
import { readFolderAccess } from './permission.ts';

export const WRITE_TEST_FILE = 'vaultdraft-write-test.md';
export const WRITE_TEST_BODY = `# Chatlog Obsidian write test

This note checks that Chatlog can write Markdown into the selected folder.

- First list item
- Second list item

| Check | Result |
| --- | --- |
| Markdown write | Ready to inspect |

\`\`\`text
Chatlog test note
\`\`\`
`;
const MAX_WRITE_TEST_CANDIDATES = 1000;

let writeTestQueue: Promise<void> = Promise.resolve();

async function writeTestFileSerially(): Promise<
  { status: 'written'; path: string } | { status: 'blocked' }
> {
  const handle = await readRootHandle();
  const access = await readFolderAccess(handle);
  if (!handle || access !== 'granted') {
    return { status: 'blocked' };
  }

  for (let index = 1; index <= MAX_WRITE_TEST_CANDIDATES; index += 1) {
    const path = index === 1
      ? WRITE_TEST_FILE
      : `vaultdraft-write-test-${index}.md`;
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await handle.getFileHandle(path);
      const existing = await fileHandle.getFile();
      if (await existing.text() === WRITE_TEST_BODY) {
        return { status: 'written', path };
      }
      continue;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') {
        return { status: 'blocked' };
      }
    }

    try {
      fileHandle = await handle.getFileHandle(path, { create: true });
      // A file that appeared after the lookup may belong to the user. Recheck
      // it before writing so the test command never replaces differing text.
      const existing = await fileHandle.getFile();
      if (existing.size > 0) {
        if (await existing.text() === WRITE_TEST_BODY) {
          return { status: 'written', path };
        }
        continue;
      }
      const writable = await fileHandle.createWritable();
      await writable.write(WRITE_TEST_BODY);
      await writable.close();
      return { status: 'written', path };
    } catch {
      return { status: 'blocked' };
    }
  }
  return { status: 'blocked' };
}

export function writeTestFile(): Promise<
  { status: 'written'; path: string } | { status: 'blocked' }
> {
  const result = writeTestQueue.then(writeTestFileSerially);
  writeTestQueue = result.then(() => undefined, () => undefined);
  return result;
}
