// ============================================================================
// Command implementations. Each is `(globals, localOpts) => Promise<CommandResult>`
// composing @devcortex/core. No command throws raw to the user: failures are
// `DevCortexError`s that the cli.ts wrapper renders cleanly.
// ============================================================================

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  analyzeBlastRadius,
  analyzeFailures,
  auditMcp,
  blockUnprovenDone,
  builtInSkills,
  classifyRisk,
  compileContext,
  compileIntent,
  composeSessionBrief,
  ConfigError,
  CONTEXT_DEPTHS,
  defaultConfig,
  depthForRisk,
  DevCortexError,
  distillTranscript,
  evaluateToolCall,
  FEATURE_STATUSES,
  GATE_FAMILIES,
  generateShipReport,
  initWorkspace,
  installMcpSafely,
  isInitialized,
  isProtected,
  learn,
  listMcp,
  loadConfig,
  loadGraph,
  loadPolicy,
  matchPacks,
  MEMORY_TYPES,
  PRIVACY_MODES,
  recommendMcp,
  redactText,
  relevantFiles,
  RISK_LEVELS,
  runDevopsGate,
  runPremiumUiGate,
  runProductGate,
  runQualityGate,
  runSecurityGate,
  runUiGate,
  runWorkflow,
  saveConfig,
  saveGraph,
  scanProject,
  selectWorkflow,
  shouldBlock,
  skillsDir,
  SkillStore,
  STAGE_MIN_RISK,
  workflowDefinitions,
  WORKFLOW_IDS,
} from '@devcortex/core';
import type {
  BlastRadius,
  ContextDepth,
  CortexCommands,
  CortexConfig,
  EvidenceInput,
  EvidenceStatus,
  FeatureInput,
  FeatureStatus,
  GateFamily,
  MemoryInput,
  MemoryType,
  PackageManager,
  PrivacyMode,
  ProjectGraph,
  RiskClassification,
  RiskLevel,
  SkillManifest,
  ToolCall,
  WorkflowId,
  WorkflowStage,
} from '@devcortex/core';
import { installClaude, type InstallResult } from '@devcortex/claude-code';
import { installCodex } from '@devcortex/codex';
import { installCursor } from '@devcortex/cursor';
import { installVscode } from '@devcortex/vscode';
import { installGithubActions } from '@devcortex/github-actions';

import {
  renderContext,
  renderDoctor,
  renderFeatureItem,
  renderFeatureList,
  renderFirewallCheck,
  renderFirewallPolicy,
  renderGate,
  renderInit,
  renderInstall,
  renderInstallAll,
  renderLearn,
  renderMcpAudit,
  renderMcpInstall,
  renderMcpList,
  renderMcpRecommend,
  renderMemoryItem,
  renderMemoryList,
  renderPlan,
  renderPreflight,
  renderPremiumActivate,
  renderPremiumInstall,
  renderPremiumStatus,
  renderPrivacyRedact,
  renderPrivacyStatus,
  renderScan,
  renderShipStatus,
  renderSkillItem,
  renderSkillList,
  renderSkillRecommend,
  renderVerify,
  renderWorkflowList,
  renderWorkflowRun,
} from './format';
import type {
  DoctorCheck,
  GateFamilyView,
  InstallAllItemView,
  LearnFailureView,
  PlanStageView,
  PremiumBundleView,
  PremiumLicenseView,
  SkillListItemView,
  SkillRecommendationView,
} from './format';
import { verifyLicenseFile } from './premium/license';
import type { LicenseFile } from './premium/license';
import { installFromTarball, loadPremiumBrain } from './premium/loader';
import { installedManifestPath, readLicenseFile, writeLicenseFile } from './premium/store';
import {
  EXIT_NOT_READY,
  emit,
  loadOrScanGraph,
  makeLedgers,
  relWorkspacePath,
  workspacePaths,
} from './runtime';
import type { CommandResult, GlobalOptions, HookOutcome, HookPayload } from './runtime';

// --- shared helpers ---------------------------------------------------------

const GATES = ['typecheck', 'lint', 'build', 'test'] as const;

function assertEnum<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new DevCortexError(
    'INTERNAL',
    `Invalid value "${value}" for ${flag}. Expected one of: ${allowed.join(', ')}.`,
  );
}

