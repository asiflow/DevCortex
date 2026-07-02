// ============================================================================
// Premium license verification primitives — offline Ed25519 checks.
//
// No private key material lives in this repo: every test generates an
// ephemeral keypair at runtime and signs with it, exercising the exact
// canonical-JSON byte contract the cloud licensing service signs against.
// ============================================================================

import { generateKeyPairSync, sign } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalJson, verifyLicenseFile } from '../src/premium/license';
import type { LicenseFile, LicensePayload } from '../src/premium/license';

let pubPem: string;
let privKey: import('node:crypto').KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  pubPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  privKey = pair.privateKey;
});

function makeLicense(overrides: Partial<LicensePayload> = {}): LicenseFile {
  const payload: LicensePayload = {
    v: 1,
    kid: 'kid-1',
    sub: 'acme',
    plan: 'premium',
    seats: 5,
    exp: new Date(Date.now() + 30 * 86400_000).toISOString(),
    graceDays: 14,
    durationDays: 30,
    features: ['prediction'],
    ...overrides,
  };
  const sig = sign(null, Buffer.from(canonicalJson(payload)), privKey).toString('base64');
  return { payload, sig };
}

describe('verifyLicenseFile', () => {
  it('accepts a well-signed unexpired license', () => {
    const check = verifyLicenseFile(makeLicense(), { publicKeysPem: [pubPem] });
    expect(check.state).toBe('valid');
    expect(check.daysLeft).toBeGreaterThan(30);
  });

  it('rejects any tampered byte', () => {
    const lic = makeLicense();
    lic.payload.seats = 500;
    expect(verifyLicenseFile(lic, { publicKeysPem: [pubPem] }).state).toBe('invalid');
  });

  it('grants grace after expiry, hard-stops after grace', () => {
    const expired = makeLicense({ exp: new Date(Date.now() - 5 * 86400_000).toISOString() });
    expect(verifyLicenseFile(expired, { publicKeysPem: [pubPem] }).state).toBe('grace');
    const dead = makeLicense({ exp: new Date(Date.now() - 20 * 86400_000).toISOString() });
    expect(verifyLicenseFile(dead, { publicKeysPem: [pubPem] }).state).toBe('expired');
  });

  it('canonicalJson sorts keys recursively and is whitespace-free', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe('{"a":{"c":[3],"d":2},"b":1}');
  });

  it('rejects garbage shapes as invalid, never throws', () => {
    expect(verifyLicenseFile('not a license').state).toBe('invalid');
    expect(verifyLicenseFile({ payload: {}, sig: 'x' }).state).toBe('invalid');
  });

  it('never throws on hostile getter objects — returns invalid', () => {
    const hostile = {
      payload: {},
      get sig(): string {
        throw new Error('hostile getter');
      },
    };
    expect(verifyLicenseFile(hostile, { publicKeysPem: [pubPem] }).state).toBe('invalid');
  });

  it('accepts a license signed by key #2 of the rotation list', () => {
    const other = generateKeyPairSync('ed25519');
    const otherPub = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // makeLicense signs with privKey (pubPem's pair) — appended LAST, as rotation appends.
    const check = verifyLicenseFile(makeLicense(), { publicKeysPem: [otherPub, pubPem] });
    expect(check.state).toBe('valid');
  });

  it('fails closed: a well-signed license with an empty key list is invalid', () => {
    expect(verifyLicenseFile(makeLicense(), { publicKeysPem: [] }).state).toBe('invalid');
  });
});
