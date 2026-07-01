// ============================================================================
// Sub-project #2 domain contract — Self Meta-Cognitive Learning Engine (§7.17).
//
// The learning engine observes repeated failures, diagnoses their root cause,
// and emits a remedy (a rule, skill, known-failure, regression-check, workflow,
// or stack-pack update). A `LearnedFailure` is the PERSISTED record of one such
// recurring pattern, stored at `.cortex/known-failures/<id>.json`, so it carries
// a zod validator + drift guard. All learning must be transparent, editable,
// and evidence-based.
//
// Additive to the frozen contract in ./types + ./schemas.
// ============================================================================

import { z } from 'zod';

// --- enums ------------------------------------------------------------------

/** Kinds of remedy the learning engine can create or update in response to a failure (§7.17). */
export const LEARNING_REMEDIES = [
  'rule',
  'skill',
  'known-failure',
  'regression-check',
  'workflow',
  'stack-pack',
] as const;
export type LearningRemedy = (typeof LEARNING_REMEDIES)[number];

/** Diagnosed root-cause category for a recurring failure (§7.17 "Then it should diagnose"). */
export const FAILURE_CATEGORIES = [
  'missing-context',
  'missing-skill',
  'outdated-docs',
  'wrong-package',
  'bad-rule',
  'missing-test',
  'weak-agent',
  'missing-mcp',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

// --- interfaces -------------------------------------------------------------

/** Root-cause diagnosis for an observed failure signature. */
export interface FailureDiagnosis {
  cause: string;
  category: FailureCategory;
}

/** Persisted recurring-failure record — `.cortex/known-failures/<id>.json`. */
export interface LearnedFailure {
  id: string;
  /** stable, matchable signature of the failure (e.g. normalized error text) */
  signature: string;
  /** how many times this pattern has been observed */
  occurrences: number;
  diagnosis: FailureDiagnosis;
  remedyKind: LearningRemedy;
  /** id/path of the concrete remedy artifact the engine created or updated */
  remedyRef?: string;
  createdAt: string;
  updatedAt: string;
}

// --- schemas (disk boundary) ------------------------------------------------

export const LearningRemedySchema = z.enum(LEARNING_REMEDIES);
export const FailureCategorySchema = z.enum(FAILURE_CATEGORIES);

export const FailureDiagnosisSchema = z.object({
  cause: z.string(),
  category: FailureCategorySchema,
});

export const LearnedFailureSchema = z.object({
  id: z.string(),
  signature: z.string(),
  occurrences: z.number().int().nonnegative(),
  diagnosis: FailureDiagnosisSchema,
  remedyKind: LearningRemedySchema,
  remedyRef: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// --- compile-time drift guard -----------------------------------------------

type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : false) : false;

function assertMatch<_T extends true>(): void {
  /* compile-time only */
}

assertMatch<MutuallyAssignable<z.infer<typeof FailureDiagnosisSchema>, FailureDiagnosis>>();
assertMatch<MutuallyAssignable<z.infer<typeof LearnedFailureSchema>, LearnedFailure>>();
