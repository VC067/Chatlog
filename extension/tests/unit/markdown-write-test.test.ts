import { beforeEach, expect, it, vi } from 'vitest';
import { WRITE_TEST_BODY, WRITE_TEST_FILE, writeTestFile } from '../../destinations/markdown/writer.ts';

class FakeFile {
  constructor(private readonly bytes: Uint8Array) {}
  get size() { return this.bytes.byteLength; }
  async text() { return new TextDecoder().decode(this.bytes); }
}

class FakeDirectory {
  files = new Map<string, Uint8Array>();
  permission: PermissionState = 'granted';
  writes = 0;

  async queryPermission() { return this.permission; }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('Missing file', 'NotFoundError');
      this.files.set(name, new Uint8Array());
    }
    return {
      getFile: async () => new FakeFile(this.files.get(name)!),
      createWritable: async () => {
        let pending = this.files.get(name)!;
        return {
          write: async (value: string) => { pending = new TextEncoder().encode(value); },
          close: async () => { this.writes += 1; this.files.set(name, pending); },
        };
      },
    };
  }

  read(name: string) { return new TextDecoder().decode(this.files.get(name)); }
  edit(name: string, value: string) { this.files.set(name, new TextEncoder().encode(value)); }
}

const mocks = vi.hoisted(() => ({ root: null as FakeDirectory | null }));
vi.mock('../../destinations/markdown/handle-store.ts', () => ({
  readRootHandle: async () => mocks.root,
}));

let root: FakeDirectory;
beforeEach(() => {
  root = new FakeDirectory();
  mocks.root = root;
});

it('writes and reuses the readable Markdown test note', async () => {
  const first = await writeTestFile();
  const repeat = await writeTestFile();
  expect(first).toEqual({ status: 'written', path: WRITE_TEST_FILE });
  expect(repeat).toEqual(first);
  expect(root.read(WRITE_TEST_FILE)).toBe(WRITE_TEST_BODY);
  expect(root.writes).toBe(1);
  expect(WRITE_TEST_BODY).toContain('| Check | Result |');
  expect(WRITE_TEST_BODY).toContain('```text');
});

it('preserves differing primary and numbered user content', async () => {
  root.edit(WRITE_TEST_FILE, 'my existing note');
  const first = await writeTestFile();
  expect(first).toEqual({ status: 'written', path: 'vaultdraft-write-test-2.md' });
  expect(root.read(WRITE_TEST_FILE)).toBe('my existing note');

  root.edit('vaultdraft-write-test-2.md', 'my edited test note');
  const next = await writeTestFile();
  expect(next).toEqual({ status: 'written', path: 'vaultdraft-write-test-3.md' });
  expect(root.read('vaultdraft-write-test-2.md')).toBe('my edited test note');
});

it('does not write when folder permission is unavailable', async () => {
  root.permission = 'denied';
  await expect(writeTestFile()).resolves.toEqual({ status: 'blocked' });
  expect(root.files.size).toBe(0);
  expect(root.writes).toBe(0);
});

it('serializes concurrent calls so they reuse one note', async () => {
  const results = await Promise.all([writeTestFile(), writeTestFile(), writeTestFile()]);
  expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: 'written', path: WRITE_TEST_FILE })));
  expect([...root.files.keys()]).toEqual([WRITE_TEST_FILE]);
  expect(root.writes).toBe(1);
});
