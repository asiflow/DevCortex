/**
 * Risk → context-depth mapping.
 *
 * Encodes the risk-based-depth philosophy: low-risk work stays light (tiny
 * context), medium work gets a standard pack, and anything high or critical
 * earns a deep analysis pass.
 */
import type { ContextDepth, RiskLevel } from '../domain/index';
import { DevCortexError } from '../domain/index';

/**
 * Maps a classified risk level to the context depth the compilers should use.
 * low → tiny, medium → standard, high/critical → deep.
 */
export function depthForRisk(risk: RiskLevel): ContextDepth {
  switch (risk) {
    case 'low':
      return 'tiny';
    case 'medium':
      return 'standard';
    case 'high':
      return 'deep';
    case 'critical':
      return 'deep';
    default: {
      const exhaustive: never = risk;
      throw new DevCortexError('INTERNAL', `Unhandled risk level: ${String(exhaustive)}`);
    }
  }
}
