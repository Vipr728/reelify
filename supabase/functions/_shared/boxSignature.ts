/**
 * Box webhook / Custom Skill signature verification (webhooks v2).
 *
 * Implements Box's official "Signature Verification" algorithm:
 *   1. Freshness: parse `box-delivery-timestamp` (RFC-3339). If it is missing,
 *      unparseable, or older than 10 minutes, the payload is rejected.
 *   2. Digest: HMAC-SHA256(key, bytes) where `bytes = utf8(rawBody) ++ utf8(timestamp)`
 *      — the raw request body bytes FIRST, then the timestamp bytes. The raw
 *      digest is then base64-encoded.
 *   3. Compute one digest with the primary key and one with the secondary key.
 *   4. Authentic iff NOT expired AND at least one present key's base64 digest
 *      equals the matching `box-signature-*` header (timing-safe compare). Box
 *      rotates keys, so EITHER signature matching is sufficient.
 *
 * Deno / Supabase edge runtime: uses Web Crypto (`crypto.subtle`) and Web/Deno
 * globals only. No Node `crypto`, no external imports.
 */

/** Maximum age of a Box delivery before it is treated as expired (10 minutes). */
const MAX_AGE_MS = 10 * 60 * 1000;

export interface BoxSignatureKeys {
  /** BOX_SKILL_PRIMARY_KEY */
  primaryKey?: string;
  /** BOX_SKILL_SECONDARY_KEY */
  secondaryKey?: string;
}

/**
 * Reads Box signature keys from the Deno environment.
 * Either or both may be undefined if not configured.
 */
export function boxSignatureKeysFromEnv(): BoxSignatureKeys {
  return {
    primaryKey: Deno.env.get("BOX_SKILL_PRIMARY_KEY") ?? undefined,
    secondaryKey: Deno.env.get("BOX_SKILL_SECONDARY_KEY") ?? undefined,
  };
}

/**
 * Verify a Box webhook/Custom Skill payload is cryptographically authentic.
 *
 * Returns true ONLY when the signature is valid and fresh. If BOTH keys are
 * absent/empty this returns `false`, because verification is impossible — it
 * does NOT mean "trusted". The CALLER decides whether missing keys should be
 * treated as "skip verification (hackathon mode)" or "reject"; this function
 * only answers the question "is it cryptographically valid?".
 *
 * @param rawBody The EXACT raw request body string. The caller must read
 *   `await req.text()` BEFORE `JSON.parse`-ing, so the bytes match what Box signed.
 * @param headers The incoming `Request.headers` (a `Headers` object).
 * @param keys Primary/secondary keys (e.g. from `boxSignatureKeysFromEnv()`).
 */
export async function verifyBoxSignature(
  rawBody: string,
  headers: Headers,
  keys: BoxSignatureKeys,
): Promise<boolean> {
  const primaryKey = keys.primaryKey ?? "";
  const secondaryKey = keys.secondaryKey ?? "";

  // Cannot verify without at least one key.
  if (primaryKey.length === 0 && secondaryKey.length === 0) return false;

  // Box signature headers (case-insensitive; Headers.get is already case-insensitive).
  const timestamp = headers.get("box-delivery-timestamp") ?? "";
  const sigPrimary = headers.get("box-signature-primary") ?? "";
  const sigSecondary = headers.get("box-signature-secondary") ?? "";

  // Step 1: freshness. Missing/unparseable timestamp (NaN) or too old => invalid.
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return false;
  if (Date.now() - parsed > MAX_AGE_MS) return false;

  // Steps 2-4: compute digest only for present keys and timing-safe compare.
  if (primaryKey.length > 0 && sigPrimary.length > 0) {
    const digestPrimary = await hmacBase64(primaryKey, rawBody, timestamp);
    if (timingSafeEqual(digestPrimary, sigPrimary)) return true;
  }

  if (secondaryKey.length > 0 && sigSecondary.length > 0) {
    const digestSecondary = await hmacBase64(secondaryKey, rawBody, timestamp);
    if (timingSafeEqual(digestSecondary, sigSecondary)) return true;
  }

  return false;
}

/**
 * HMAC-SHA256 over `utf8(body) ++ utf8(timestamp)` (body bytes first, then
 * timestamp bytes), base64-encoded. Uses Web Crypto's `crypto.subtle`.
 */
async function hmacBase64(
  key: string,
  body: string,
  timestamp: string,
): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // Body bytes FIRST, then timestamp bytes.
  const bodyBytes = enc.encode(body);
  const tsBytes = enc.encode(timestamp);
  const msg = new Uint8Array(bodyBytes.length + tsBytes.length);
  msg.set(bodyBytes, 0);
  msg.set(tsBytes, bodyBytes.length);

  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msg);

  // base64 of the raw digest bytes.
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Constant-time string comparison. Returns false immediately on length
 * mismatch, otherwise XOR-accumulates char-code differences across the full
 * length so the comparison time does not leak where a mismatch occurred.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
