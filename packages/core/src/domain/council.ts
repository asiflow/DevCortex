// ============================================================================
// Sub-project #2 domain contract — Senior Engineer Council (§7.14).
//
// A practical mixture-of-experts review layer: a set of reviewer "lenses" that
// produce short, actionable, evidence-linked findings, invoked based on task
// risk rather than by default. A `CouncilReport` is a COMPUTED artifact (the
// engine derives it on demand from the graph, blast radius, and stack packs),
// so — like RiskClassification / BlastRadius in ./types — it is types-only with
// no persisted zod validator.
//
// Additive to the frozen contract in ./types + ./schemas.
// ============================================================================

import type { RiskLevel } from './types';

// --- enums ------------------------------------------------------------------

/** The reviewer perspectives the council can convene (§7.14). */
export const REVIEWER_LENSES = [
  'architect',
  'security',
  'frontend',
  'ui-ux',
  'qa',
  'devops',
  'performance',
  'product',
  'documentation',
] as const;
export type ReviewerLens = (typeof REVIEWER_LENSES)[number];

// --- interfaces -------------------------------------------------------------

/** One actionable finding from a single reviewer lens. */
export interface CouncilFinding {
  lens: ReviewerLens;
  severity: RiskLevel;
  title: string;
  detail: string;
  /** repo-relative path the finding concerns, when file-scoped */
  file?: string;
}

/** The consolidated output of a council review for one task. */
export interface CouncilReport {
  task: string;
  /** which lenses were convened (risk-scaled subset of REVIEWER_LENSES) */
  lenses: ReviewerLens[];
  findings: CouncilFinding[];
  generatedAt: string;
}
