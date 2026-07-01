// ============================================================================
// Workflow selection (§7.15).
//
// `selectWorkflow` maps a (taskType, risk) pair to exactly one workflow,
// deterministically. The registry is validated at load to cover every task
// type, so selection is total. When several workflows serve the same task type
// (e.g. `devops.fix` and `deploy.prepare` both serve `devops`), the tie is
// broken by risk fit — see `orderCandidatesByRisk`:
//   - Among workflows whose `minRisk` floor the run satisfies, prefer the one
//     with the HIGHEST floor (the most risk-specific workflow), then the most
//     specific (fewest task types), then registry order.
//   - If the run's risk is below every candidate's floor, fall back to the
//     candidate with the LOWEST floor (the nearest reachable workflow).
// ============================================================================

import { DevCortexError } from '../domain';
import { RISK_LEVELS, TASK_TYPES, WORKFLOW_IDS, type RiskLevel, type TaskType, type WorkflowDefinition } from '../domain';

import { RISK_RANK, riskAtLeast, workflowDefinitions } from './definitions';

/** Registry position of each workflow id, for a stable final tie-break. */
const ID_INDEX: ReadonlyMap<string, number> = new Map(WORKFLOW_IDS.map((id, index) => [id, index] as const));

function floorRank(def: WorkflowDefinition): number {
  return RISK_RANK[def.minRisk ?? 'low'];
}

function idIndex(def: WorkflowDefinition): number {
  return ID_INDEX.get(def.id) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Order candidate workflows by fitness for `risk`, best first. Candidates whose
 * `minRisk` floor the run satisfies come first, ordered by highest floor, then
 * fewest task types (most specific), then registry order. If NO candidate's
 * floor is satisfied, the whole list is ordered by lowest floor first (the
 * nearest reachable workflow) using the same secondary/tertiary tie-breaks.
 *
 * Pure and deterministic — exported so a surface can explain "why this
 * workflow" and so the tie-breaking is independently testable.
 */
export function orderCandidatesByRisk(
  candidates: readonly WorkflowDefinition[],
  risk: RiskLevel,
): WorkflowDefinition[] {
  const applicable = candidates.filter((def) => riskAtLeast(risk, def.minRisk ?? 'low'));

  if (applicable.length > 0) {
    return [...applicable].sort(
      (a, b) =>
        floorRank(b) - floorRank(a) ||
        a.taskTypes.length - b.taskTypes.length ||
        idIndex(a) - idIndex(b),
    );
  }

  return [...candidates].sort(
    (a, b) =>
      floorRank(a) - floorRank(b) ||
      a.taskTypes.length - b.taskTypes.length ||
      idIndex(a) - idIndex(b),
  );
}

/**
 * Select the workflow that best serves `taskType` at the given `risk`.
 *
 * @throws DevCortexError('INTERNAL') when `taskType`/`risk` are not valid enum
 *   members, or (defensively) when the registry serves no workflow for the type
 *   — the latter is unreachable given load-time coverage validation.
 */
export function selectWorkflow(taskType: TaskType, risk: RiskLevel): WorkflowDefinition {
  if (!TASK_TYPES.includes(taskType)) {
    throw new DevCortexError('INTERNAL', `selectWorkflow: unknown task type "${String(taskType)}"`, {
      details: { taskType },
    });
  }
  if (!RISK_LEVELS.includes(risk)) {
    throw new DevCortexError('INTERNAL', `selectWorkflow: unknown risk level "${String(risk)}"`, {
      details: { risk },
    });
  }

  const candidates = workflowDefinitions.filter((def) => def.taskTypes.includes(taskType));
  if (candidates.length === 0) {
    // Unreachable given registry coverage validation, but never fail silently.
    throw new DevCortexError('INTERNAL', `no workflow serves task type "${taskType}"`, {
      details: { taskType },
    });
  }

  const ordered = orderCandidatesByRisk(candidates, risk);
  const best = ordered[0];
  if (best === undefined) {
    throw new DevCortexError('INTERNAL', `no workflow serves task type "${taskType}"`, {
      details: { taskType },
    });
  }
  return best;
}
