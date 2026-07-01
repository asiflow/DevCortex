// ============================================================================
// Workflow Orchestrator (§7.15) — the workflow registry.
//
// `workflowDefinitions` is the code-level catalogue of the 15 named workflows.
// Each definition declares the task types it serves, the ordered subset of the
// 13 canonical stages it runs, and an optional `minRisk` floor. The registry is
// validated at module load (analogous to the stack-pack registry): a malformed
// definition throws a DevCortexError('INTERNAL') at import time rather than
// silently shipping a broken workflow to a host agent.
//
// Additive to the frozen contract; relative imports omit extensions.
// ============================================================================

import { DevCortexError } from '../domain';
import {
  TASK_TYPES,
  WORKFLOW_IDS,
  WORKFLOW_STAGES,
  type RiskLevel,
  type TaskType,
  type WorkflowDefinition,
  type WorkflowId,
  type WorkflowStage,
} from '../domain';

// --- risk ordering (local, tokenless) ---------------------------------------

/** Total order over risk levels; higher rank = more risk. */
export const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** True when `risk` is at least as severe as `floor`. */
export function riskAtLeast(risk: RiskLevel, floor: RiskLevel): boolean {
  return RISK_RANK[risk] >= RISK_RANK[floor];
}

// --- depth scaling ----------------------------------------------------------

/**
 * The minimum run risk at which each stage actually executes. A stage that is
 * present in a workflow definition but whose floor is above the run's risk is
 * recorded as `skipped` — this is the "workflow depth depends on risk"
 * requirement (§7.15): low-risk work skips the deep analysis stages.
 *
 * `execute` is a special case (always a handoff to the host agent) handled by
 * the runner, not by this table.
 */
export const STAGE_MIN_RISK: Record<WorkflowStage, RiskLevel> = {
  classify: 'low',
  intent: 'low',
  context: 'low',
  'blast-radius': 'medium',
  'stack-pack': 'low',
  research: 'medium',
  plan: 'low',
  execute: 'low',
  verify: 'low',
  regression: 'high',
  memory: 'low',
  'ship-report': 'low',
  learn: 'low',
};

// --- canonical stage helpers ------------------------------------------------

/** Canonical position of every stage, used to enforce ordered subsets. */
const STAGE_ORDER: ReadonlyMap<WorkflowStage, number> = new Map(
  WORKFLOW_STAGES.map((stage, index) => [stage, index] as const),
);

/**
 * Stages every workflow must contain — the spine of "classify → ... → learn"
 * that gives every run an intent, a verification, a memory write, a ship
 * report, and a learning step regardless of task type.
 */
const SPINE_STAGES: readonly WorkflowStage[] = [
  'classify',
  'intent',
  'context',
  'plan',
  'execute',
  'verify',
  'memory',
  'ship-report',
  'learn',
];

/** All 13 stages in canonical order — the maximal workflow. */
const ALL_STAGES: readonly WorkflowStage[] = [...WORKFLOW_STAGES];

/** Spine + a blast-radius/regression pass (change-safety without full research). */
const CHANGE_SAFE_STAGES: readonly WorkflowStage[] = [
  'classify',
  'intent',
  'context',
  'blast-radius',
  'plan',
  'execute',
  'verify',
  'regression',
  'memory',
  'ship-report',
  'learn',
];

/** Spine + stack-pack guidance (guidance without blast-radius/regression). */
const GUIDED_STAGES: readonly WorkflowStage[] = [
  'classify',
  'intent',
  'context',
  'stack-pack',
  'plan',
  'execute',
  'verify',
  'memory',
  'ship-report',
  'learn',
];

/** Spine + stack-pack + research (best-practice lookup, no blast/regression). */
const GUIDED_RESEARCH_STAGES: readonly WorkflowStage[] = [
  'classify',
  'intent',
  'context',
  'stack-pack',
  'research',
  'plan',
  'execute',
  'verify',
  'memory',
  'ship-report',
  'learn',
];

// --- the registry -----------------------------------------------------------

