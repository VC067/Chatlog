import { expect, it, vi } from 'vitest';
import { readSettings, writeSettings } from '../../core/settings.ts';

it('uses Carry defaults and keeps a partial update', async () => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (value: Record<string, unknown>) => {
          Object.assign(store, value);
        },
      },
    },
  });
  const defaults = await readSettings();
  expect(defaults.autoSync).toBe(true);
  expect(defaults.syncIntervalMinutes).toBe(120);
  expect(defaults.saveCowork).toBe(false);
  expect(defaults.includeSources).toBe(false);
  expect(defaults.theme).toBe('light');
  const next = await writeSettings({ theme: 'dark', saveCowork: true });
  expect(next.theme).toBe('dark');
  expect(next.saveCowork).toBe(true);
  expect(next.autoSync).toBe(true);
});
