import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../core/archive/hash.ts', () => ({ sha256Hex: async (token: string) => token === 'private-one' ? 'a'.repeat(64) : 'b'.repeat(64) }));
let stored: Record<string, unknown>;
let budget: typeof import('../../destinations/notion/request-budget.ts');
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000);
  stored = {};
  vi.stubGlobal('browser', { storage: { local: {
    get: async (key: string) => ({ [key]: stored[key] }),
    set: async (values: Record<string, unknown>) => { Object.assign(stored, values); },
  } } });
  budget = await import('../../destinations/notion/request-budget.ts');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('paces concurrent request starts for one connection', async () => {
  const starts: number[] = [];
  const start = () => budget.waitForNotionRequest('private-one').then(() => starts.push(Date.now()));
  const pending = Promise.all([start(), start(), start()]);
  await vi.advanceTimersByTimeAsync(399);
  expect(starts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(400);
  expect(starts).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); await pending;
  expect(starts[1]! - starts[0]!).toBe(400);
  expect(starts[2]! - starts[1]!).toBe(400);
});
it('retains a cooldown after worker restart without persisting the token', async () => {
  await budget.rememberNotionCooldown('private-one', 8000, 'rate_limited');
  expect(JSON.stringify(stored)).not.toContain('private-one');
  vi.resetModules(); budget = await import('../../destinations/notion/request-budget.ts');
  await expect(budget.waitForNotionRequest('private-one')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 8000 });
  await vi.advanceTimersByTimeAsync(8000);
  await expect(budget.waitForNotionRequest('private-one')).resolves.toBeUndefined();
});
it('concurrent cooldown updates cannot shorten the longest wait', async () => {
  await Promise.all([
    budget.rememberNotionCooldown('private-one', 5000, 'service_overload'),
    budget.rememberNotionCooldown('private-one', 1000, 'rate_limited'),
  ]);
  vi.resetModules(); budget = await import('../../destinations/notion/request-budget.ts');
  await expect(budget.waitForNotionRequest('private-one')).rejects.toMatchObject({ kind: 'service_overload', retryAfterMs: 5000 });
});
it('keeps unrelated connections independent', async () => {
  await budget.rememberNotionCooldown('private-one', 60_000, 'rate_limited');
  await expect(budget.waitForNotionRequest('private-two')).resolves.toBeUndefined();
});
it('stops a queued start when an earlier response establishes a cooldown', async () => {
  await budget.waitForNotionRequest('private-one');
  const pending = budget.waitForNotionRequest('private-one').then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  await budget.rememberNotionCooldown('private-one', 3000, 'rate_limited');
  await vi.advanceTimersByTimeAsync(300);
  expect(await pending).toMatchObject({ kind: 'rate_limited', retryAfterMs: 2700 });
});
