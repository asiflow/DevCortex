// ============================================================================
// Sub-project #2 domain contract — Workflow Orchestrator (§7.15).
//
// A workflow is a risk-scaled sequence of stages for a common agentic task. The
// definitions (`WorkflowDefinition`) are code-level and computed; a
// `WorkflowRun` is the PERSISTED record of one execution, stored under
// `.cortex/workflows/` (alongside the flight recorder's `.cortex/runs/`). Only
// the persisted `WorkflowRun` carries a zod validator + drift guard.
//
// Additive to the frozen contract in ./types + ./schemas. Convention: relative
// imports omit extensions; unions are `as const` string arrays.
// ============================================================================

import { z } from 'zod';

import type { RiskLevel, TaskType } from './types';
import { RiskLevelSchema } from './schemas';

// --- enums ------------------------------------------------------------------

/** Canonical ordered stages of a workflow (§7.15 "Each workflow should include stages"). */
export const WORKFLOW_STAGES = [
  'classify',
  'intent',
  'context',
  'blast-radius',
  'stack-pack',
  'research',
  'plan',
  'execute',
  'verify',
  'regression',
  'memory',
  'ship-report',
  'learn',
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/** Named workflows for common agentic development tasks (§7.15). */
export const WORKFLOW_IDS = [
  'feature.build',
  'bug.fix',
  'ui.polish',
  'auth.change',
  'billing.add',
  'database.migrate',
  'api.integrate',
  'dependency.upgrade',
  'security.patch',
  'devops.fix',
  'deploy.prepare',
  'refactor.safe',
  'test.generate',
  'docs.sync',
  'release.prepare',
] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

/** Per-stage execution status. */
export const STAGE_STATUSES = ['ok', 'skipped', 'failed'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** Terminal status of a whole workflow run. */
export const WORKFLOW_RUN_STATUSES = ['completed', 'blocked', 'failed'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

// --- interfaces -------------------------------------------------------------

/**
 * Code-level definition of a workflow: which task types it serves, which stages
 * it runs, and an optional minimum risk floor below which it need not fire.
 * Not persisted, so no zod schema.
 */
export interface WorkflowDefinition {
  id: WorkflowId;
  name: string;
  taskTypes: TaskType[];
  stages: WorkflowStage[];
  minRisk?: RiskLevel;
}

/** Outcome of a single stage within a run, with links to supporting evidence. */
export interface StageOutcome {
  stage: WorkflowStage;
  status: StageStatus;
  detail: string;
  evidenceIds: string[];
}

/** Persisted record of one workflow execution (under `.cortex/workflows/`). */
export interface WorkflowRun {
  id: string;
  workflowId: WorkflowId;
  task: string;
  riskLevel: RiskLevel;
  startedAt: string;
  finishedAt?: string;
  status: WorkflowRunStatus;
  stages: StageOutcome[];
}

// --- schemas (disk boundary) ------------------------------------------------

export const WorkflowStageSchema = z.enum(WORKFLOW_STAGES);
export const WorkflowIdSchema = z.enum(WORKFLOW_IDS);
export const StageStatusSchema = z.enum(STAGE_STATUSES);
export const WorkflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);

export const StageOutcomeSchema = z.object({
  stage: WorkflowStageSchema,
  status: StageStatusSchema,
  detail: z.string(),
  evidenceIds: z.array(z.string()),
});

export const WorkflowRunSchema = z.object({
  id: z.string(),
  workflowId: WorkflowIdSchema,
  task: z.string(),
  riskLevel: RiskLevelSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: WorkflowRunStatusSchema,
  stages: z.array(StageOutcomeSchema),
});

// --- compile-time drift guard -----------------------------------------------

type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : false) : false;

function assertMatch<_T extends true>(): void {
  /* compile-time only */
}

assertMatch<MutuallyAssignable<z.infer<typeof StageOutcomeSchema>, StageOutcome>>();
assertMatch<MutuallyAssignable<z.infer<typeof WorkflowRunSchema>, WorkflowRun>>();
