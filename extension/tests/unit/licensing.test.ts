import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getEntitlementStatus, ensureTrialStart, refreshLicense, activateLicense, deactivateLicense, TRIAL_MS, OFFLINE_GRACE_MS } from '../../core/licensing/policy.ts';
import { validateLicenseKey } from '../../core/licensing/dodo.ts';

const billing = vi.hoisted(() => ({ businessId: 'biz_expected', productIds: ['pdt_expected'], checkoutUrl: null }));
vi.mock('../../config/product.ts', () => ({ product: { billing } }));
let local: Record<string, unknown>;
let synced: Record<string, unknown>;
const now = Date.parse('2026-10-10T00:00:00.000Z');
function area(store: Record<string, unknown>) {
  return {
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => { Object.assign(store, values); },
    remove: async (keys: string[]) => { for (const key of keys) delete store[key]; },
  };
}
function activeLicense(checkedAt = now - 2 * 24 * 60 * 60 * 1000) {
  Object.assign(local, {
    trialStartedAt: now - TRIAL_MS - 1, licenseKey: 'license-expected', licenseInstanceId: 'lki_expected',
    licenseBusinessId: billing.businessId, licenseProductId: billing.productIds[0],
    licenseValid: true, licenseCheckedAt: checkedAt,
  });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  local = {}; synced = {};
  vi.stubGlobal('browser', { storage: { local: area(local), sync: area(synced) } });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('starts one 14-day trial and keeps the earliest synced timestamp', async () => {
  synced.trialStartedAt = now - 2 * 24 * 60 * 60 * 1000;
  const [first, second] = await Promise.all([ensureTrialStart(), ensureTrialStart()]);
  expect(first).toBe(synced.trialStartedAt); expect(second).toBe(first);
  expect(local.trialStartedAt).toBe(first);
  expect(await getEntitlementStatus()).toMatchObject({ state: 'trial', daysLeft: 12, historyLimit: 25, autoCaptureAllowed: true });
});
it('ends automatic and historical access at day 14 without deleting content', async () => {
  local.trialStartedAt = now - TRIAL_MS;
  expect(await getEntitlementStatus()).toMatchObject({ state: 'trial_expired', autoCaptureAllowed: false, canImportHistory: false });
  expect(local.trialStartedAt).toBe(now - TRIAL_MS);
});
it('does not grant paid access from a forged unbound valid flag', async () => {
  activeLicense(); delete local.licenseProductId;
  expect(await getEntitlementStatus()).toMatchObject({ autoCaptureAllowed: false, historyLimit: 25 });
});
it('keeps a verified license through a server outage without resetting its grace clock', async () => {
  activeLicense(); const checkedAt = local.licenseCheckedAt;
  vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 503 }));
  await refreshLicense();
  expect(local.licenseValid).toBe(true); expect(local.licenseCheckedAt).toBe(checkedAt);
  expect(await getEntitlementStatus()).toMatchObject({ state: 'active', historyLimit: null });
});
it('pauses paid automation after seven days without successful verification', async () => {
  activeLicense(now - OFFLINE_GRACE_MS);
  expect(await getEntitlementStatus()).toMatchObject({ state: 'license_unavailable', autoCaptureAllowed: false });
});
it('accepts explicit revocation and keeps the saved key for recovery/support', async () => {
  activeLicense(); vi.mocked(fetch).mockResolvedValue(Response.json({ valid: false }));
  await refreshLicense();
  expect(await getEntitlementStatus()).toMatchObject({ state: 'revoked', autoCaptureAllowed: false });
  expect(local.licenseKey).toBe('license-expected');
});
it('rejects a different merchant/product key and releases the accidental slot', async () => {
  local.trialStartedAt = now - TRIAL_MS;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: 'lki_other', business_id: 'biz_other', product: { product_id: 'pdt_other' } })).mockResolvedValueOnce(Response.json({}));
  const result = await activateLicense('license-other');
  expect(result.ok).toBe(false); expect(result.message).toContain('different product');
  expect(local.licenseKey).toBeUndefined();
  expect(vi.mocked(fetch).mock.calls[1]?.[0]).toContain('/deactivate');
});
it('reuses a valid existing installation instead of spending another activation slot', async () => {
  activeLicense(); vi.mocked(fetch).mockResolvedValue(Response.json({ valid: true }));
  expect((await activateLicense('license-expected')).ok).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('/validate');
});
it('keeps local license data until remote deactivation succeeds', async () => {
  activeLicense(); vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  expect((await deactivateLicense()).ok).toBe(false); expect(local.licenseInstanceId).toBe('lki_expected');
  vi.mocked(fetch).mockResolvedValue(Response.json({}));
  expect((await deactivateLicense()).ok).toBe(true); expect(local.licenseKey).toBeUndefined();
});
it('treats rate limits and malformed successful responses as verification unavailable', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 429 })).mockResolvedValueOnce(Response.json({ unexpected: true }));
  expect(await validateLicenseKey('license-expected', 'lki_expected')).toBeNull();
  expect(await validateLicenseKey('license-expected', 'lki_expected')).toBeNull();
});
