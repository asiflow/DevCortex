// ============================================================================
// Workflow Orchestrator (§7.15) — deterministic execution engine.
//
// `runWorkflow` executes a workflow's ordered stages against the project graph
// and ledgers, scaling depth by risk (low risk skips the deep analysis stages),
// and persists a `WorkflowRun` under `.cortex/workflows/<id>.json`.
//
// Everything here is deterministic and tokenless (the OSS layer): no LLM calls,
// no network. Real work is delegated to the sibling engines (policy, compilers,
// blast-radius, stackpacks, gates, ledgers); this module sequences them and
// records the outcome. The `execute` stage is a NO-OP handoff — the host agent
// performs edits; DevCortex records evidence for what results.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Dirent } from 'node:fs';

import { DevCortexError, SchemaValidationError, WorkflowRunSchema } from '../domain';
import type {
  BlastRadius,
  ContextPack,
  CortexConfig,
  EvidenceItem,
  EvidenceRef,
  IntentContract,
  ProjectGraph,
  RiskClassification,
  RiskLevel,
  ShipReport,
  StackPack,
  StageOutcome,
  WorkflowId,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStage,
} from '../domain';
import { analyzeBlastRadius } from '../blast-radius';
import { compileContext, compileIntent } from '../compilers';
import { generateShipReport, runQualityGate } from '../gates';
import type { DecisionLedger, EvidenceLedger, FeatureLedger, MemoryLedger } from '../ledgers';
import { classifyRisk, depthForRisk } from '../policy';
import { matchPacks } from '../stackpacks';
import { workspacePaths } from '../workspace';

import { RISK_RANK, STAGE_MIN_RISK, getWorkflowDefinition } from './definitions';

// --- public types -----------------------------------------------------------

/** The four ledgers a workflow run reads from and writes to. */
export interface WorkflowLedgers {
  memory: MemoryLedger;
  feature: FeatureLedger;
  decision: DecisionLedger;
  evidence: EvidenceLedger;
}

/** Everything `runWorkflow` needs beyond the repo root, task, and workflow id. */
export interface WorkflowDeps {
  graph: ProjectGraph;
  config: CortexConfig;
  ledgers: WorkflowLedgers;
}

// --- on-disk layout ---------------------------------------------------------

/** `.cortex/workflows` — runs live here, one `<id>.json` per execution. */
function workflowsDir(root: string): string {
  return path.join(workspacePaths(root).cortexDir, 'workflows');
}

/** Prefix every persisted workflow run id carries. */
const RUN_ID_PREFIX = 'wf-';

// --- mutable per-run state --------------------------------------------------

interface RunState {
  intent?: IntentContract;
  contextPack?: ContextPack;
  blast?: BlastRadius;
  gateEvidence: EvidenceItem[];
  gatePassed?: boolean;
  memoryItemId?: string;
  shipReport?: ShipReport;
}

// --- public API -------------------------------------------------------------

/**
 * Execute a workflow deterministically and persist the resulting
 * {@link WorkflowRun}. Stage-level errors are captured into the run (status
 * `failed`) rather than thrown; only invalid inputs throw before execution
 * begins.
 *
 * @throws SchemaValidationError when `root`/`task`/`deps` are structurally
 *   invalid.
 * @throws DevCortexError('INTERNAL') when `workflowId` is unknown.
 */
