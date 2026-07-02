// ============================================================================
// Embedded DevCortex Premium verification keys — PUBLIC keys only.
//
// Public keys are safe (and intentionally visible) in open-source code: they
// are the trust bootstrap for offline license verification. No private key
// material is ever committed to this repository.
//
// The production key PEM is pasted here once the cloud side generates it.
// ROTATION = APPEND, never replace: old keys are RETAINED so licenses signed
// by prior keys keep verifying; `verifyLicenseFile` tries each key in order.
// ============================================================================

export const PREMIUM_PUBKEYS: readonly string[] = [];