const REGISTERED: readonly WorkflowDefinition[] = [
  {
    id: 'feature.build',
    name: 'Build a feature',
    taskTypes: ['feature'],
    stages: [...ALL_STAGES],
    minRisk: 'low',
  },
  {
    id: 'bug.fix',
    name: 'Fix a bug',
    taskTypes: ['bugfix'],
    stages: [...CHANGE_SAFE_STAGES],
    minRisk: 'low',
  },
  {
    id: 'ui.polish',
    name: 'Polish the UI',
    taskTypes: ['ui'],
    stages: [...GUIDED_STAGES],
    minRisk: 'low',
  },
  {
    id: 'auth.change',
    name: 'Change authentication/authorization',
    taskTypes: ['auth'],
    stages: [...ALL_STAGES],
    minRisk: 'high',
  },
  {
    id: 'billing.add',
    name: 'Add or change billing',
    taskTypes: ['billing'],
    stages: [...ALL_STAGES],
    minRisk: 'high',
  },
  {
    id: 'database.migrate',
    name: 'Migrate the database',
    taskTypes: ['database'],
    stages: [...ALL_STAGES],
    minRisk: 'high',
  },
  {
    id: 'api.integrate',
    name: 'Integrate an API',
    taskTypes: ['api'],
    stages: [...ALL_STAGES],
    minRisk: 'medium',
  },
  {
    id: 'dependency.upgrade',
    name: 'Upgrade a dependency',
    taskTypes: ['dependency'],
    stages: [...ALL_STAGES],
    minRisk: 'medium',
  },
  {
    id: 'security.patch',
    name: 'Patch a security issue',
    taskTypes: ['security'],
    stages: [...ALL_STAGES],
    minRisk: 'high',
  },
  {
    id: 'devops.fix',
    name: 'Fix a devops/infrastructure issue',
    taskTypes: ['devops'],
    stages: [...ALL_STAGES],
    minRisk: 'low',
  },
  {
    id: 'deploy.prepare',
    name: 'Prepare a deploy',
    taskTypes: ['devops', 'release'],
    stages: [...ALL_STAGES],
    minRisk: 'high',
  },
  {
    id: 'refactor.safe',
    name: 'Refactor safely',
    taskTypes: ['refactor', 'chore'],
    stages: [...ALL_STAGES],
    minRisk: 'low',
  },
  {
    id: 'test.generate',
    name: 'Generate tests',
    taskTypes: ['test'],
    stages: [...GUIDED_RESEARCH_STAGES],
    minRisk: 'low',
  },
  {
    id: 'docs.sync',
    name: 'Sync documentation',
    taskTypes: ['docs'],
    stages: [...SPINE_STAGES],
    minRisk: 'low',
  },
  {
    id: 'release.prepare',
    name: 'Prepare a release',
    taskTypes: ['release'],
    stages: [...ALL_STAGES],
    minRisk: 'medium',
  },
];

// --- load-time validation ---------------------------------------------------

const VALID_TASK_TYPES: ReadonlySet<TaskType> = new Set(TASK_TYPES);
const VALID_STAGES: ReadonlySet<WorkflowStage> = new Set(WORKFLOW_STAGES);

/**
 * Validate a single workflow definition (id, name, task types, and an ordered,
 * spine-complete stage subset). Exported so custom/user-supplied workflows can
 * be checked with the same rules the built-in registry is held to.
 *
 * @throws DevCortexError('INTERNAL') on the first structural problem found.
 */
