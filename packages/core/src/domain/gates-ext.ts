// ============================================================================
// Sub-project #4 domain contract — Deep quality gates (§7.12-7.13 + §7.21).
//
// Extends the frozen gate contract in ./types (GateResult / CheckResult /
// EvidenceItem) with an additive gate-FAMILY taxonomy and the UI-quality score
// produced by the deep, tokenless UI gate. Like RiskClassification / BlastRadius
// in ./types and CouncilReport in ./council, `UiQualityScore` is a COMPUTED
// artifact — the engine derives it on demand from the ProjectGraph and real file
// reads and never persists it — so it is types-only with no zod validator.
//
// Additive to the frozen contract in ./types + ./schemas; those files are
// untouched.
// ============================================================================

// --- gate families ----------------------------------------------------------

/**
 * The families a deep quality gate can belong to. `code` is the existing
 * general-purpose gate (typecheck/lint/build/test + route/env checks); the
 * remainder are the deep, domain-specific gates added by sub-project #4.
 * `premium-ui` is the highest-bar visual gate (§7.13) layered above `ui`.
 */
export const GATE_FAMILIES = ['code', 'ui', 'security', 'devops', 'product', 'premium-ui'] as const;
export type GateFamily = (typeof GATE_FAMILIES)[number];

// --- UI quality score (computed artifact, §7.13) ----------------------------

/**
 * The scored output of the deep UI / premium-UI gate. Every dimension is a
 * heuristic score in the inclusive range 0-100 (higher is better), derived
 * deterministically from the graph + real file reads with no LLM. `overall` is
 * the aggregate the gate ranks against its threshold; `topFixes` are the
 * highest-leverage, human-readable improvements ordered most-impactful-first.
 */
export interface UiQualityScore {
  /** clarity of layout order, heading levels, and focal emphasis (0-100) */
  visualHierarchy: number;
  /** presence and correctness of responsive/mobile handling (0-100) */
  mobileResponsiveness: number;
  /** consistency of spacing/rhythm tokens across the surface (0-100) */
  spacingConsistency: number;
  /** semantic markup, labels, contrast, and a11y affordances (0-100) */
  accessibility: number;
  /** polish signals that separate premium from generic UI (0-100) */
  premiumFeel: number;
  /** aggregate score the gate compares against its threshold (0-100) */
  overall: number;
  /** highest-leverage fixes, ordered most-impactful-first */
  topFixes: string[];
}