function parseConfidence(raw: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DevCortexError('INTERNAL', `--confidence must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

/** The package-manager binary used to run package scripts. */
function runPrefix(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm';
    case 'yarn':
      return 'yarn';
    case 'bun':
      return 'bun';
    default:
      return 'npm';
  }
}

/**
 * Resolve gate commands from the project's own scripts so the quality gate runs
 * the checks the project actually defines. Only gates with a backing script are
 * configured; the rest stay unset (the gate notes them rather than guessing).
 */
function resolveGateCommands(graph: ProjectGraph): CortexCommands {
  const prefix = runPrefix(graph.stack.packageManager);
  const commands: CortexCommands = {};
  for (const gate of GATES) {
    const script = graph.scripts[gate];
    if (typeof script === 'string' && script.trim().length > 0) {
      commands[gate] = `${prefix} run ${gate}`;
    }
  }
  return commands;
}

// --- init -------------------------------------------------------------------

export interface InitOpts {
  force: boolean;
}

export async function cmdInit(g: GlobalOptions, opts: InitOpts): Promise<CommandResult> {
  const paths = workspacePaths(g.root);

  // Exists-guard via the shared core predicate. We keep the CLI's own
  // "already initialized" message (and exit 1) so the non-force path is a clean
  // user error rather than core's lower-level WORKSPACE_EXISTS throw.
  if (!opts.force && (await isInitialized(g.root))) {
    throw new DevCortexError(
      'WORKSPACE_EXISTS',
      `DevCortex is already initialized at ${relWorkspacePath(g.root, paths.cortexDir)}. Re-run with --force to re-initialize.`,
    );
  }

  // Scan once and hand the graph to core.initWorkspace, which is now the single
  // source of truth for materializing the `.cortex/` tree (config + graph +
  // generated docs + ledger dirs). The exists-guard above already enforced the
  // non-force contract, so initWorkspace runs with force to do the write.
  const graph = await scanProject(g.root);
  const { created } = await initWorkspace(g.root, {
    mode: defaultConfig(graph.stack).mode,
    stack: graph.stack,
    force: true,
    graph,
  });

  // core.defaultConfig deliberately leaves `commands` empty (a DetectedStack
  // carries no scripts); resolve the real gate commands from the scanned graph
  // and persist them so `verify` / `ship` run the project's actual checks.
  const config = await loadConfig(g.root);
  config.commands = resolveGateCommands(graph);
  await saveConfig(g.root, config);

  const createdRel = created.map((abs) => relWorkspacePath(g.root, abs));
  return {
    data: {
      ok: true,
      root: g.root,
      stack: graph.stack,
      created: createdRel,
      gateCommands: config.commands,
      matchedPacks: matchPacks(graph.stack).map((p) => p.id),
    },
    human: renderInit(createdRel, graph),
  };
}

// --- doctor -----------------------------------------------------------------

export async function cmdDoctor(g: GlobalOptions): Promise<CommandResult> {
  const paths = workspacePaths(g.root);
  const checks: DoctorCheck[] = [];

  checks.push({ name: 'node', status: 'ok', detail: process.version });

  let config: CortexConfig | null = null;
  try {
    config = await loadConfig(g.root);
    checks.push({
      name: 'workspace',
      status: 'ok',
      detail: `initialized at ${relWorkspacePath(g.root, paths.cortexDir)}`,
    });
  } catch (err) {
    const code = err instanceof DevCortexError ? err.code : 'INTERNAL';
    if (code === 'CONFIG_NOT_FOUND') {
      checks.push({ name: 'workspace', status: 'fail', detail: 'not initialized — run `devcortex init`' });
    } else if (code === 'CONFIG_INVALID') {
      checks.push({
        name: 'workspace',
        status: 'fail',
        detail: err instanceof Error ? err.message : 'config is invalid',
      });
    } else {
      throw err;
    }
  }

  if (config !== null) {
    checks.push({
      name: 'mode',
      status: 'ok',
      detail: `${config.mode} · privacy ${config.privacy} · blockUnprovenDone ${config.gates.blockUnprovenDone}`,
    });

    const configuredGates = GATES.filter((gate) => {
      const cmd = config.commands[gate];
      return typeof cmd === 'string' && cmd.length > 0;
    });
    const missing = GATES.filter((gate) => config.gates[gate] && !configuredGates.includes(gate));
    checks.push({
      name: 'gates',
      status: missing.length > 0 ? 'warn' : 'ok',
      detail:
        missing.length > 0
          ? `enabled but unconfigured: ${missing.join(', ')} (no matching script)`
          : `configured: ${configuredGates.length > 0 ? configuredGates.join(', ') : 'none'}`,
    });

    let graph: ProjectGraph | null = null;
    try {
      graph = await loadGraph(g.root);
    } catch (err) {
      checks.push({
        name: 'graph',
        status: 'fail',
        detail: err instanceof Error ? err.message : 'cached graph is corrupt',
      });
    }
    if (graph !== null) {
      checks.push({
        name: 'graph',
        status: 'ok',
        detail: `cached · ${graph.stats.fileCount} files · generated ${graph.generatedAt}`,
      });
      const stackOk = graph.stack.framework !== 'unknown';
      checks.push({
        name: 'stack',
        status: stackOk ? 'ok' : 'warn',
        detail: stackOk ? `${graph.stack.framework}/${graph.stack.language}` : 'framework not detected',
      });
      const packs = matchPacks(graph.stack);
      checks.push({
        name: 'stack-packs',
        status: packs.length > 0 ? 'ok' : 'warn',
        detail: packs.length > 0 ? packs.map((p) => p.id).join(', ') : 'no pack matched this stack',
      });
    } else if (!checks.some((c) => c.name === 'graph')) {
      checks.push({ name: 'graph', status: 'warn', detail: 'no cached graph — run `devcortex scan`' });
    }
  }

  return { data: { ok: true, checks }, human: renderDoctor(checks) };
}

// --- scan -------------------------------------------------------------------

export async function cmdScan(g: GlobalOptions): Promise<CommandResult> {
  const paths = workspacePaths(g.root);
  const graph = await scanProject(g.root);
  await mkdir(paths.cortexDir, { recursive: true });
  await saveGraph(g.root, graph);
  return { data: graph, human: renderScan(graph) };
}

// --- brief ------------------------------------------------------------------

export async function cmdBrief(g: GlobalOptions): Promise<CommandResult> {
  const brief = await composeSessionBrief(g.root);
  return { data: { ok: true, brief }, human: brief.text };
}

// --- preflight --------------------------------------------------------------

export async function cmdPreflight(g: GlobalOptions, task: string): Promise<CommandResult> {
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new DevCortexError('INTERNAL', 'preflight requires a non-empty task description.');
  }

  // Latency budget for the preflight pipeline.
  // Default: 400ms cold path (WS-1 design pt 3). The warm/150ms path lands with
  // daemon-socket reuse in a later phase and must not appear in user-facing docs this phase.
  const rawBudget = Number(process.env.DEVCORTEX_PREFLIGHT_BUDGET_MS ?? '400');
  const budgetMs = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 400;
  const startedAt = performance.now();
  const elapsed = (): number => performance.now() - startedAt;
  let degraded = false;

  const config = await loadConfig(g.root);
  const graph = await loadOrScanGraph(g.root);
  const ledgers = makeLedgers(g.root);

  const risk = classifyRisk(trimmed, graph, config);
  const packs = matchPacks(graph.stack);
  const intent = compileIntent(trimmed, graph, packs, config);

  // Degrade ladder — checked between pipeline phases. risk and intent are never skipped.
  // If elapsed > 60% of budget after compileIntent → skip analyzeBlastRadius.
  let blast: BlastRadius | null;
  if (elapsed() > budgetMs * 0.6) {
    degraded = true;
    blast = null;
  } else {
    const candidatePaths = relevantFiles(graph, trimmed).map((file) => file.path);
    blast = analyzeBlastRadius(graph, candidatePaths, config);
  }

  // If elapsed > 85% of budget before compileContext → force depth 'tiny'.
  let depth: ContextDepth;
  if (elapsed() > budgetMs * 0.85) {
    degraded = true;
    depth = 'tiny';
  } else {
    depth = depthForRisk(risk.riskLevel);
  }

  const context = await compileContext(intent, graph, ledgers, depth);

  return {
    data: {
      ok: true,
      task: trimmed,
      risk,
      blastRadius: blast,
      intent,
      context,
      degraded,
      elapsedMs: Math.round(elapsed()),
    },
    human: renderPreflight({ task: trimmed, risk, blast, intent, context }),
  };
}

// --- context ----------------------------------------------------------------

export interface ContextOpts {
  level?: string;
}

export async function cmdContext(
  g: GlobalOptions,
  task: string,
  opts: ContextOpts,
): Promise<CommandResult> {
  const effectiveTask = task.trim().length > 0 ? task.trim() : 'Review the project and continue work safely.';

  const config = await loadConfig(g.root);
  const graph = await loadOrScanGraph(g.root);
  const ledgers = makeLedgers(g.root);

  const risk = classifyRisk(effectiveTask, graph, config);
  const packs = matchPacks(graph.stack);
  const intent = compileIntent(effectiveTask, graph, packs, config);

  const depth: ContextDepth =
    opts.level !== undefined
      ? assertEnum(opts.level, CONTEXT_DEPTHS, '--level')
      : depthForRisk(risk.riskLevel);

  const context = await compileContext(intent, graph, ledgers, depth);
  return { data: { ok: true, task: effectiveTask, context }, human: renderContext(context) };
}

// --- verify -----------------------------------------------------------------

export async function cmdVerify(g: GlobalOptions): Promise<CommandResult> {
  const config = await loadConfig(g.root);
  const graph = await loadOrScanGraph(g.root);

  const { result, evidence } = await runQualityGate(g.root, config, graph);
  return {
    data: { ok: result.passed, result, evidence },
    human: renderVerify(result),
    exitCode: result.passed ? 0 : EXIT_NOT_READY,
  };
}

// --- gate -------------------------------------------------------------------
//
// The deep quality gates (sub-project #4, spec §7.12-7.13 + §7.21). Each family
// maps to a core gate. The check-based families (code / ui / security / devops /
// product) return a GateResult whose `passed` flag is the gate's own verdict
// ("every REQUIRED check passed"); premium-ui returns a computed UiQualityScore
// (dimensions + overall + top fixes) and has no pass/fail checks — it is
// informational and never triggers the not-ready exit on its own.

/** Does the project define at least one runnable gate command (typecheck/lint/build/test)? */
function hasCodeCommands(config: CortexConfig): boolean {
  return GATES.some((gate) => {
    const cmd = config.commands[gate];
    return typeof cmd === 'string' && cmd.trim().length > 0;
  });
}

/**
 * A frontend stack renders a user-facing surface: a browser framework, or files
 * of a UI kind, or a page route. The ui / premium-ui gates only make sense here.
 */
function isFrontendStack(graph: ProjectGraph): boolean {
  const framework = graph.stack.framework;
  if (framework === 'nextjs' || framework === 'react' || framework === 'vite') return true;
  if (graph.files.some((f) => f.kind === 'page' || f.kind === 'component' || f.kind === 'style')) {
    return true;
  }
  return graph.routes.some((r) => r.kind === 'page' || r.kind === 'layout');
}

/** The product gate needs a user-facing surface: any route, or a frontend stack. */
function hasUserFacingSurface(graph: ProjectGraph): boolean {
  return graph.routes.length > 0 || isFrontendStack(graph);
}

/**
 * The devops gate only applies when there is a deploy/infra signal to inspect:
 * a declared deployment target, or a Docker / CI / Kubernetes / Vercel artifact
 * in the graph. (The gate itself degrades gracefully, but we don't run it by
 * default on a project with nothing to deploy.)
 */
function hasInfraSignal(graph: ProjectGraph): boolean {
  if (graph.stack.deploymentTargets.length > 0) return true;
  return graph.files.some((file) => {
    const p = file.path.toLowerCase();
    return (
      p === 'dockerfile' ||
      p.endsWith('/dockerfile') ||
      p.includes('docker-compose') ||
      p.endsWith('vercel.json') ||
      p.includes('kubernetes') ||
      p.startsWith('k8s/') ||
      p.includes('/k8s/') ||
      p.startsWith('.github/workflows/') ||
      p.includes('/.github/workflows/')
    );
  });
}

/** Predicate per family deciding whether it applies to the detected stack. */
const FAMILY_APPLIES: Record<GateFamily, (graph: ProjectGraph, config: CortexConfig) => boolean> = {
  code: (_graph, config) => hasCodeCommands(config),
  ui: (graph) => isFrontendStack(graph),
  security: () => true,
  devops: (graph) => hasInfraSignal(graph),
  product: (graph) => hasUserFacingSurface(graph),
  'premium-ui': (graph) => isFrontendStack(graph),
};

/** Families applicable to the detected stack, in canonical GATE_FAMILIES order. */
function applicableFamilies(graph: ProjectGraph, config: CortexConfig): GateFamily[] {
  return GATE_FAMILIES.filter((family) => FAMILY_APPLIES[family](graph, config));
}

/** Run one gate family, normalized to a view (check gates carry evidence; premium-ui a score). */
async function runGateFamily(
  family: GateFamily,
  root: string,
  graph: ProjectGraph,
  config: CortexConfig,
): Promise<GateFamilyView> {
  switch (family) {
    case 'code': {
      const { result, evidence } = await runQualityGate(root, config, graph);
      return { kind: 'checks', family, gate: result.gate, passed: result.passed, checks: result.checks, evidence };
    }
    case 'ui': {
      const { result, evidence } = await runUiGate(root, graph, config);
      return { kind: 'checks', family, gate: result.gate, passed: result.passed, checks: result.checks, evidence };
    }
    case 'security': {
      const { result, evidence } = await runSecurityGate(root, graph, config);
      return { kind: 'checks', family, gate: result.gate, passed: result.passed, checks: result.checks, evidence };
    }
    case 'devops': {
      const { result, evidence } = await runDevopsGate(root, graph, config);
      return { kind: 'checks', family, gate: result.gate, passed: result.passed, checks: result.checks, evidence };
    }
    case 'product': {
      const { result, evidence } = await runProductGate(root, graph, config);
      return { kind: 'checks', family, gate: result.gate, passed: result.passed, checks: result.checks, evidence };
    }
    case 'premium-ui': {
      const score = await runPremiumUiGate(root, graph);
      return { kind: 'score', family, score };
    }
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}

/**
 * Run one or all deep quality gates. With an explicit `family` it runs just that
 * gate; otherwise it runs every family applicable to the detected stack (in
 * canonical order). Exits 2 (not-ready) when any check-based gate reports a
 * failing required check, so CI / hooks can gate on it; premium-ui is a score
 * and never causes the not-ready exit on its own.
 */
export async function cmdGate(g: GlobalOptions, family: string | undefined): Promise<CommandResult> {
  const config = await loadConfig(g.root);
  const graph = await loadOrScanGraph(g.root);

  const families =
    family !== undefined
      ? [assertEnum<GateFamily>(family, GATE_FAMILIES, 'gate family')]
      : applicableFamilies(graph, config);

  const results: GateFamilyView[] = [];
  for (const fam of families) {
    results.push(await runGateFamily(fam, g.root, graph, config));
  }

  // A gate is "ok" iff every check-based family passed its required checks; a
  // premium-ui score is informational and does not flip the overall verdict.
  const ok = results.every((r) => r.kind === 'score' || r.passed);

  return {
    data: { ok, families, results },
    human: renderGate({ stack: graph.stack, families, results, ok }),
    exitCode: ok ? 0 : EXIT_NOT_READY,
  };
}

// --- ship -------------------------------------------------------------------

/** Directory listing that tolerates a not-yet-created ship-reports dir. */
async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new DevCortexError('INTERNAL', `Unable to read ${dir}.`, { cause: err });
  }
}

export async function cmdShip(g: GlobalOptions): Promise<CommandResult> {
  const config = await loadConfig(g.root);
  const graph = await loadOrScanGraph(g.root);
  const ledgers = makeLedgers(g.root);
  const paths = workspacePaths(g.root);

  // `generateShipReport` persists the canonical markdown report itself (with a
  // uuid-suffixed filename) but does not return the path. Diff the directory to
  // surface exactly the file it wrote — never a second, divergent copy.
  const before = await safeReadDir(paths.shipReportsDir);
  const report = await generateShipReport(g.root, config, graph, ledgers);
  const after = await safeReadDir(paths.shipReportsDir);

  const stampPrefix = report.generatedAt.replace(/[:.]/g, '-');
  const added = after.filter((f) => !before.includes(f) && f.endsWith('.md'));
  const candidates = (added.length > 0 ? added : after.filter((f) => f.startsWith(stampPrefix) && f.endsWith('.md')))
    .slice()
    .sort();
  const reportFile = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
  const reportPath =
    reportFile !== undefined
      ? relWorkspacePath(g.root, path.join(paths.shipReportsDir, reportFile))
      : relWorkspacePath(g.root, paths.shipReportsDir);

  const { blocked, reasons } = blockUnprovenDone(report);
  const notReady = report.status === 'NOT_READY';
  return {
    data: { ok: !notReady, report, blocked, reasons, reportPath },
    human: renderShipStatus({ report, blocked, reasons, reportPath }),
    exitCode: notReady ? EXIT_NOT_READY : 0,
  };
}

// --- memory -----------------------------------------------------------------

export interface MemoryAddOpts {
  type: string;
  title: string;
  summary: string;
  source: string;
  confidence: string;
  risk: string;
  relatedFile: string[];
  relatedFeature: string[];
}

export async function cmdMemoryAdd(g: GlobalOptions, opts: MemoryAddOpts): Promise<CommandResult> {
  await loadConfig(g.root);
  const ledgers = makeLedgers(g.root);

  const input: MemoryInput = {
    type: assertEnum<MemoryType>(opts.type, MEMORY_TYPES, '--type'),
    title: opts.title,
    summary: opts.summary,
    source: opts.source,
    confidence: parseConfidence(opts.confidence),
    evidence: [],
    relatedFiles: opts.relatedFile,
    relatedFeatures: opts.relatedFeature,
    riskLevel: assertEnum<RiskLevel>(opts.risk, RISK_LEVELS, '--risk'),
  };

  const item = await ledgers.memory.add(input);
  return { data: { ok: true, item }, human: renderMemoryItem(item) };
}

export interface MemoryListOpts {
  type?: string;
}

export async function cmdMemoryList(g: GlobalOptions, opts: MemoryListOpts): Promise<CommandResult> {
  await loadConfig(g.root);
  const ledgers = makeLedgers(g.root);
  const filterType = opts.type !== undefined ? assertEnum<MemoryType>(opts.type, MEMORY_TYPES, '--type') : undefined;
  const items = await ledgers.memory.list(
    filterType !== undefined ? (item) => item.type === filterType : undefined,
  );
  return { data: { ok: true, count: items.length, items }, human: renderMemoryList(items) };
}

export async function cmdMemoryGet(g: GlobalOptions, id: string): Promise<CommandResult> {
  await loadConfig(g.root);
  const ledgers = makeLedgers(g.root);
  const item = await ledgers.memory.get(id);
  if (item === undefined) {
    throw new DevCortexError('LEDGER_CORRUPT', `No memory item with id "${id}".`);
  }
  return { data: { ok: true, item }, human: renderMemoryItem(item) };
}

// --- feature ----------------------------------------------------------------

export interface FeatureAddOpts {
  name: string;
  purpose: string;
  userValue: string;
  status: string;
  route: string[];
  component: string[];
  api: string[];
  table: string[];
  env: string[];
  dependency: string[];
  acceptance: string[];
  test: string[];
  knownRisk: string[];
  protectedBehavior: string[];
  relatedDecision: string[];
  regressionCheck: string[];
}

export async function cmdFeatureAdd(g: GlobalOptions, opts: FeatureAddOpts): Promise<CommandResult> {
  await loadConfig(g.root);
  const ledgers = makeLedgers(g.root);

  const input: FeatureInput = {
    feature: opts.name,
    status: assertEnum<FeatureStatus>(opts.status, FEATURE_STATUSES, '--status'),
    purpose: opts.purpose,
    userValue: opts.userValue,
    routes: opts.route,
    components: opts.component,
    apiEndpoints: opts.api,
    databaseTables: opts.table,
    envVars: opts.env,
    dependencies: opts.dependency,
    protectedBehaviors: opts.protectedBehavior,
    acceptanceCriteria: opts.acceptance,
    tests: opts.test,
    evidence: [],
    knownRisks: opts.knownRisk,
    relatedDecisions: opts.relatedDecision,
    regressionChecks: opts.regressionCheck,
  };

  const item = await ledgers.feature.add(input);
  return { data: { ok: true, item }, human: renderFeatureItem(item) };
}

export interface FeatureListOpts {
  status?: string;
}

export async function cmdFeatureList(g: GlobalOptions, opts: FeatureListOpts): Promise<CommandResult> {
  await loadConfig(g.root);
  const ledgers = makeLedgers(g.root);
  const filterStatus =
    opts.status !== undefined ? assertEnum<FeatureStatus>(opts.status, FEATURE_STATUSES, '--status') : undefined;
  const items = await ledgers.feature.list(
    filterStatus !== undefined ? (item) => item.status === filterStatus : undefined,
  );
  return { data: { ok: true, count: items.length, items }, human: renderFeatureList(items) };
}

export async function cmdFeatureGet(g: GlobalOptions, id: string): Promise<CommandResult> {
  await loadConfig(g.root);
  const ledgers = makeLedgers(g.root);
  const item = await ledgers.feature.get(id);
  if (item === undefined) {
    throw new DevCortexError('LEDGER_CORRUPT', `No feature record with id "${id}".`);
  }
  return { data: { ok: true, item }, human: renderFeatureItem(item) };
}

// --- install ----------------------------------------------------------------

export interface InstallOpts {
  force: boolean;
}

/** A supported host-integration target. */
export type InstallTarget = 'claude' | 'codex' | 'cursor' | 'vscode' | 'github';

/**
 * The ordered set of install targets. This same order is used by `install --all`
 * so the per-host output is deterministic.
 */
export const INSTALL_TARGETS = ['claude', 'codex', 'cursor', 'vscode', 'github'] as const;

/**
 * An installer writes/merges a host's config files and reports what it did.
 * Every adapter returns the same structural `InstallResult` (claude's action
 * union is the widest, so it is the canonical type here); each package's own
 * result is assignable to it.
 */
type Installer = (root: string, opts: { force?: boolean }) => Promise<InstallResult>;

/** Per-target installer plus the human-facing label and applied-footer note. */
interface HostIntegration {
  readonly label: string;
  readonly note: string;
  readonly install: Installer;
}

const HOST_INTEGRATIONS: Record<InstallTarget, HostIntegration> = {
  claude: {
    label: 'Claude Code',
    note: 'Claude Code lifecycle hooks + MCP server registered.',
    install: installClaude,
  },
  codex: {
    label: 'Codex',
    note: 'Codex AGENTS.md instructions + MCP server registered.',
    install: installCodex,
  },
  cursor: {
    label: 'Cursor',
    note: 'Cursor project rule + MCP server registered.',
    install: installCursor,
  },
  vscode: {
    label: 'VS Code',
    note: 'VS Code tasks + MCP server + settings section registered.',
    install: installVscode,
  },
  github: {
    label: 'GitHub Actions',
    note: 'GitHub Actions CI workflow + composite ship-check action written.',
    install: installGithubActions,
  },
};

function isInstallTarget(target: string): target is InstallTarget {
  return (INSTALL_TARGETS as readonly string[]).includes(target);
}

export async function cmdInstall(
  g: GlobalOptions,
  target: string | undefined,
  opts: InstallOpts,
): Promise<CommandResult> {
  if (target === undefined) {
    throw new DevCortexError(
      'INTERNAL',
      `install requires a target (${INSTALL_TARGETS.join(', ')}) or --all.`,
    );
  }
  if (!isInstallTarget(target)) {
    throw new DevCortexError(
      'INTERNAL',
      `Unknown install target "${target}". Supported targets: ${INSTALL_TARGETS.join(', ')}, or --all.`,
    );
  }

  const host = HOST_INTEGRATIONS[target];
  const result = await host.install(g.root, { force: opts.force });
  return {
    data: { ok: true, target, result },
    human: renderInstall(result, host.note),
  };
}

/**
 * Install EVERY supported host integration in one pass, reporting per-target
 * results. Targets touch disjoint file sets, so one target returning a `plan`
 * (a pre-existing file would change and `--force` was not given) does not stop
 * the others. Exit stays 0: a plan is informational, matching the single-target
 * contract — the user re-runs with `--force` to apply.
 */
export async function cmdInstallAll(g: GlobalOptions, opts: InstallOpts): Promise<CommandResult> {
  const results: InstallAllItemView[] = [];
  for (const target of INSTALL_TARGETS) {
    const host = HOST_INTEGRATIONS[target];
    const result = await host.install(g.root, { force: opts.force });
    results.push({ target, label: host.label, result });
  }

  const applied = results.filter((r) => r.result.status === 'applied').length;
  const planned = results.filter((r) => r.result.status === 'plan').length;
  return {
    data: { ok: true, count: results.length, applied, planned, results },
    human: renderInstallAll(results),
  };
}

// --- premium ------------------------------------------------------------------

/**
 * `premium activate <file>` — verify a license JSON offline and store it under
 * the DevCortex home. FAIL-LOUD contract: an unreadable file, unparseable
 * JSON, a bad signature, or a hard-expired license all THROW and nothing is
 * stored — only `valid` and `grace` licenses persist (grace surfaces its
 * warning). The stored file pairs the VERIFIED payload (re-materialized from
 * the exact signed bytes by `verifyLicenseFile`) with the original signature,
 * so the store never carries unsigned extra fields from the input file and
 * always re-verifies deterministically.
 *
 * `opts.publicKeysPem` is a TEST/STAGING-ONLY injection seam mirroring
 * `verifyLicenseFile` — the embedded PREMIUM_PUBKEYS list ships empty until
 * the production key lands. The CLI deliberately exposes no flag for it.
 */
export async function cmdPremiumActivate(
  g: GlobalOptions,
  file: string,
  opts?: { publicKeysPem?: readonly string[] },
): Promise<CommandResult> {
  const target = file.trim();
  if (target.length === 0) {
    throw new DevCortexError('INTERNAL', 'premium activate requires a license file path.');
  }
  const abs = path.isAbsolute(target) ? target : path.resolve(g.root, target);

  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    throw new DevCortexError('INTERNAL', `Cannot read license file "${target}".`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`License file "${target}" is not valid JSON.`, { cause: err });
  }

  const check = verifyLicenseFile(parsed, opts);
  const state = check.state;
  if (state !== 'valid' && state !== 'grace') {
    const reason = check.reason ?? 'License verification failed.';
    throw new DevCortexError('INTERNAL', `License not activated: ${reason}`);
  }
  const payload = check.payload;
  if (payload === undefined) {
    // Unreachable: valid/grace outcomes always echo the verified payload.
    throw new DevCortexError('INTERNAL', 'License not activated: verified payload missing.');
  }

  // Safe cast: a valid/grace outcome means the shape guard inside
  // `verifyLicenseFile` accepted `parsed` as a LicenseFile (string `sig`).
  const stored: LicenseFile = { payload, sig: (parsed as LicenseFile).sig };
  await writeLicenseFile(stored);

  const daysLeft = check.daysLeft ?? 0;
  return {
    data: { ok: true, state, daysLeft },
    human: renderPremiumActivate({
      state,
      sub: payload.sub,
      plan: payload.plan,
      daysLeft,
      ...(check.reason !== undefined ? { reason: check.reason } : {}),
    }),
  };
}

/**
 * `premium install` — P0 is the LOCAL path: `--from-file <tgz>` plus
 * `--version <v>` extract a bundle tarball under the DevCortex home (the
 * remote download path arrives with DevCortex Cloud). Gate order is
 * deliberate: an activated, non-expired license is required BEFORE anything
 * touches disk (grace proceeds with its warning), then `installFromTarball`
 * extracts + records the manifest, then `loadPremiumBrain` runs as the
 * post-install acceptance test — a bundle that fails the handshake fails the
 * install, loudly, with the loader's own refusal reason.
 *
 * `opts.publicKeysPem` is the same test/staging-only seam as activate.
 */
export async function cmdPremiumInstall(
  g: GlobalOptions,
  local: { fromFile?: string; version?: string },
  opts?: { publicKeysPem?: readonly string[] },
): Promise<CommandResult> {
  const fromFile = local.fromFile?.trim() ?? '';
  if (fromFile.length === 0) {
    throw new DevCortexError(
      'INTERNAL',
      'remote install requires DevCortex Cloud — pass --from-file for a local bundle',
    );
  }
  const version = local.version?.trim() ?? '';
  if (version.length === 0) {
    throw new DevCortexError(
      'INTERNAL',
      'premium install --from-file also requires --version <version> (the bundle version being installed).',
    );
  }

  // License gate — refuse BEFORE extracting anything. Absent and invalid both
  // point at activation; hard-expired carries the verifier's actionable reason.
  const stored = await readLicenseFile();
  const check = stored === null ? null : verifyLicenseFile(stored, opts);
  if (check === null || check.state === 'invalid') {
    const why = check?.reason ?? 'No license activated.';
    throw new DevCortexError(
      'INTERNAL',
      `Premium install requires an activated license — run \`devcortex premium activate <license.json>\` first. (${why})`,
    );
  }
  if (check.state === 'expired') {
    throw new DevCortexError(
      'INTERNAL',
      `Premium install refused: ${check.reason ?? 'the license has expired past its grace window.'}`,
    );
  }

  const abs = path.isAbsolute(fromFile) ? fromFile : path.resolve(g.root, fromFile);
  const { installDir } = await installFromTarball(abs, version);

  // Post-install verification — the loader IS the acceptance test. Refusing
  // here (files stay for inspection; status will show the same refusal) beats
  // reporting success for a bundle that can never load.
  const load = await loadPremiumBrain(opts);
  if (load.status !== 'ok') {
    throw new DevCortexError(
      'INTERNAL',
      `Bundle extracted but failed verification (${load.status}): ${load.reason}`,
    );
  }

  return {
    data: { ok: true, version: load.version, installDir, contract: 'ok' },
    human: renderPremiumInstall({
      version: load.version,
      installDir,
      ...(check.state === 'grace' && check.reason !== undefined
        ? { graceReason: check.reason }
        : {}),
    }),
  };
}

