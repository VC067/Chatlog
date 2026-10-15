export type LicenseActivation =
  | { valid: true; instanceId: string; businessId: string; productId: string }
  | { valid: false; instanceId: null; error: 'invalid' | 'limit' | 'unavailable' };

function baseUrl(live: boolean): string {
  return live ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
}

async function licenseRequest(path: string, body: Record<string, unknown>, live: boolean): Promise<Response> {
  return fetch(baseUrl(live) + '/licenses/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

export async function validateLicenseKey(licenseKey: string, instanceId: string | null, live = true): Promise<boolean | null> {
  try {
    const response = await licenseRequest('validate', {
      license_key: licenseKey,
      ...(instanceId ? { license_key_instance_id: instanceId } : {}),
    }, live);
    if (response.status === 429 || response.status >= 500) return null;
    if (!response.ok) return response.status === 403 || response.status === 404 ? false : null;
    const body = await response.json() as { valid?: unknown };
    return typeof body.valid === 'boolean' ? body.valid : null;
  } catch {
    return null;
  }
}

export async function deactivateLicenseKey(licenseKey: string, instanceId: string | null, live = true): Promise<boolean> {
  if (!instanceId) return false;
  try {
    const response = await licenseRequest('deactivate', {
      license_key: licenseKey,
      license_key_instance_id: instanceId,
    }, live);
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function activateLicenseKey(licenseKey: string, live = true): Promise<LicenseActivation> {
  try {
    const response = await licenseRequest('activate', {
      license_key: licenseKey, name: 'Personal browser installation',
    }, live);
    if (!response.ok) {
      return {
        valid: false, instanceId: null,
        error: response.status === 422 ? 'limit' : response.status === 403 || response.status === 404 ? 'invalid' : 'unavailable',
      };
    }
    const body = await response.json() as {
      id?: unknown; business_id?: unknown; product?: { product_id?: unknown };
    };
    if (typeof body.id !== 'string' || typeof body.business_id !== 'string' || typeof body.product?.product_id !== 'string') {
      if (typeof body.id === 'string') await deactivateLicenseKey(licenseKey, body.id, live);
      return { valid: false, instanceId: null, error: 'unavailable' };
    }
    return { valid: true, instanceId: body.id, businessId: body.business_id, productId: body.product.product_id };
  } catch {
    return { valid: false, instanceId: null, error: 'unavailable' };
  }
}
