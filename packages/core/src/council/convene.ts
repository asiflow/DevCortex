/**
 * convene — deterministic, risk-triggered reviewer selection (§7.14).
 *
 * The Senior Engineer Council is a *mixture of reviewers* that must not create
 * noisy debates by default. `convene` decides which reviewer lenses fire for a
 * given task, using two purely deterministic inputs:
 *
 *   1. a BASE lens set keyed by task type — the perspectives intrinsically
 *      relevant to that kind of change (e.g. `billing` always wants architect +
 *      security + devops + qa, matching the design's worked example), and
 *   2. a RISK ESCALATION set — cross-cutting lenses that switch on as risk
 *      rises, so a low-risk chore convenes almost no one while a critical change
 *      draws a broad review regardless of its nominal type (§7.14/§7.16: depth
 *      depends on risk).
 *
 * The result is deduped and returned in canonical `REVIEWER_LENSES` order so the
 * output is stable and testable. Tokenless and side-effect-free.
 */

import type { ReviewerLens, RiskLevel, TaskType } from '../domain/index';
import { REVIEWER_LENSES, RISK_LEVELS, TASK_TYPES, DevCortexError } from '../domain/index';

/** Canonical position of each lens, used to produce a stable output order. */
const LENS_ORDER: ReadonlyMap<ReviewerLens, number> = new Map(
  REVIEWER_LENSES.map((lens, index) => [lens, index]),
);

/**
 * Base reviewer set per task type — the lenses always worth convening for that
 * kind of change even at low risk. `chore` intentionally convenes no one.
 */
const BASE_LENSES: Record<TaskType, ReviewerLens[]> = {
  feature: ['architect', 'qa'],
  bugfix: ['qa'],
  ui: ['ui-ux', 'frontend'],
  auth: ['security', 'architect', 'qa'],
  billing: ['architect', 'security', 'devops', 'qa'],
  database: ['architect', 'devops', 'qa'],
  api: ['architect', 'security', 'qa'],
  dependency: ['security', 'devops'],
  security: ['security', 'architect'],
  devops: ['devops'],
  refactor: ['architect', 'qa'],
  test: ['qa'],
  docs: ['documentation'],
  release: ['devops', 'qa', 'documentation'],
  chore: [],
};

/**
 * Cross-cutting lenses that switch on as risk rises. Additive to the base set:
 * the higher the risk, the broader the review, independent of task type.
 */
const RISK_ESCALATION: Record<RiskLevel, ReviewerLens[]> = {
  low: [],
  medium: ['qa'],
  high: ['qa', 'security', 'devops'],
  critical: ['qa', 'security', 'devops', 'architect', 'documentation'],
};

/**
 * Dedupe a lens list and return it in canonical `REVIEWER_LENSES` order.
 * Unknown values (defensive against non-TS callers) sort first but are otherwise
 * preserved so nothing is silently dropped.
 */
export function canonicalizeLenses(lenses: readonly ReviewerLens[]): ReviewerLens[] {
  return [...new Set(lenses)].sort(
    (a, b) => (LENS_ORDER.get(a) ?? -1) - (LENS_ORDER.get(b) ?? -1),
  );
}

/**
 * Decide which reviewer lenses fire for a task of the given type and risk.
 *
 * @example convene('billing', 'low')  -> ['architect', 'security', 'qa', 'devops']
 * @example convene('ui', 'low')       -> ['ui-ux', 'frontend']
 * @example convene('chore', 'low')    -> []
 *
 * @throws DevCortexError('INTERNAL') when `taskType` or `risk` is not a member of
 *   the domain enums (guards JS callers that violate the static contract).
 */
export function convene(taskType: TaskType, risk: RiskLevel): ReviewerLens[] {
  if (!(TASK_TYPES as readonly string[]).includes(taskType)) {
    throw new DevCortexError('INTERNAL', `convene: unknown task type "${String(taskType)}"`);
  }
  if (!(RISK_LEVELS as readonly string[]).includes(risk)) {
    throw new DevCortexError('INTERNAL', `convene: unknown risk level "${String(risk)}"`);
  }
  return canonicalizeLenses([...BASE_LENSES[taskType], ...RISK_ESCALATION[risk]]);
}