/**
 * `premium status` — informational, ALWAYS exits 0 (spec acceptance: a
 * pure-OSS install reports cleanly). Reports the stored license's verified
 * state and whether the Premium bundle is installed. Never throws: an absent
 * or unparseable store reads as `none`, a bad license reports `invalid`, and
 * an installed bundle additionally reports the loader handshake (`contract:
 * ok` or the typed refusal) — `loadPremiumBrain` never throws, so the
 * exit-0 contract holds.
 *
 * `opts.publicKeysPem` is the same test/staging-only seam as activate.
 */
export async function cmdPremiumStatus(
  g: GlobalOptions,
  opts?: { publicKeysPem?: readonly string[] },
): Promise<CommandResult> {
  void g; // status is global (home-scoped), not workspace-scoped

  const storedLicense = await readLicenseFile();
  let license: PremiumLicenseView;
  if (storedLicense === null) {
    license = { state: 'none' };
  } else {
    const check = verifyLicenseFile(storedLicense, opts);
    license = { state: check.state };
    if (check.payload !== undefined) {
      license.plan = check.payload.plan;
      license.sub = check.payload.sub;
    }
    if (check.daysLeft !== undefined) license.daysLeft = check.daysLeft;
    if (check.reason !== undefined) license.reason = check.reason;
  }

  const bundle: PremiumBundleView = { installed: false };
  const manifestPath = installedManifestPath();
  if (existsSync(manifestPath)) {
    bundle.installed = true;
    try {
      const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
        const version = (manifest as Record<string, unknown>).version;
        if (typeof version === 'string' && version.trim().length > 0) {
          bundle.version = version;
        }
      }
    } catch {
      // Presence alone marks the bundle installed; a corrupt manifest just
      // loses the version detail — status stays informational, never throws.
    }

    // Loader handshake — never throws, so the exit-0 contract holds even on
    // a broken install. Only meaningful once a manifest exists.
    const load = await loadPremiumBrain(opts);
    bundle.contract = load.status;
    if (load.status !== 'ok') bundle.contractReason = load.reason;
  }

  return {
    data: { ok: true, license, bundle },
    human: renderPremiumStatus(license, bundle),
  };
}