export async function runWorkflow(
  root: string,
  workflowId: WorkflowId,
  task: string,
  deps: WorkflowDeps,
): Promise<WorkflowRun> {
  assertRoot(root);
  assertTask(task);
  assertDeps(deps);
  const def = getWorkflowDefinition(workflowId);

  const { graph, config, ledgers } = deps;
  const startedAt = new Date().toISOString();
  const runId = buildRunId(startedAt);

  const outcomes: StageOutcome[] = [];
  const blockedReasons: string[] = [];
  const state: RunState = { gateEvidence: [] };
  let fatal = false;

  // Classification is foundational: it drives task type, risk, and therefore the
  // depth scaling of every later stage. A failure here fails the run outright.
  let classification: RiskClassification;
  try {
    classification = classifyRisk(task, graph, config);
  } catch (err) {
    outcomes.push({
      stage: 'classify',
      status: 'failed',
      detail: `stage threw: ${errorMessage(err)}`,
      evidenceIds: [],
    });
    return persistRun(root, {
      id: runId,
      workflowId: def.id,
      task,
      riskLevel: 'low',
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'failed',
      stages: outcomes,
    });
  }

  const risk = classification.riskLevel;
  const depth = depthForRisk(risk);

  // Stack packs are matched once (deterministic) and memoized; failure surfaces
  // at whichever stage first needs them (intent / stack-pack / research).
  let packsCache: StackPack[] | undefined;
  const getPacks = (): StackPack[] => {
    if (packsCache === undefined) {
      packsCache = matchPacks(graph.stack);
    }
    return packsCache;
  };

  for (const stage of def.stages) {
    if (fatal) break;

    // Risk-based depth scaling: a stage whose floor exceeds the run's risk is
    // skipped. `execute` is exempt — it is always a handoff, handled below.
    if (stage !== 'execute' && aboveRisk(stage, risk)) {
      outcomes.push({
        stage,
        status: 'skipped',
        detail: `skipped at ${risk} risk (stage floor: ${STAGE_MIN_RISK[stage]})`,
        evidenceIds: [],
      });
      continue;
    }

    try {
      const outcome = await runStage(stage, {
        root,
        def,
        task,
        graph,
        config,
        ledgers,
        risk,
        depth,
        classification,
        getPacks,
        state,
        blockedReasons,
        priorOutcomes: outcomes,
      });
      outcomes.push(outcome);
    } catch (err) {
      fatal = true;
      outcomes.push({
        stage,
        status: 'failed',
        detail: `stage threw: ${errorMessage(err)}`,
        evidenceIds: [],
      });
    }
  }

  const status: WorkflowRunStatus = fatal
    ? 'failed'
    : blockedReasons.length > 0
      ? 'blocked'
      : 'completed';

  return persistRun(root, {
    id: runId,
    workflowId: def.id,
    task,
    riskLevel: risk,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    stages: outcomes,
  });
}

/** All persisted workflow runs, sorted by `startedAt` then id ascending. */
export async function listWorkflowRuns(root: string): Promise<WorkflowRun[]> {
  assertRoot(root);
  const dir = workflowsDir(root);

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    throw new DevCortexError('INTERNAL', `Unable to list workflow runs in ${dir}.`, { cause: err });
  }

  const runs: WorkflowRun[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(RUN_ID_PREFIX) || !entry.name.endsWith('.json')) {
      continue;
    }
    const file = path.join(dir, entry.name);
    const raw = await readFile(file, 'utf8');
    runs.push(parseRun(raw, file));
  }

  runs.sort(compareByStartedThenId);
  return runs;
}

/** Load a single workflow run by id. Throws when it does not exist. */
export async function loadWorkflowRun(root: string, runId: string): Promise<WorkflowRun> {
  assertRoot(root);
  const file = runFile(root, runId);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      throw new SchemaValidationError(`No workflow run exists with id "${runId}".`);
    }
    throw new DevCortexError('INTERNAL', `Unable to read workflow run at ${file}.`, { cause: err });
  }
  return parseRun(raw, file);
}

// --- stage execution --------------------------------------------------------

interface StageContext {
  root: string;
  def: ReturnType<typeof getWorkflowDefinition>;
  task: string;
  graph: ProjectGraph;
  config: CortexConfig;
  ledgers: WorkflowLedgers;
  risk: RiskLevel;
  depth: ReturnType<typeof depthForRisk>;
  classification: RiskClassification;
  getPacks: () => StackPack[];
  state: RunState;
  blockedReasons: string[];
  priorOutcomes: StageOutcome[];
}

async function runStage(stage: WorkflowStage, ctx: StageContext): Promise<StageOutcome> {
  switch (stage) {
    case 'classify':
      return stageClassify(ctx);
    case 'intent':
      return stageIntent(ctx);
    case 'context':
      return stageContext(ctx);
    case 'blast-radius':
      return stageBlastRadius(ctx);
    case 'stack-pack':
      return stageStackPack(ctx);
    case 'research':
      return stageResearch(ctx);
    case 'plan':
      return stagePlan(ctx);
    case 'execute':
      return stageExecute();
    case 'verify':
      return stageVerify(ctx);
    case 'regression':
      return stageRegression(ctx);
    case 'memory':
      return stageMemory(ctx);
    case 'ship-report':
      return stageShipReport(ctx);
    case 'learn':
      return stageLearn(ctx);
    default: {
      const exhaustive: never = stage;
      throw new DevCortexError('INTERNAL', `Unknown workflow stage "${String(exhaustive)}".`);
    }
  }
}