export function assertValidWorkflowDefinition(def: WorkflowDefinition): void {
  if (!WORKFLOW_IDS.includes(def.id)) {
    throw new DevCortexError('INTERNAL', `workflow "${String(def.id)}" is not a known WorkflowId`, {
      details: { id: def.id },
    });
  }
  if (def.name.trim().length === 0) {
    throw new DevCortexError('INTERNAL', `workflow "${def.id}" has an empty name`);
  }

  // Task types: non-empty, all valid, no duplicates.
  if (def.taskTypes.length === 0) {
    throw new DevCortexError('INTERNAL', `workflow "${def.id}" declares no task types`);
  }
  const seenTypes = new Set<TaskType>();
  for (const type of def.taskTypes) {
    if (!VALID_TASK_TYPES.has(type)) {
      throw new DevCortexError('INTERNAL', `workflow "${def.id}" references unknown task type "${String(type)}"`, {
        details: { taskType: type },
      });
    }
    if (seenTypes.has(type)) {
      throw new DevCortexError('INTERNAL', `workflow "${def.id}" lists duplicate task type "${type}"`);
    }
    seenTypes.add(type);
  }

  // Stages: non-empty, all valid, no duplicates, canonical order, spine present.
  if (def.stages.length === 0) {
    throw new DevCortexError('INTERNAL', `workflow "${def.id}" declares no stages`);
  }
  const seenStages = new Set<WorkflowStage>();
  let previousOrder = -1;
  for (const stage of def.stages) {
    if (!VALID_STAGES.has(stage)) {
      throw new DevCortexError('INTERNAL', `workflow "${def.id}" references unknown stage "${String(stage)}"`, {
        details: { stage },
      });
    }
    if (seenStages.has(stage)) {
      throw new DevCortexError('INTERNAL', `workflow "${def.id}" lists duplicate stage "${stage}"`);
    }
    seenStages.add(stage);
    const order = STAGE_ORDER.get(stage) ?? -1;
    if (order <= previousOrder) {
      throw new DevCortexError('INTERNAL', `workflow "${def.id}" lists stage "${stage}" out of canonical order`, {
        details: { stage, order, previousOrder },
      });
    }
    previousOrder = order;
  }
  for (const spine of SPINE_STAGES) {
    if (!seenStages.has(spine)) {
      throw new DevCortexError('INTERNAL', `workflow "${def.id}" is missing required spine stage "${spine}"`, {
        details: { missing: spine },
      });
    }
  }
}

/**
 * Validate a whole workflow registry: correct count, unique ids covering every
 * WorkflowId, each definition individually valid, and every TaskType served by
 * at least one workflow (so {@link selectWorkflow} is total).
 *
 * @throws DevCortexError('INTERNAL') on the first structural problem found.
 */
export function validateWorkflowRegistry(defs: readonly WorkflowDefinition[]): void {
  if (defs.length !== WORKFLOW_IDS.length) {
    throw new DevCortexError(
      'INTERNAL',
      `workflow registry has ${defs.length} definitions; expected ${WORKFLOW_IDS.length}`,
      { details: { got: defs.length, expected: WORKFLOW_IDS.length } },
    );
  }

  const seenIds = new Set<WorkflowId>();
  for (const def of defs) {
    assertValidWorkflowDefinition(def);
    if (seenIds.has(def.id)) {
      throw new DevCortexError('INTERNAL', `duplicate workflow id "${def.id}" in the registry`);
    }
    seenIds.add(def.id);
  }

  // Every WorkflowId must have exactly one definition.
  for (const id of WORKFLOW_IDS) {
    if (!seenIds.has(id)) {
      throw new DevCortexError('INTERNAL', `workflow registry is missing a definition for "${id}"`);
    }
  }

  // Every TaskType must be served by at least one workflow, so `selectWorkflow`
  // is total over the task taxonomy.
  const coveredTypes = new Set<TaskType>();
  for (const def of defs) {
    for (const type of def.taskTypes) {
      coveredTypes.add(type);
    }
  }
  for (const type of TASK_TYPES) {
    if (!coveredTypes.has(type)) {
      throw new DevCortexError('INTERNAL', `no workflow serves task type "${type}"`, {
        details: { taskType: type },
      });
    }
  }
}

validateWorkflowRegistry(REGISTERED);

/** The 15 named workflows (§7.15), validated at module load. */
export const workflowDefinitions: WorkflowDefinition[] = REGISTERED.map((def) => ({
  ...def,
  taskTypes: [...def.taskTypes],
  stages: [...def.stages],
}));

/** Look up a definition by id; throws when the id is unknown. */
export function getWorkflowDefinition(id: WorkflowId): WorkflowDefinition {
  const def = workflowDefinitions.find((candidate) => candidate.id === id);
  if (def === undefined) {
    throw new DevCortexError('INTERNAL', `unknown workflow id "${String(id)}"`, { details: { id } });
  }
  return def;
}
