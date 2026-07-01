/**
 * Internal risk-level ordering utilities.
 *
 * `RiskLevel` is an ordered scale (low < medium < high < critical). Several
 * policy operations — escalation, floor enforcement, mode gating — need to
 * compare two levels. Centralising the ordering here keeps that comparison in
 * one place and impossible to get wrong via ad-hoc string checks.
 *
 * Not part of the public `policy/` surface (not re-exported from index.ts).
 */
import type { RiskLevel } from '../domain/index';

/** Monotonic rank for each risk level; higher means more dangerous. */
export const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Returns whichever of the two levels is more severe. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}
