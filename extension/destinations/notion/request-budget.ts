import { sha256Hex } from '../../core/archive/hash.ts';

const PREFIX = 'notion-request-cooldown:';
const REQUEST_GAP_MS = 400;
type CooldownKind = 'rate_limited' | 'service_overload';
interface Cooldown { until: number; kind: CooldownKind }
interface Budget { lastStart: number; cooldown: Cooldown | null; tail: Promise<void>; persistTail: Promise<void> }
const budgets = new Map<string, Budget>();

export class NotionCooldownError extends Error {
  constructor(public kind: CooldownKind, public retryAfterMs: number) {
    super('Notion requests are waiting for the connection cooldown.');
  }
}

function budgetFor(key: string): Budget {
  let budget = budgets.get(key);
  if (!budget) {
    budget = { lastStart: 0, cooldown: null, tail: Promise.resolve(), persistTail: Promise.resolve() };
    budgets.set(key, budget);
  }
  return budget;
}

async function cooldownFor(key: string, budget: Budget): Promise<Cooldown | null> {
  let persisted: unknown;
  try { persisted = (await browser.storage.local.get(PREFIX + key))[PREFIX + key]; } catch { /* Memory still protects this worker. */ }
  if (persisted && typeof persisted === 'object') {
    const value = persisted as Partial<Cooldown>;
    if (typeof value.until === 'number' && Number.isFinite(value.until) && value.until <= 8_640_000_000_000_000 &&
      (value.kind === 'rate_limited' || value.kind === 'service_overload') && value.until > (budget.cooldown?.until ?? 0)) {
      budget.cooldown = { until: value.until, kind: value.kind };
    }
  }
  return budget.cooldown && budget.cooldown.until > Date.now() ? budget.cooldown : null;
}

/** Only short pacing waits stay in memory; long provider waits are durable queue work. */
export async function waitForNotionRequest(token: string): Promise<void> {
  const key = await sha256Hex(token);
  const budget = budgetFor(key);
  const permit = budget.tail.then(async () => {
    let cooldown = await cooldownFor(key, budget);
    if (cooldown) throw new NotionCooldownError(cooldown.kind, cooldown.until - Date.now());
    const delay = budget.lastStart + REQUEST_GAP_MS - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    // An earlier in-flight response can establish a cooldown while this request waits.
    cooldown = await cooldownFor(key, budget);
    if (cooldown) throw new NotionCooldownError(cooldown.kind, cooldown.until - Date.now());
    budget.lastStart = Date.now();
  });
  budget.tail = permit.catch(() => {});
  await permit;
}

export async function rememberNotionCooldown(token: string, retryAfterMs: number, kind: CooldownKind): Promise<void> {
  const key = await sha256Hex(token);
  const budget = budgetFor(key);
  const until = Math.min(8_640_000_000_000_000, Date.now() + retryAfterMs);
  if (!budget.cooldown || budget.cooldown.until < until) budget.cooldown = { until, kind };
  const persist = budget.persistTail.then(async () => {
    await cooldownFor(key, budget);
    try { await browser.storage.local.set({ [PREFIX + key]: budget.cooldown }); } catch { /* The queue also persists the job retry timestamp. */ }
  });
  budget.persistTail = persist.catch(() => {});
  await persist;
}