// --- plan -------------------------------------------------------------------

/** Whether a workflow stage runs, is risk-skipped, or hands off to the agent. */
function planStageState(stage: WorkflowStage, risk: RiskLevel): PlanStageView['state'] {
  if (stage === 'execute') return 'handoff';
  const floor = STAGE_MIN_RISK[stage];
  return RISK_LEVELS.indexOf(floor) > RISK_LEVELS.indexOf(risk) ? 'skip' : 'run';
}

/**
 * Select the workflow for a task and emit an ordered plan: the workflow's
 * risk-scaled stage sequence + the compiled implementation stages + the
 * definition of done. Deterministic and tokenless — no execution happens here.
 */
export async function cmdPlan(g: GlobalOptions, task: string): Promise<CommandResult> {
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new DevCortexError('INTERNAL', 'plan requires a non-empty task description.');
  }

  const config = await loadConfig(g.root);
  const graph = await loadOrScanGraph(g.root);
  const packs = matchPacks(graph.stack);

  const risk = classifyRisk(trimmed, graph, config);
  const workflow = selectWorkflow(risk.taskType, risk.riskLevel);
  const intent = compileIntent(trimmed, graph, packs, config);

  const stages: PlanStageView[] = workflow.stages.map((stage) => ({
    stage,
    state: planStageState(stage, risk.riskLevel),
    floor: STAGE_MIN_RISK[stage],
  }));

  return {
    data: {
      ok: true,
      task: trimmed,
      risk: { riskLevel: risk.riskLevel, taskType: risk.taskType },
      workflow: {
        id: workflow.id,
        name: workflow.name,
        taskTypes: workflow.taskTypes,
        minRisk: workflow.minRisk ?? null,
      },
      workflowStages: stages,
      implementationStages: intent.implementationStages,
      acceptanceCriteria: intent.acceptanceCriteria,
      definitionOfDone: intent.definitionOfDone,
    },
    human: renderPlan({
      task: trimmed,
      workflowId: workflow.id,
      workflowName: workflow.name,
      taskType: risk.taskType,
      riskLevel: risk.riskLevel,
      stages,
      implementationStages: intent.implementationStages,
      definitionOfDone: intent.definitionOfDone,
    }),
  };
}