function stageClassify(ctx: StageContext): StageOutcome {
  const { classification, risk } = ctx;
  return {
    stage: 'classify',
    status: 'ok',
    detail: `${classification.taskType} @ ${risk} — ${classification.rationale}`,
    evidenceIds: [],
  };
}

function stageIntent(ctx: StageContext): StageOutcome {
  const intent = compileIntent(ctx.task, ctx.graph, ctx.getPacks(), ctx.config);
  ctx.state.intent = intent;
  return {
    stage: 'intent',
    status: 'ok',
    detail: `goal: ${firstLine(intent.goal)} — ${intent.implementationStages.length} implementation stages, ${intent.acceptanceCriteria.length} acceptance criteria`,
    evidenceIds: [],
  };
}

async function stageContext(ctx: StageContext): Promise<StageOutcome> {
  const intent = requireIntent(ctx, 'context');
  const pack = await compileContext(intent, ctx.graph, ctx.ledgers, ctx.depth);
  ctx.state.contextPack = pack;
  return {
    stage: 'context',
    status: 'ok',
    detail: `depth=${pack.depth}, ~${pack.tokenEstimate} tokens, ${pack.relevantFiles.length} relevant files, ${pack.constraints.length} constraints`,
    evidenceIds: [],
  };
}

function stageBlastRadius(ctx: StageContext): StageOutcome {
  // Proxy change set: the ranked relevant files from the context pack, falling
  // back to the graph's risky files when context did not run.
  const changed =
    ctx.state.contextPack !== undefined && ctx.state.contextPack.relevantFiles.length > 0
      ? ctx.state.contextPack.relevantFiles
      : ctx.graph.riskyFiles;
  const blast = analyzeBlastRadius(ctx.graph, changed, ctx.config);
  ctx.state.blast = blast;
  return {
    stage: 'blast-radius',
    status: 'ok',
    detail: `severity=${blast.severity}; ${blast.requiredChecks.length} required checks; auth=${blast.affectsAuth} billing=${blast.affectsBilling}; ${blast.affectedRoutes.length} routes, ${blast.affectedTests.length} tests`,
    evidenceIds: [],
  };
}

function stageStackPack(ctx: StageContext): StageOutcome {
  const packs = ctx.getPacks();
  return {
    stage: 'stack-pack',
    status: 'ok',
    detail:
      packs.length > 0
        ? `loaded ${packs.length} stack pack(s): ${packs.map((p) => p.id).join(', ')}`
        : 'no stack pack matched the detected stack',
    evidenceIds: [],
  };
}

function stageResearch(ctx: StageContext): StageOutcome {
  const packs = ctx.getPacks();
  const rules = packs.flatMap((p) => [...p.bestPractices, ...p.antiPatterns]);
  const failures = packs.flatMap((p) => p.commonFailures);
  return {
    stage: 'research',
    status: 'ok',
    detail: `${rules.length} best-practice/anti-pattern rules and ${failures.length} known failures from ${packs.length} pack(s) (local knowledge; no live web)`,
    evidenceIds: [],
  };
}

function stagePlan(ctx: StageContext): StageOutcome {
  const intent = requireIntent(ctx, 'plan');
  const steps = intent.implementationStages;
  return {
    stage: 'plan',
    status: 'ok',
    detail:
      steps.length > 0
        ? `${steps.length}-step plan: ${steps.map((s, i) => `${i + 1}. ${s}`).join(' | ')}`
        : 'no implementation stages were derived from intent',
    evidenceIds: [],
  };
}

function stageExecute(): StageOutcome {
  return {
    stage: 'execute',
    status: 'skipped',
    detail:
      'handoff: the host agent applies the edits; the tokenless engine performs no edits and records evidence for the result.',
    evidenceIds: [],
  };
}

