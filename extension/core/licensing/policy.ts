import { product } from '../../config/product.ts';
import { activateLicenseKey, deactivateLicenseKey, validateLicenseKey } from './dodo.ts';

export const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const REVALIDATE_MS = 24 * 60 * 60 * 1000;

export interface EntitlementStatus {
  state: 'trial' | 'active' | 'trial_expired' | 'license_unavailable' | 'revoked';
  daysLeft: number;
  autoCaptureAllowed: boolean;
  historyLimit: 25 | null;
  canImportHistory: boolean;
  checkoutUrl: string | null;
  configured: boolean;
  canDeactivate: boolean;
  lastCheckedAt: number | null;
  offlineGraceEndsAt: number | null;
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function trialDaysLeft(startedAt: number, now = Date.now()): number {
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.min(14, Math.ceil((startedAt + TRIAL_MS - now) / (24 * 60 * 60 * 1000))));
}

let starting: Promise<number> | null = null;
export function ensureTrialStart(): Promise<number> {
  starting ??= initializeTrial().finally(() => { starting = null; });
  return starting;
}

async function initializeTrial(): Promise<number> {
  const local = await browser.storage.local.get('trialStartedAt');
  let synced: Record<string, unknown> = {};
  try {
    if (browser.storage.sync) synced = await browser.storage.sync.get('trialStartedAt');
  } catch { /* Chrome sync is optional. */ }
  const candidates = [timestamp(local.trialStartedAt), timestamp(synced.trialStartedAt)]
    .filter((value): value is number => value !== null);
  const startedAt = candidates.length > 0 ? Math.min(...candidates, Date.now()) : Date.now();
  if (local.trialStartedAt !== startedAt) await browser.storage.local.set({ trialStartedAt: startedAt });
  try {
    if (browser.storage.sync && synced.trialStartedAt !== startedAt) {
      await browser.storage.sync.set({ trialStartedAt: startedAt });
    }
  } catch { /* A sync outage must not stop local saving. */ }
  return startedAt;
}

export async function getEntitlementStatus(now = Date.now()): Promise<EntitlementStatus> {
  const startedAt = await ensureTrialStart();
  const stored = await browser.storage.local.get([
    'licenseKey', 'licenseInstanceId', 'licenseValid', 'licenseCheckedAt', 'licenseBusinessId', 'licenseProductId',
  ]);
  const configured = Boolean(product.billing.businessId && product.billing.productIds.length > 0);
  const bound = configured && stored.licenseBusinessId === product.billing.businessId &&
    typeof stored.licenseProductId === 'string' && product.billing.productIds.includes(stored.licenseProductId);
  const checkedAt = timestamp(stored.licenseCheckedAt);
  const hasKey = typeof stored.licenseKey === 'string' && stored.licenseKey.length > 0;
  const valid = hasKey && typeof stored.licenseInstanceId === 'string' && stored.licenseValid === true && bound;
  const graceEndsAt = valid && checkedAt !== null ? checkedAt + OFFLINE_GRACE_MS : null;
  const active = valid && checkedAt !== null && checkedAt <= now && graceEndsAt !== null && graceEndsAt > now;
  const daysLeft = trialDaysLeft(startedAt, now);
  const state: EntitlementStatus['state'] = active ? 'active'
    : valid ? 'license_unavailable'
    : daysLeft > 0 ? 'trial'
    : hasKey ? 'revoked'
    : 'trial_expired';
  return {
    state, daysLeft, autoCaptureAllowed: active || daysLeft > 0,
    historyLimit: active ? null : 25,
    canImportHistory: active || daysLeft > 0,
    checkoutUrl: product.billing.checkoutUrl, configured,
    canDeactivate: hasKey && typeof stored.licenseInstanceId === 'string',
    lastCheckedAt: checkedAt, offlineGraceEndsAt: graceEndsAt,
  };
}

let refreshing: Promise<void> | null = null;
export function refreshLicense(): Promise<void> {
  refreshing ??= refresh().finally(() => { refreshing = null; });
  return refreshing;
}