// --- learn ------------------------------------------------------------------

/** Order-preserving de-dupe of absolute artifact paths. */
function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Analyze the evidence ledger + flight recorder for recurring failures and, for
 * each, persist the learned failure and create its diagnosed remedy. Reports the
 * artifacts created. On a clean project (no repeated failures) this is a no-op
 * that reports zero — never an error.
 */
export async function cmdLearn(g: GlobalOptions): Promise<CommandResult> {
  await loadConfig(g.root);

  const failures = await analyzeFailures(g.root);
  const created: string[] = [];
  const learned: LearnFailureView[] = [];

  for (const failure of failures) {
    const result = await learn(g.root, failure);
    created.push(...result.created);
    learned.push({
      id: failure.id,
      signature: failure.signature,
      occurrences: failure.occurrences,
      category: failure.diagnosis.category,
      cause: failure.diagnosis.cause,
      remedyKind: failure.remedyKind,
    });
  }

  const createdRel = uniquePaths(created).map((abs) => relWorkspacePath(g.root, abs));
  const view = { analyzed: failures.length, failures: learned, created: createdRel };
  return { data: { ok: true, ...view }, human: renderLearn(view) };
}

// --- skill ------------------------------------------------------------------

/**
 * Merge the built-in skills with the project's installed/generated skills.
 * A project skill overrides a built-in with the same id; built-ins keep their
 * registry order, and project-only skills follow. The result is stable so
 * recommendation tie-breaks are deterministic.
 */
