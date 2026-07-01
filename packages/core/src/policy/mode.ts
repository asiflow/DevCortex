/**
 * Operating-mode gating.
 *
 * Whether DevCortex should *block* an action is a function of the operating mode
 * and the action's risk. "Passive first" is the governing principle: the default
 * mode never blocks. Guarded mode blocks genuinely dangerous work; autopilot
 * blocks only the most catastrophic.
 */
import type { OperatingMode, RiskLevel } from '../domain/index';
import { DevCortexError } from '../domain/index';
import { RISK_RANK } from './risk-order';

/**
 * Returns true when an action at the given risk should be blocked in the given
 * mode.
 * - passive: never blocks (observe/record/suggest only).
 * - guarded: blocks high and critical.
 * - autopilot: blocks only critical.
 */
export function shouldBlock(mode: OperatingMode, risk: RiskLevel): boolean {
  switch (mode) {
    case 'passive':
      return false;
    case 'guarded':
      return RISK_RANK[risk] >= RISK_RANK.high;
    case 'autopilot':
      return RISK_RANK[risk] >= RISK_RANK.critical;
    default: {
      const exhaustive: never = mode;
      throw new DevCortexError('INTERNAL', `Unhandled operating mode: ${String(exhaustive)}`);
    }
  }
}
