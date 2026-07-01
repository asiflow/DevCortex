/**
 * Self Meta-Cognitive Learning Engine (§7.17) — observe repeated failures,
 * diagnose their root cause, and emit durable, editable, evidence-based
 * remedies. Deterministic and tokenless (the OSS layer).
 *
 * Public API:
 *   analyzeFailures(root, options?): Promise<LearnedFailure[]>
 *     scan the evidence ledger + flight recorder for REPEATED failure
 *     signatures, cluster by signature, and count occurrences.
 *   diagnose(failure): FailureDiagnosis
 *     deterministic root-cause category for a learned failure's signature.
 *   learn(root, failure, deps?): Promise<{ created: string[] }>
 *     persist the failure under `.cortex/known-failures/` and create its remedy
 *     (regression note, generated skill, or risk/pattern memory item).
 *   knownFailures(root): Promise<LearnedFailure[]>
 *     all persisted learned failures, most-recurring first.
 */
export { analyzeFailures } from './analyze';
export type { AnalyzeOptions } from './analyze';

export { diagnose, remedyForCategory } from './diagnose';

export { learn } from './learn';
export type { LearnDeps, LearnResult } from './learn';

export { knownFailures, KnownFailureStore, knownFailuresDir, knownFailureFile } from './known-failure-store';

export { evidenceSignature, failureId, signatureTokens } from './signature';