async function stageVerify(ctx: StageContext): Promise<StageOutcome> {
  const { result, evidence } = await runQualityGate(ctx.root, ctx.config, ctx.graph);

  // Persist each evidence item (append-only) so the outcome links to durable ids.
  const evidenceIds: string[] = [];
  for (const item of evidence) {
    const persisted = await ctx.ledgers.evidence.add({
      claim: item.claim,
      status: item.status,
      kind: item.kind,
      detail: item.detail,
      ...(item.command !== undefined ? { command: item.command } : {}),
      ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
      ...(item.output !== undefined ? { output: item.output } : {}),
    });
    evidenceIds.push(persisted.id);
    ctx.state.gateEvidence.push(persisted);
  }

  ctx.state.gatePassed = result.passed;
  const passedCount = result.checks.filter((c) => c.passed).length;
  if (!result.passed) {
    ctx.blockedReasons.push(`quality gate "${result.gate}" did not pass`);
  }
  return {
    stage: 'verify',
    status: result.passed ? 'ok' : 'failed',
    detail: `${result.gate}: ${result.passed ? 'passed' : 'blocked'} — ${passedCount}/${result.checks.length} checks passed`,
    evidenceIds,
  };
}

function stageRegression(ctx: StageContext): StageOutcome {
  const checks = ctx.state.blast?.requiredChecks ?? [];
  const risks = ctx.state.intent?.regressionRisks ?? [];
  let detail: string;
  if (checks.length > 0) {
    detail = `${checks.length} required regression checks: ${checks.join('; ')}`;
  } else if (risks.length > 0) {
    detail = `no blast-derived checks; ${risks.length} regression risk(s) from intent: ${risks.join('; ')}`;
  } else {
    detail = 'no regression checks required';
  }
  return { stage: 'regression', status: 'ok', detail, evidenceIds: [] };
}

async function stageMemory(ctx: StageContext): Promise<StageOutcome> {
  const gatePassed = ctx.state.gatePassed ?? false;
  const evidenceRefs: EvidenceRef[] = ctx.state.gateEvidence.map((e) => ({
    id: e.id,
    claim: e.claim,
    status: e.status,
  }));
  const blastNote = ctx.state.blast !== undefined ? `; blast severity ${ctx.state.blast.severity}` : '';
  const item = await ctx.ledgers.memory.add({
    type: 'decision',
    title: `${ctx.def.name}: ${truncate(ctx.task, 100)}`,
    summary: `Ran workflow "${ctx.def.id}" at ${ctx.risk} risk; quality gate ${gatePassed ? 'passed' : 'blocked'} with ${ctx.state.gateEvidence.length} evidence item(s)${blastNote}.`,
    source: `workflow-run:${ctx.def.id}`,
    confidence: gatePassed ? 0.8 : 0.5,
    evidence: evidenceRefs,
    relatedFiles: (ctx.state.contextPack?.relevantFiles ?? []).slice(0, 25),
    relatedFeatures: [],
    riskLevel: ctx.risk,
  });
  ctx.state.memoryItemId = item.id;
  return {
    stage: 'memory',
    status: 'ok',
    detail: `recorded decision memory ${item.id} (confidence ${item.confidence})`,
    evidenceIds: [item.id],
  };
}

async function stageShipReport(ctx: StageContext): Promise<StageOutcome> {
  const report = await generateShipReport(ctx.root, ctx.config, ctx.graph, ctx.ledgers);
  ctx.state.shipReport = report;
  if (report.status === 'NOT_READY') {
    ctx.blockedReasons.push('ship report is NOT_READY');
  }
  return {
    stage: 'ship-report',
    status: report.status === 'NOT_READY' ? 'failed' : 'ok',
    detail: `${report.status}: ${report.passed.length} passed, ${report.blocked.length} blocked, ${report.warnings.length} warning(s)`,
    evidenceIds: report.evidenceIds,
  };
}

function stageLearn(ctx: StageContext): StageOutcome {
  const shipStatus = ctx.state.shipReport?.status ?? 'n/a';
  const okCount = ctx.priorOutcomes.filter((o) => o.status === 'ok').length;
  const lesson =
    ctx.blockedReasons.length > 0
      ? `Workflow "${ctx.def.id}" @ ${ctx.risk} risk was blocked (${ctx.blockedReasons.join('; ')}). Lesson: resolve the blocking gate at its root cause before retrying, and capture the fix as a regression check.`
      : `Workflow "${ctx.def.id}" @ ${ctx.risk} risk completed (${okCount} stages verified, ship ${shipStatus}). Lesson: this stage sequence is a repeatable pattern for ${ctx.def.taskTypes.join('/')} tasks.`;
  // The learning stub is persisted as part of the WorkflowRun record; the §7.17
  // learning engine owns durable LearnedFailure records.
  return { stage: 'learn', status: 'ok', detail: lesson, evidenceIds: [] };
}