function mergeSkillManifests(project: readonly SkillManifest[]): SkillManifest[] {
  const resolved = new Map<string, SkillManifest>();
  for (const skill of builtInSkills) resolved.set(skill.id, skill);
  for (const skill of project) resolved.set(skill.id, skill);

  const ordered: SkillManifest[] = [];
  const emitted = new Set<string>();
  for (const skill of builtInSkills) {
    const value = resolved.get(skill.id);
    if (value !== undefined && !emitted.has(skill.id)) {
      ordered.push(value);
      emitted.add(skill.id);
    }
  }
  for (const skill of project) {
    if (!emitted.has(skill.id)) {
      ordered.push(skill);
      emitted.add(skill.id);
    }
  }
  return ordered;
}

/**
 * Does `trigger` appear as a whole word / phrase in the lowercased task text?
 * A whole-token match keeps a short trigger like "ui" from matching "building".
 */
function matchesTrigger(taskLower: string, trigger: string): boolean {
  const needle = trigger.trim().toLowerCase();
  if (needle.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`);
  return re.test(taskLower);
}

export async function cmdSkillList(g: GlobalOptions): Promise<CommandResult> {
  await loadConfig(g.root);
  const project = await new SkillStore(g.root).all();
  const projectIds = new Set(project.map((s) => s.id));
  const merged = mergeSkillManifests(project);

  const items: SkillListItemView[] = merged.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    source: s.source,
    builtIn: s.status === 'built-in',
    installed: projectIds.has(s.id),
  }));
  return { data: { ok: true, count: items.length, skills: items }, human: renderSkillList(items) };
}

export async function cmdSkillRecommend(g: GlobalOptions, task: string): Promise<CommandResult> {
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new DevCortexError('INTERNAL', 'skill recommend requires a non-empty task description.');
  }
  await loadConfig(g.root);
  const project = await new SkillStore(g.root).all();
  const merged = mergeSkillManifests(project);
  const taskLower = trimmed.toLowerCase();

  const scored = merged
    .map((skill) => {
      const matched = skill.triggers.filter((t) => matchesTrigger(taskLower, t));
      return { skill, score: matched.length, matched };
    })
    .filter((r) => r.score > 0)
    // Array.prototype.sort is stable, so equal scores keep merge order
    // (built-in registry order first) — deterministic tie-breaking.
    .sort((a, b) => b.score - a.score);

  const recommendations: SkillRecommendationView[] = scored.map(({ skill, score, matched }) => ({
    id: skill.id,
    name: skill.name,
    score,
    matched,
    status: skill.status,
  }));
  return {
    data: { ok: true, task: trimmed, count: recommendations.length, recommendations },
    human: renderSkillRecommend(trimmed, recommendations),
  };
}

export async function cmdSkillInstall(g: GlobalOptions, id: string): Promise<CommandResult> {
  await loadConfig(g.root);
  const builtin = builtInSkills.find((s) => s.id === id);
  if (builtin === undefined) {
    const available = builtInSkills.map((s) => s.id).join(', ');
    throw new DevCortexError(
      'INTERNAL',
      `Unknown skill "${id}". Installable built-in skills: ${available}.`,
    );
  }

  // Materialize an editable project copy under `.cortex/skills/`. The store
  // validates against the disk contract and writes atomically; bumping
  // updatedAt records when it was installed.
  const store = new SkillStore(g.root);
  const saved = await store.save({ ...builtin, updatedAt: new Date().toISOString() });
  const filePath = relWorkspacePath(g.root, path.join(skillsDir(g.root), `${saved.id}.json`));
  return { data: { ok: true, skill: saved, path: filePath }, human: renderSkillItem(saved, filePath) };
}

// --- workflow ---------------------------------------------------------------

export async function cmdWorkflowList(g: GlobalOptions): Promise<CommandResult> {
  await loadConfig(g.root);
  const workflows = workflowDefinitions.map((def) => ({
    id: def.id,
    name: def.name,
    taskTypes: def.taskTypes,
    minRisk: def.minRisk ?? null,
    stages: def.stages,
  }));
  return {
    data: { ok: true, count: workflows.length, workflows },
    human: renderWorkflowList(workflowDefinitions),
  };
}

/**
 * Run a named workflow against the project and persist a WorkflowRun. Exits 2
 * (NOT_READY) when the run does not complete cleanly (blocked by a gate, or a
 * stage failed) so CI / hooks can gate on it; exits 0 on a completed run.
 */
export async function cmdWorkflowRun(
  g: GlobalOptions,
  id: string,
  task: string,
): Promise<CommandResult> {
  const workflowId = assertEnum<WorkflowId>(id, WORKFLOW_IDS, 'workflow id');
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new DevCortexError('INTERNAL', 'workflow run requires a non-empty task description.');
  }

  const config = await loadConfig(g.root);
  const graph = await loadOrScanGraph(g.root);
  const ledgers = makeLedgers(g.root);

  const run = await runWorkflow(g.root, workflowId, trimmed, {
    graph,
    config,
    ledgers: {
      memory: ledgers.memory,
      feature: ledgers.feature,
      decision: ledgers.decision,
      evidence: ledgers.evidence,
    },
  });

  const notCompleted = run.status !== 'completed';
  return {
    data: { ok: !notCompleted, run },
    human: renderWorkflowRun(run),
    exitCode: notCompleted ? EXIT_NOT_READY : 0,
  };
}

// --- mcp (Safe MCP Manager, §7.19) ------------------------------------------

/**
 * List the MCP servers wired into `.mcp.json` alongside the catalog servers not
 * yet installed (recommended next). Read-only and deterministic.
 */
export async function cmdMcpList(g: GlobalOptions): Promise<CommandResult> {
  await loadConfig(g.root);
  const { installed, recommended } = await listMcp(g.root);
  return {
    data: { ok: true, installed, recommended },
    human: renderMcpList({ installed, recommended }),
  };
}

/**
 * Recommend catalog MCP servers for a task, ranked by task-keyword + project
 * stack match. Deterministic and tokenless (no LLM).
 */
export async function cmdMcpRecommend(g: GlobalOptions, task: string): Promise<CommandResult> {
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new DevCortexError('INTERNAL', 'mcp recommend requires a non-empty task description.');
  }
  await loadConfig(g.root);
  const graph = await loadOrScanGraph(g.root);
  const recommended = recommendMcp(trimmed, graph);
  return {
    data: { ok: true, task: trimmed, count: recommended.length, recommended },
    human: renderMcpRecommend(trimmed, recommended),
  };
}

export interface McpInstallOpts {
  force: boolean;
}

/**
 * Safely install a catalog MCP server by id with a DEFAULT-READ-ONLY posture.
 * Refuses unknown ids (core throws PolicyViolationError → clean exit 1). When the
 * id already exists in `.mcp.json` and `--force` was not given, nothing is
 * written and the status is `exists` — the user re-runs with `--force` to
 * overwrite (a deliberate confirm-before-clobber, exit 0).
 */
export async function cmdMcpInstall(
  g: GlobalOptions,
  id: string,
  opts: McpInstallOpts,
): Promise<CommandResult> {
  await loadConfig(g.root);
  const { status, plan } = await installMcpSafely(g.root, id, { force: opts.force });
  return {
    data: { ok: true, status, plan },
    human: renderMcpInstall({
      id: plan.id,
      status,
      posture: plan.posture,
      specPath: relWorkspacePath(g.root, plan.specPath),
      mcpJsonPath: relWorkspacePath(g.root, plan.mcpJsonPath),
    }),
  };
}

/**
 * Audit every installed MCP server against the firewall policy for
 * write/destructive/secret/ungoverned risks. Informational (always exit 0);
 * `ok` reflects whether the audit came back clean.
 */
export async function cmdMcpAudit(g: GlobalOptions): Promise<CommandResult> {
  await loadConfig(g.root);
  const { findings } = await auditMcp(g.root);
  return {
    data: { ok: findings.length === 0, count: findings.length, findings },
    human: renderMcpAudit(findings),
  };
}

// --- firewall (MCP Security Firewall, §7.20) --------------------------------

/**
 * Print the effective firewall policy. Falls back to the built-in safe defaults
 * when no policy file exists yet; the source (default vs on-disk file) is
 * surfaced so the user knows whether the shown rules are persisted.
 */
export async function cmdFirewallShow(g: GlobalOptions): Promise<CommandResult> {
  await loadConfig(g.root);
  const paths = workspacePaths(g.root);
  const policy = await loadPolicy(g.root);
  const fromFile = existsSync(paths.mcpFirewallPolicy);
  const source = fromFile ? 'file' : 'default';
  const relPath = fromFile ? relWorkspacePath(g.root, paths.mcpFirewallPolicy) : null;
  return {
    data: { ok: true, source, path: relPath, policy },
    human: renderFirewallPolicy({ source, path: relPath, policy }),
  };
}

/**
 * Evaluate a sample tool call against the effective policy and print the
 * verdict, risk score, and reasons. A diagnostic of what the firewall WOULD
 * decide (deny > allow > require-approval + risk escalation), not a gate — so it
 * is informational and always exits 0.
 */
export async function cmdFirewallCheck(
  g: GlobalOptions,
  server: string,
  tool: string,
): Promise<CommandResult> {
  await loadConfig(g.root);
  const policy = await loadPolicy(g.root);
  const call: ToolCall = { server, tool };
  const evaluation = evaluateToolCall(policy, call);
  return {
    data: { ok: true, server, tool, evaluation },
    human: renderFirewallCheck({ server, tool, evaluation }),
  };
}

// --- privacy (Privacy & Redaction Engine, §7.22) ----------------------------

/** What each privacy mode permits + its retention default (mirrors §7.22). */
const PRIVACY_MODE_INFO: Record<
  PrivacyMode,
  { permits: string; retention: string; leavesMachine: boolean }
> = {
  'local-only': {
    permits: 'nothing leaves the machine — all analysis runs locally',
    retention: 'none',
    leavesMachine: false,
  },
  'metadata-cloud': {
    permits: 'only anonymized file type + size leave; contents and paths are withheld',
    retention: '30d',
    leavesMachine: true,
  },
  'deep-cloud': {
    permits: 'file contents may leave for deep analysis, redacted first; every send is disclosed',
    retention: 'ephemeral',
    leavesMachine: true,
  },
};

/**
 * Show the active privacy mode (from the workspace config) alongside what all
 * three modes permit and their retention, so the user can see exactly what may
 * leave the machine.
 */
export async function cmdPrivacyStatus(g: GlobalOptions): Promise<CommandResult> {
  const config = await loadConfig(g.root);
  const active = config.privacy;
  const modes = PRIVACY_MODES.map((mode) => ({
    mode,
    active: mode === active,
    permits: PRIVACY_MODE_INFO[mode].permits,
    retention: PRIVACY_MODE_INFO[mode].retention,
    leavesMachine: PRIVACY_MODE_INFO[mode].leavesMachine,
  }));
  return {
    data: { ok: true, mode: active, modes },
    human: renderPrivacyStatus({ active, modes }),
  };
}

/**
 * Print a redaction summary for a file: how many secret/PII occurrences the
 * redaction engine would mask, broken down by kind. Deterministic and tokenless;
 * the (redacted or raw) file contents are never printed — only the tally.
 */
export async function cmdPrivacyRedact(g: GlobalOptions, file: string): Promise<CommandResult> {
  await loadConfig(g.root);

  const target = file.trim();
  if (target.length === 0) {
    throw new DevCortexError('INTERNAL', 'privacy redact requires a file path.');
  }
  const abs = path.isAbsolute(target) ? target : path.resolve(g.root, target);

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch (err) {
    throw new DevCortexError('INTERNAL', `Cannot redact "${target}": no such file.`, { cause: err });
  }
  if (!info.isFile()) {
    throw new DevCortexError('INTERNAL', `Cannot redact "${target}": not a regular file.`);
  }

  let contents: string;
  try {
    contents = await readFile(abs, 'utf8');
  } catch (err) {
    throw new DevCortexError('INTERNAL', `Cannot read "${target}".`, { cause: err });
  }

  const { redacted, findings } = redactText(contents);
  const totalMasked = findings.reduce((sum, finding) => sum + finding.count, 0);
  const originalBytes = Buffer.byteLength(contents, 'utf8');
  const redactedBytes = Buffer.byteLength(redacted, 'utf8');
  const relFile = relWorkspacePath(g.root, abs);

  return {
    data: { ok: true, file: relFile, totalMasked, findings, originalBytes, redactedBytes },
    human: renderPrivacyRedact({ file: relFile, findings, totalMasked, originalBytes, redactedBytes }),
  };
}

// --- host hooks (Claude Code PreToolUse / PostToolUse) ----------------------
//
// `guard` and `record-evidence` back the generated hook shims (see
// @devcortex/claude-code templates: `devcortex guard --json` on PreToolUse,
// `devcortex record-evidence --json` on PostToolUse). They consume a normalized
// HookPayload and return a HookOutcome; the cli.ts wrapper guarantees the
// fail-open contract (any throw → exit 0, never block).

/** Repo-relative POSIX form of a (possibly absolute) tool target path. */
function toRepoRelative(root: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  if (rel.length === 0) return filePath.replace(/\\/g, '/');
  return rel.split(path.sep).join('/');
}

/** Protected paths are high-risk by definition; never classify one below `high`. */
function atLeastHigh(risk: RiskLevel): RiskLevel {
  return RISK_LEVELS.indexOf(risk) >= RISK_LEVELS.indexOf('high') ? risk : 'high';
}

function guardAllow(detail: Record<string, unknown>): HookOutcome {
  return { blocked: false, data: { ok: true, blocked: false, ...detail } };
}

/** The explanation surfaced to the host agent when a guarded edit is blocked. */
function buildGuardBlockMessage(
  toolName: string,
  relPath: string,
  risk: RiskLevel,
  classification: RiskClassification,
): string {
  return [
    `DevCortex GUARD blocked ${toolName} to a protected path: ${relPath}`,
    `  Risk: ${risk.toUpperCase()} (${classification.taskType}) — this path matches a protected-path policy in .cortex/config.yaml.`,
    '  What could break: protected paths cover authentication, billing, middleware, database migrations, env files and secrets. An unreviewed edit here can break login/authorization, leak credentials, corrupt or drop data, reroute every request, or take production down.',
    classification.signals.length > 0 ? `  Signals: ${classification.signals.join('; ')}` : '',
    '  How to proceed: make the change deliberately, then prove it with `devcortex verify` / `devcortex ship`. To stop guarding this edit, set `mode: passive` in .cortex/config.yaml, or remove the matching glob from `risk.protectedPaths`.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export async function cmdGuard(g: GlobalOptions, payload: HookPayload): Promise<HookOutcome> {
  const toolName = payload.toolName ?? 'tool';

  // Load the workspace config. An uninitialized repo throws CONFIG_NOT_FOUND,
  // which the fail-open wrapper turns into "allow" — DevCortex only guards repos
  // that have opted in via `devcortex init`.
  const config = await loadConfig(g.root);

  // PASSIVE mode observes only — it never blocks.
  if (config.mode === 'passive') {
    return guardAllow({ mode: config.mode, tool: toolName, reason: 'passive-mode' });
  }

  // Only file-mutating tools carry a target path. A Bash command (or any tool
  // without a concrete path) has nothing path-based to guard → allow.
  if (payload.filePath === undefined) {
    return guardAllow({ mode: config.mode, tool: toolName, reason: 'no-target-path' });
  }

  const relPath = toRepoRelative(g.root, payload.filePath);
  if (!isProtected(relPath, config)) {
    return guardAllow({
      mode: config.mode,
      tool: toolName,
      path: relPath,
      reason: 'unprotected-path',
    });
  }

  // Protected path: classify the edit, floor it to `high` (protected paths are
  // high-risk by definition), and let the operating mode decide.
  const graph = await loadOrScanGraph(g.root);
  const classification = classifyRisk(`${toolName} ${relPath}`, graph, config);
  const risk = atLeastHigh(classification.riskLevel);

  if (!shouldBlock(config.mode, risk)) {
    return guardAllow({
      mode: config.mode,
      tool: toolName,
      path: relPath,
      risk,
      reason: 'below-block-threshold',
    });
  }

  return {
    blocked: true,
    message: buildGuardBlockMessage(toolName, relPath, risk, classification),
    data: {
      ok: false,
      blocked: true,
      mode: config.mode,
      tool: toolName,
      path: relPath,
      risk,
      taskType: classification.taskType,
      rationale: classification.rationale,
    },
  };
}

const MAX_EVIDENCE_OUTPUT = 4000;

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…(${text.length - max} more chars truncated)`;
}

/** Pull an integer exit code + combined output from a Bash tool_response, if present. */
function readCommandResult(response: Record<string, unknown> | undefined): {
  exitCode?: number;
  output?: string;
} {
  if (response === undefined) return {};

  let exitCode: number | undefined;
  for (const key of ['exitCode', 'exit_code', 'returncode', 'code'] as const) {
    const value = response[key];
    if (typeof value === 'number' && Number.isInteger(value)) {
      exitCode = value;
      break;
    }
  }

  const parts: string[] = [];
  for (const key of ['stdout', 'stderr', 'output'] as const) {
    const value = response[key];
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  }
  const combined = parts.join('\n').trim();

  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(combined.length > 0 ? { output: truncate(combined, MAX_EVIDENCE_OUTPUT) } : {}),
  };
}

