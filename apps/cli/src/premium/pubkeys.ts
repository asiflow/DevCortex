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
  // !!! DEV/STAGING KEY — NOT THE PRODUCTION KEY. DO NOT SHIP GA WITH THIS. !!!
  //
  // This keypair was generated 2026-07-02 solely to prove the issue → activate
  // → install → status path end-to-end (devcortex-cloud docs/premium-e2e.md).
  // Its PRIVATE half lives only in a local gitignored .env.local and is
  // treated as burned.
  //
  // BEFORE THE GA / 0.3.0 PUBLISH the release operator MUST:
  //   1. Run `node scripts/license-keygen.mjs` in devcortex-cloud (the private
  //      half goes ONLY into the deployment env, e.g. Vercel LICENSE_SIGNING_KEY
  //      — never into any repo, transcript, or chat).
  //   2. APPEND the new production public PEM below this entry as
  //      `// prod key v1 (issued 2026-07; rotation appends, never replaces)`.
  //   3. REMOVE this dev/staging entry in the same commit (removing a dev key
  //      is the one sanctioned "replace"; production rotation only ever appends).
  // Full ceremony: devcortex-cloud docs/premium-e2e.md § "Production key ceremony".
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASZYYOtDRZO8R6OZFHRS54OH5VFyC0pCWK3AuNhEuVgw=
-----END PUBLIC KEY-----
`,
];
