// ============================================================================
// Sub-project #5 domain contract — Privacy & Redaction Engine (§7.22).
//
// Defines what the redaction engine detects and the shape of an outbound
// disclosure the privacy layer must show before anything leaves the machine.
//
// Both `RedactionResult` and `OutboundManifest` are COMPUTED artifacts — the
// engine derives them on demand (from a text buffer, and from the candidate
// file set + active privacy mode respectively) and never persists them — so,
// like RiskClassification / BlastRadius in ./types and CouncilReport in
// ./council, this file is types-only with no zod validator.
//
// Additive to the frozen contract in ./types + ./schemas; those files are
// untouched. Convention: relative imports omit extensions; unions are declared
// as `as const` string tuples; interfaces own object shapes.
// ============================================================================

import type { PrivacyMode } from './types';

// --- enums ------------------------------------------------------------------

/**
 * The classes of sensitive material the redaction engine detects and masks
 * before any outbound transmission (mirrors the §7.22 automatic-redaction list:
 * API keys, secrets, tokens, private keys, env files, passwords, PII,
 * credentials, database URLs).
 */
export const REDACTION_KINDS = [
  'api-key',
  'secret',
  'token',
  'private-key',
  'password',
  'env',
  'db-url',
  'pii-email',
  'pii-phone',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

// --- interfaces -------------------------------------------------------------

/** How many matches of one redaction kind were found and masked in a buffer. */
export interface RedactionFinding {
  kind: RedactionKind;
  /** number of masked occurrences of this kind (>= 1 when reported) */
  count: number;
}

/** The result of running the redaction engine over a text buffer. */
export interface RedactionResult {
  /** the input with every detected secret/PII occurrence masked */
  redacted: string;
  /** per-kind tally of what was masked; empty when nothing matched */
  findings: RedactionFinding[];
}

/** One file proposed for outbound transmission, with its justification. */
export interface OutboundFile {
  /** repo-relative POSIX path */
  path: string;
  /** why this file is needed for the requested cloud operation */
  reason: string;
  sizeBytes: number;
  /** true when the file's contents were run through the redaction engine */
  redacted: boolean;
}

/**
 * The disclosure shown before anything is sent to the cloud brain (§7.22):
 * which files, why, how large, the retention policy, and the opt-out flag —
 * scoped to the active privacy mode. In `local-only` mode this manifest must
 * be empty; `deep-cloud` is the only mode permitting file contents outbound.
 */
export interface OutboundManifest {
  mode: PrivacyMode;
  files: OutboundFile[];
  /** sum of `files[].sizeBytes`; the token/size estimate surfaced to the user */
  totalBytes: number;
  /** human-readable retention setting, e.g. `ephemeral`, `30d`, `none` */
  retention: string;
  /** true when the user has opted out of cloud transmission entirely */
  optOut: boolean;
}
