/**
 * Workflow Orchestrator (§7.15) — structured, risk-scaled workflows for common
 * agentic development tasks. Deterministic and tokenless (the OSS layer): the
 * runner sequences the policy / compiler / blast-radius / stack-pack / gate /
 * ledger engines, scales depth by risk (low risk skips the deep stages), and
 * persists a `WorkflowRun` under `.cortex/workflows/`.
 *
 * Public API:
 *   workflowDefinitions: WorkflowDefinition[]        — the 15 named workflows
 *   selectWorkflow(taskType, risk): WorkflowDefinition
 *   runWorkflow(root, workflowId, task, deps): Promise<WorkflowRun>
 *   listWorkflowRuns(root): Promise<WorkflowRun[]>
 *   loadWorkflowRun(root, runId): Promise<WorkflowRun>
 */
export {
  workflowDefinitions,
  getWorkflowDefinition,
  assertValidWorkflowDefinition,
  validateWorkflowRegistry,
  STAGE_MIN_RISK,
  RISK_RANK,
  riskAtLeast,
} from './definitions';
export { selectWorkflow, orderCandidatesByRisk } from './select';
export { runWorkflow, listWorkflowRuns, loadWorkflowRun } from './run';
export type { WorkflowDeps, WorkflowLedgers } from './run';
