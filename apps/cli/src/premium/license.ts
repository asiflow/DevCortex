// ============================================================================
// Offline Ed25519 license verification for DevCortex Premium.
//
// This module is intentionally PUBLIC: the verification logic and the public
// keys ARE the trust bootstrap, and are safe (and auditable) in open-source
// code. No private key material exists anywhere in this repository.
//
// MIRROR-FILE DISCIPLINE: `canonicalJson` is THE signing contract. The cloud
// licensing service (devcortex-cloud `src/services/licenses.ts`) duplicates
// it verbatim and it MUST stay byte-identical on both sides — a one-character
// divergence breaks every signature. Keep it dependency-free; change both
// sides together or not at all.
//
// This is a verification PRIMITIVE: `verifyLicenseFile` never throws. Garbage
// input of any shape returns `{ state: 'invalid' }`; the commands built on
// top decide what is fatal.
// ============================================================================

import { createPublicKey, verify } from 'node:crypto';

import { PREMIUM_PUBKEYS } from './pubkeys';

const DAY_MS = 86_400_000;

export interface LicensePayload {
  v: 1;
  /** stable key id for revocation lookups */
  kid: string;
  /** licensee (org slug or email) */
  sub: string;
  plan: string; // e.g. 'premium'
  seats: number;
  /** ISO-8601 expiry */
  exp: string;
  /** days premium keeps working after exp / failed refresh */
  graceDays: number;
  /** duration used by refresh to compute the next exp */
  durationDays: number;
  features: string[];
}

export interface LicenseFile {
  payload: LicensePayload;
  sig: string /* base64 Ed25519 */;
}

/**
 * Deterministic JSON: recursively key-sorted objects, arrays in order, no
 * whitespace. The ONLY bytes ever signed/verified. Mirrors JSON.stringify
 * semantics for non-JSON values (undefined object properties are dropped).
 *
 * MIRROR FILE: devcortex-cloud `src/services/licenses.ts` must stay
 * byte-identical to this function.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue; // JSON.stringify parity
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

export type LicenseState = 'valid' | 'grace' | 'expired' | 'invalid';

export interface LicenseCheck {
  state: LicenseState;
  /** human-actionable explanation for grace/expired/invalid */
  reason?: string;
  /** whole days until hard stop (exp + graceDays); present for valid/grace */
  daysLeft?: number;
  payload?: LicensePayload;
}

// --- Shape guards (run BEFORE any crypto — never hand garbage to verify) ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLicensePayload(value: unknown): value is LicensePayload {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    typeof value.kid === 'string' &&
    typeof value.sub === 'string' &&
    typeof value.plan === 'string' &&
    typeof value.seats === 'number' &&
    Number.isFinite(value.seats) &&
    typeof value.exp === 'string' &&
    Number.isFinite(Date.parse(value.exp)) &&
    typeof value.graceDays === 'number' &&
    Number.isFinite(value.graceDays) &&
    typeof value.durationDays === 'number' &&
    Number.isFinite(value.durationDays) &&
    Array.isArray(value.features) &&
    value.features.every((feature) => typeof feature === 'string')
  );
}

function isLicenseFile(value: unknown): value is LicenseFile {
  return isRecord(value) && typeof value.sig === 'string' && isLicensePayload(value.payload);
}

/**
 * Verify a parsed license file against the embedded (or supplied) public
 * keys and classify it on the valid → grace → expired timeline. Any shape or
 * signature problem yields `{ state: 'invalid' }` — this function never
 * throws, and it never calls crypto with an unvalidated shape.
 */
export function verifyLicenseFile(
  file: unknown,
  options?: { publicKeysPem?: readonly string[]; now?: Date },
): LicenseCheck {
  if (!isLicenseFile(file)) {
    return {
      state: 'invalid',
      reason: 'License file is malformed — expected { payload, sig } issued by DevCortex.',
    };
  }
  const { payload, sig } = file;

  // Rotation = append, never replace: any known key may have signed this
  // license, so every key gets a chance. An empty key list fails closed.
  const keys = options?.publicKeysPem ?? PREMIUM_PUBKEYS;
  let message: Buffer;
  try {
    message = Buffer.from(canonicalJson(payload));
  } catch {
    // e.g. a circular in-memory object that satisfies the shape guard's
    // required fields — cannot happen via JSON.parse, but the primitive's
    // never-throw contract holds for ANY input.
    return { state: 'invalid', reason: 'License payload could not be canonicalized.' };
  }
  const signature = Buffer.from(sig, 'base64');
  const signedByKnownKey = keys.some((pem) => {
    try {
      return verify(null, message, createPublicKey(pem), signature);
    } catch {
      // Malformed PEM or signature bytes — an unverifiable key is a
      // non-match, never an exception surfaced to the caller.
      return false;
    }
  });
  if (!signedByKnownKey) {
    return {
      state: 'invalid',
      reason: 'License signature does not match any known DevCortex signing key.',
    };
  }

  const nowMs = (options?.now ?? new Date()).getTime();
  const expMs = Date.parse(payload.exp);
  const hardStopMs = expMs + payload.graceDays * DAY_MS;
  const daysLeft = Math.floor((hardStopMs - nowMs) / DAY_MS);
  const expDate = new Date(expMs).toISOString().slice(0, 10);

  if (nowMs <= expMs) {
    return { state: 'valid', daysLeft, payload };
  }
  if (nowMs <= hardStopMs) {
    return {
      state: 'grace',
      daysLeft,
      reason: `License expired ${expDate} — premium keeps working ${daysLeft} more day(s); run \`devcortex premium refresh\`.`,
      payload,
    };
  }
  return {
    state: 'expired',
    reason: `License expired ${expDate} and the ${payload.graceDays}-day grace window has ended. Run \`devcortex premium refresh\`, or renew at https://cloud.devcortex.dev.`,
    payload,
  };
}
