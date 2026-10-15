import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('production manifest keeps the initial permissions', () => {
  const manifest = JSON.parse(
    readFileSync('.output/chrome-mv3/manifest.json', 'utf8'),
  ) as { manifest_version: number; name: string; permissions: string[] };

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.name).toBe('Chatlog');
  expect(manifest.permissions).toEqual(
    expect.arrayContaining(['storage', 'scripting', 'alarms', 'activeTab']),
  );
  expect(manifest.permissions).not.toContain('declarativeNetRequest');
  expect(manifest.permissions).not.toContain('cookies');
  expect(manifest.permissions).not.toContain('debugger');
});