export async function cmdRecordEvidence(
  g: GlobalOptions,
  payload: HookPayload,
): Promise<HookOutcome> {
  // Require an initialized workspace; an uninitialized repo throws and the
  // fail-open wrapper degrades to a silent no-op (exit 0).
  await loadConfig(g.root);
  const ledgers = makeLedgers(g.root);

  const toolName = payload.toolName ?? 'tool';
  let input: EvidenceInput;

  if (payload.filePath !== undefined) {
    const relPath = toRepoRelative(g.root, payload.filePath);
    input = {
      claim: `${toolName} modified ${relPath}`,
      status: 'unverified',
      kind: 'file',
      detail: `PostToolUse: ${toolName} reported a mutation of ${relPath}. Recorded as provenance; correctness is verified separately by the quality gate (devcortex verify / ship).`,
    };
  } else if (payload.command !== undefined) {
    const { exitCode, output } = readCommandResult(payload.toolResponse);
    const status: EvidenceStatus =
      exitCode === undefined ? 'unverified' : exitCode === 0 ? 'verified' : 'refuted';
    input = {
      claim: `${toolName} ran: ${truncate(payload.command, 200)}`,
      status,
      kind: 'command',
      detail:
        exitCode === undefined
          ? `PostToolUse: ${toolName} ran a command (no exit code reported).`
          : `PostToolUse: ${toolName} ran a command that exited ${exitCode}.`,
      command: payload.command,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  } else {
    input = {
      claim: `${toolName} tool invoked`,
      status: 'unverified',
      kind: 'runtime',
      detail: `PostToolUse: ${toolName} was invoked with no file path or command to record.`,
    };
  }

  const item = await ledgers.evidence.add(input);
  return {
    blocked: false,
    data: { ok: true, recorded: true, evidenceId: item.id, kind: item.kind, status: item.status },
  };
}

// --- distill (Stop hook; fail-open) -----------------------------------------
//
// `distill` backs the generated devcortex-distill.sh hook shim (see
// @devcortex/claude-code templates). It runs before the ship gate on every
// Stop event, extracting a run record and observed memory candidates from the
// session transcript. The command is always passive (never blocks) and is
// wrapped by the same fail-open `runHookAction` wrapper as guard / record-evidence.

export async function cmdDistill(
  g: GlobalOptions,
  payload: HookPayload & { transcriptOverride?: string },
): Promise<HookOutcome> {
  const transcript = payload.transcriptOverride ?? payload.transcriptPath;
  if (transcript === undefined) {
    return { blocked: false, data: { ok: true, skipped: 'no transcript in payload' } };
  }
  const outcome = await distillTranscript(g.root, transcript);
  return { blocked: false, data: { ok: true, ...outcome } };
}

// re-export emit so cli.ts has a single import surface for the wiring layer.
export { emit };