// --- persistence ------------------------------------------------------------

/** Validate + atomically write a workflow run to `.cortex/workflows/<id>.json`. */
async function persistRun(root: string, run: WorkflowRun): Promise<WorkflowRun> {
  const result = WorkflowRunSchema.safeParse(run);
  if (!result.success) {
    throw new SchemaValidationError('Refusing to write an invalid workflow run.', {
      details: result.error.issues,
      cause: result.error,
    });
  }
  const validated = result.data;
  const dir = workflowsDir(root);
  const file = path.join(dir, `${validated.id}.json`);
  const tmp = path.join(dir, `.${validated.id}.${randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new DevCortexError('INTERNAL', `Unable to write workflow run to ${file}.`, { cause: err });
  }
  return validated;
}

/** Parse + schema-validate raw run JSON, mapping failure to a clear error. */
function parseRun(raw: string, file: string): WorkflowRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SchemaValidationError(`The workflow run at ${file} is not valid JSON.`, { cause: err });
  }
  const result = WorkflowRunSchema.safeParse(parsed);
  if (!result.success) {
    throw new SchemaValidationError(`The workflow run at ${file} failed schema validation.`, {
      details: result.error.issues,
      cause: result.error,
    });
  }
  return result.data;
}

// --- helpers ----------------------------------------------------------------

function aboveRisk(stage: WorkflowStage, risk: RiskLevel): boolean {
  return RISK_RANK[STAGE_MIN_RISK[stage]] > RISK_RANK[risk];
}

function requireIntent(ctx: StageContext, stage: WorkflowStage): IntentContract {
  if (ctx.state.intent === undefined) {
    throw new DevCortexError('INTERNAL', `stage "${stage}" requires the intent stage to have run first`);
  }
  return ctx.state.intent;
}

function buildRunId(iso: string): string {
  const stamp = iso.replace(/[:.]/g, '-').replace('T', '-').replace(/Z$/, '');
  return `${RUN_ID_PREFIX}${stamp}-${randomUUID().slice(0, 8)}`;
}

function runFile(root: string, runId: string): string {
  assertSafeRunId(runId);
  return path.join(workflowsDir(root), `${runId}.json`);
}

function assertSafeRunId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new SchemaValidationError('A workflow run id must be a non-empty string.');
  }
  if (id !== path.basename(id) || id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new SchemaValidationError(`The workflow run id "${id}" is not a safe id.`);
  }
}

function assertRoot(root: string): void {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new SchemaValidationError('runWorkflow: root must be a non-empty string.');
  }
}

function assertTask(task: string): void {
  if (typeof task !== 'string' || task.trim().length === 0) {
    throw new SchemaValidationError('runWorkflow: task must be a non-empty string.');
  }
}

function assertDeps(deps: WorkflowDeps): void {
  if (deps === null || typeof deps !== 'object') {
    throw new SchemaValidationError('runWorkflow: deps must be a WorkflowDeps object.');
  }
  if (deps.graph === null || typeof deps.graph !== 'object' || !Array.isArray(deps.graph.files)) {
    throw new SchemaValidationError('runWorkflow: deps.graph must be a ProjectGraph.');
  }
  if (deps.config === null || typeof deps.config !== 'object' || deps.config.risk === undefined) {
    throw new SchemaValidationError('runWorkflow: deps.config must be a CortexConfig.');
  }
  const ledgers = deps.ledgers as Partial<WorkflowLedgers> | null | undefined;
  if (
    ledgers === null ||
    typeof ledgers !== 'object' ||
    ledgers.memory === undefined ||
    ledgers.feature === undefined ||
    ledgers.decision === undefined ||
    ledgers.evidence === undefined
  ) {
    throw new SchemaValidationError(
      'runWorkflow: deps.ledgers must include memory, feature, decision, and evidence ledgers.',
    );
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? text;
  return truncate(line.trim(), 120);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function compareByStartedThenId(a: WorkflowRun, b: WorkflowRun): number {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