async function refresh(): Promise<void> {
  const stored = await browser.storage.local.get([
    'licenseKey', 'licenseInstanceId', 'licenseCheckedAt', 'licenseBusinessId', 'licenseProductId',
  ]);
  if (typeof stored.licenseKey !== 'string' || typeof stored.licenseInstanceId !== 'string') return;
  if (stored.licenseBusinessId !== product.billing.businessId || typeof stored.licenseProductId !== 'string' ||
    !product.billing.productIds.includes(stored.licenseProductId)) return;
  const checkedAt = timestamp(stored.licenseCheckedAt) ?? 0;
  if (Date.now() - checkedAt < REVALIDATE_MS) return;
  const valid = await validateLicenseKey(stored.licenseKey, stored.licenseInstanceId);
  if (valid === null) return;
  await browser.storage.local.set({ licenseValid: valid, licenseCheckedAt: Date.now() });
}

export async function activateLicense(licenseKey: string): Promise<{ ok: boolean; message: string; license: EntitlementStatus }> {
  const key = licenseKey.trim();
  let license = await getEntitlementStatus();
  if (!license.configured) return { ok: false, message: 'License activation will be available when purchase setup is complete.', license };
  if (key.length < 8 || key.length > 1000) return { ok: false, message: 'Enter the license key from your purchase email.', license };
  const previous = await browser.storage.local.get([
    'licenseKey', 'licenseInstanceId', 'licenseBusinessId', 'licenseProductId',
  ]);
  if (previous.licenseKey === key && typeof previous.licenseInstanceId === 'string') {
    const valid = await validateLicenseKey(key, previous.licenseInstanceId);
    if (valid === true && previous.licenseBusinessId === product.billing.businessId &&
      typeof previous.licenseProductId === 'string' && product.billing.productIds.includes(previous.licenseProductId)) {
      await browser.storage.local.set({ licenseValid: true, licenseCheckedAt: Date.now() });
      return { ok: true, message: 'This browser is activated.', license: await getEntitlementStatus() };
    }
    if (valid === null) return { ok: false, message: 'License verification is temporarily unavailable. Try again shortly.', license };
  }
  const result = await activateLicenseKey(key);
  if (!result.valid) return {
    ok: false, license,
    message: result.error === 'limit' ? 'All five installation slots are in use. Deactivate another installation or contact support.'
      : result.error === 'invalid' ? 'This license could not be activated. Check the key from your purchase email.'
      : 'License activation is temporarily unavailable. Try again shortly.',
  };
  if (result.businessId !== product.billing.businessId || !product.billing.productIds.includes(result.productId)) {
    await deactivateLicenseKey(key, result.instanceId);
    return { ok: false, message: 'This key belongs to a different product.', license };
  }
  const valid = await validateLicenseKey(key, result.instanceId);
  if (valid !== true) {
    await deactivateLicenseKey(key, result.instanceId);
    return {
      ok: false, license,
      message: valid === null ? 'License verification is temporarily unavailable. Try again shortly.' : 'This license is no longer active.',
    };
  }
  if (typeof previous.licenseKey === 'string' && typeof previous.licenseInstanceId === 'string' && previous.licenseKey !== key) {
    if (!await deactivateLicenseKey(previous.licenseKey, previous.licenseInstanceId)) {
      await deactivateLicenseKey(key, result.instanceId);
      return { ok: false, message: 'The previous activation could not be released. Try again shortly.', license };
    }
  }
  await browser.storage.local.set({
    licenseKey: key, licenseInstanceId: result.instanceId,
    licenseBusinessId: result.businessId, licenseProductId: result.productId,
    licenseValid: true, licenseCheckedAt: Date.now(),
  });
  license = await getEntitlementStatus();
  return { ok: true, message: 'Lifetime license activated in this browser.', license };
}

export async function deactivateLicense(): Promise<{ ok: boolean; message: string; license: EntitlementStatus }> {
  const stored = await browser.storage.local.get(['licenseKey', 'licenseInstanceId']);
  if (typeof stored.licenseKey === 'string' && typeof stored.licenseInstanceId === 'string') {
    if (!await deactivateLicenseKey(stored.licenseKey, stored.licenseInstanceId)) {
      return { ok: false, message: 'Could not release this installation. Try again when connected.', license: await getEntitlementStatus() };
    }
  }
  await browser.storage.local.remove([
    'licenseKey', 'licenseInstanceId', 'licenseBusinessId', 'licenseProductId', 'licenseValid', 'licenseCheckedAt',
  ]);
  return { ok: true, message: 'This installation slot has been released. Your saved conversations remain available.', license: await getEntitlementStatus() };
}
