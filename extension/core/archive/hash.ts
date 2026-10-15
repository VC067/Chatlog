export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function stableHash(value: string): string {
  let hash = 5381;
  for (const char of value) {
    hash = Math.imul(hash, 33) ^ (char.codePointAt(0) ?? 0);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
