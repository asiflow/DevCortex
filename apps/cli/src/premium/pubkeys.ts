// ============================================================================
// Embedded DevCortex Premium verification keys — PUBLIC keys only.
//
// Public keys are safe (and intentionally visible) in open-source code: they
// are the trust bootstrap for offline license verification. No private key
// material is ever committed to this repository.
//
// ROTATION = APPEND, never replace: old keys are RETAINED so licenses signed
// by prior keys keep verifying; `verifyLicenseFile` tries each key in order.
// ============================================================================

export const PREMIUM_PUBKEYS: readonly string[] = [
  // prod key v1 (promoted 2026-07 per operator decision from the keypair first
  // generated for the end-to-end proof in devcortex-cloud docs/premium-e2e.md;
  // rotation APPENDS below this entry, never replaces). Its PRIVATE half is held
  // only in the deployment environment (Vercel `LICENSE_SIGNING_KEY`) and the
  // operator's local gitignored .env.local — never committed to any repo.
  //
  // Provenance note: this key's private half existed in a local file during the
  // build session. Acceptable for a soft launch; to harden later, generate a
  // fresh key with `node scripts/license-keygen.mjs`, APPEND its public PEM
  // below (rotation), and cut over signing in the deployment env — old licenses
  // keep verifying because verifyLicenseFile tries every key in this array.
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASZYYOtDRZO8R6OZFHRS54OH5VFyC0pCWK3AuNhEuVgw=
-----END PUBLIC KEY-----
`,
];
