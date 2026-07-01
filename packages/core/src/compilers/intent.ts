/**
 * `compileIntent` — turn a vague free-text task into a precise, deterministic
 * engineering contract (`IntentContract`).
 *
 * It is tokenless: every field is derived from the project graph, the matched
 * stack packs, the gate configuration, and the deterministic risk + blast-radius
 * engines. Nothing is invented silently — wherever the compiler has to guess
 * (e.g. it infers the likely-affected files from the task wording), it records
 * the guess explicitly in `assumptions`.
 *
 * Pipeline:
 *   1. classifyRisk(task, graph, config)        → taskType + riskLevel + signals
 *   2. relevantFiles(graph, task)               → the files the task is "about"
 *   3. analyzeBlastRadius(graph, those, config) → what could break if they change
 *   4. matched stack packs + gate config        → acceptance + definition-of-done
 *   5. risk/taskType                            → staged plan + verification plan
 */
import type {
  CortexConfig,
  FileKind,
  FileNode,
  IntentContract,
  ProjectGraph,
  RiskLevel,
  Rule,
  StackPack,
  TaskType,
} from '../domain/index';
import { DevCortexError } from '../domain/index';
import { relevantFiles } from '../graph';
import { classifyRisk, depthForRisk } from '../policy';
import { analyzeBlastRadius } from '../blast-radius';

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** True when `a` is at least as severe as `b`. */
function isAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_RANK[a] >= RISK_RANK[b];
}

/** Number of relevant files used as the proxy "change set" for blast radius. */
const MAX_CANDIDATE_FILES = 12;

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Package-manager-aware way to invoke an npm script. */
function scriptInvocation(pm: string, script: string): string {
  if (pm === 'pnpm' || pm === 'yarn' || pm === 'bun') return `${pm} ${script}`;
  return `npm run ${script}`;
}

/**
 * Resolve the command for a single gate, preferring an explicit override in
 * `config.commands`, then a matching npm script, then a sensible generic.
 */
function gateCommand(
  gate: 'typecheck' | 'lint' | 'build' | 'test',
  config: CortexConfig,
  graph: ProjectGraph,
  generic: string,
): string {
  const override = config.commands[gate];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  const script = graph.scripts[gate];
  if (typeof script === 'string' && script.trim().length > 0) {
    return scriptInvocation(graph.stack.packageManager, gate);
  }
  return generic;
}

/** A short, human-readable goal line derived from the raw task. */
function buildGoal(task: string): string {
  const normalized = task.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : 'Unspecified task';
}

/** A rule applies when it has no `appliesTo` filter or it overlaps the touched kinds. */
function ruleApplies(rule: Rule, touchedKinds: ReadonlySet<FileKind>): boolean {
  if (rule.appliesTo === undefined || rule.appliesTo.length === 0) return true;
  return rule.appliesTo.some((kind) => touchedKinds.has(kind));
}

/**
 * Build the {@link IntentContract} for a task.
 *
 * @throws DevCortexError('INTERNAL') when `task` is not a non-empty string, or
 *   when `graph`/`packs`/`config` are structurally invalid.
 */
export function compileIntent(
  task: string,
  graph: ProjectGraph,
  packs: StackPack[],
  config: CortexConfig,
): IntentContract {
  if (typeof task !== 'string' || task.trim().length === 0) {
    throw new DevCortexError('INTERNAL', 'compileIntent: task must be a non-empty string');
  }
  if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.files)) {
    throw new DevCortexError('INTERNAL', 'compileIntent: graph must be a ProjectGraph');
  }
  if (!Array.isArray(packs)) {
    throw new DevCortexError('INTERNAL', 'compileIntent: packs must be a StackPack[]');
  }
  if (config === null || typeof config !== 'object' || config.risk === undefined) {
    throw new DevCortexError('INTERNAL', 'compileIntent: config must be a CortexConfig');
  }

  // 1. Risk + task type (deterministic keyword + affected-file analysis).
  const classification = classifyRisk(task, graph, config);
  const { taskType, riskLevel } = classification;
  const recommendedDepth = depthForRisk(riskLevel);
  const highRisk = isAtLeast(riskLevel, 'high');

  // 2. Files the task is plausibly about → proxy change set for the blast radius.
  const ranked = relevantFiles(graph, task);
  const candidateFiles: FileNode[] = ranked.slice(0, MAX_CANDIDATE_FILES);
  const candidatePaths = candidateFiles.map((f) => f.path);
  const touchedKinds = new Set<FileKind>(candidateFiles.map((f) => f.kind));

  // 3. Blast radius over the proxy change set.
  const blast = analyzeBlastRadius(graph, candidatePaths, config);

  const assumptions: string[] = [];

  // --- affected areas (graph + blast radius) --------------------------------
  const affectedAreas: string[] = [];
  for (const path of candidatePaths) affectedAreas.push(path);
  if (blast.affectsAuth) affectedAreas.push('Authentication & session handling');
  if (blast.affectsBilling) affectedAreas.push('Billing & payment flows');
  for (const route of blast.affectedRoutes) affectedAreas.push(`route ${route}`);
  for (const api of blast.affectedApi) affectedAreas.push(`api ${api}`);
  for (const table of blast.affectedTables) affectedAreas.push(`database surface ${table}`);
  for (const env of blast.affectedEnvVars) affectedAreas.push(`env var ${env}`);
  if (affectedAreas.length === 0) {
    affectedAreas.push(`${taskType} surface (no existing files matched the task wording)`);
  }

  // --- non-goals (surfaces present in the repo but NOT in the blast radius) --
  const hasKind = (kind: FileKind): boolean => graph.files.some((f) => f.kind === kind);
  const nonGoals: string[] = [];
  if (hasKind('auth') && !blast.affectsAuth) {
    nonGoals.push('Do not modify authentication, sessions, or access control.');
  }
  if (hasKind('billing') && !blast.affectsBilling) {
    nonGoals.push('Do not modify billing or payment flows.');
  }
  if ((hasKind('migration') || hasKind('schema')) && blast.affectedTables.length === 0) {
    nonGoals.push('Do not alter database migrations or schema.');
  }
  if (hasKind('middleware') && !blast.fragileAreas.some((p) => p.includes('middleware'))) {
    nonGoals.push('Do not change global middleware behavior.');
  }
  nonGoals.push('Do not expand scope beyond the affected areas listed in this contract.');

  // --- regression risks (from the blast radius) -----------------------------
  const regressionRisks: string[] = [];
  if (blast.affectsAuth) regressionRisks.push('Auth/session regression across protected routes.');
  if (blast.affectsBilling) {
    regressionRisks.push('Billing regression: checkout, webhooks, or subscription state.');
  }
  if (blast.affectedTables.length > 0) {
    regressionRisks.push('Schema/data migration risk on the affected database surfaces.');
  }
  if (blast.affectedRoutes.length > 0 || blast.affectedApi.length > 0) {
    regressionRisks.push('Behavior change on dependent routes/endpoints.');
  }
  for (const fragile of blast.fragileAreas) {
    regressionRisks.push(`Fragile area in the blast radius: ${fragile}.`);
  }
  if (regressionRisks.length === 0) {
    regressionRisks.push('No high-impact surfaces detected in the blast radius.');
  }

  // --- required context -----------------------------------------------------
  const requiredContext: string[] = [];
  requiredContext.push(`Compile the context pack at "${recommendedDepth}" depth before editing.`);
  for (const path of candidatePaths) requiredContext.push(`Read: ${path}`);
  for (const pack of packs) requiredContext.push(`Apply stack guidance: ${pack.name}.`);
  if (candidatePaths.length === 0) {
    requiredContext.push('No existing files matched; gather context for a new addition.');
  }

  // --- acceptance criteria (matched packs + gate config + blast radius) ------
  const acceptanceCriteria: string[] = [];
  for (const pack of packs) {
    for (const rule of pack.bestPractices) {
      if (ruleApplies(rule, touchedKinds) && isAtLeast(rule.severity, 'high')) {
        acceptanceCriteria.push(`Follows "${rule.title}".`);
      }
    }
  }
  for (const check of blast.requiredChecks) acceptanceCriteria.push(`Verified: ${check}.`);
  if (config.gates.typecheck) acceptanceCriteria.push('Typecheck passes with zero errors.');
  if (config.gates.lint) acceptanceCriteria.push('Lint passes with zero errors.');
  if (config.gates.build) acceptanceCriteria.push('Production build completes successfully.');
  if (config.gates.test) acceptanceCriteria.push('All tests pass, including new coverage.');
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push('Implements the stated goal without regressing existing behavior.');
  }

  // --- implementation stages (risk + task-type tailored) --------------------
  const implementationStages: string[] = [
    'Review the required context (relevant files, prior features, decisions, known failures).',
  ];
  if (highRisk) {
    implementationStages.push('Write a short plan and add failing tests for the new behavior first.');
  }
  implementationStages.push(taskStage(taskType));
  implementationStages.push('Add or update tests covering the new behavior and the listed regression risks.');
  implementationStages.push('Run the quality gates and record evidence for each verified claim.');
  if (highRisk) {
    implementationStages.push('Re-check auth/billing/migration surfaces in the blast radius before shipping.');
  }

  // --- verification plan (blast-radius checks + gate commands) --------------
  const verificationPlan: string[] = [];
  for (const check of blast.requiredChecks) verificationPlan.push(check);
  if (config.gates.typecheck) {
    verificationPlan.push(`Run ${gateCommand('typecheck', config, graph, 'tsc --noEmit')}.`);
  }
  if (config.gates.lint) {
    verificationPlan.push(`Run ${gateCommand('lint', config, graph, 'eslint .')}.`);
  }
  if (config.gates.build) {
    verificationPlan.push(`Run ${gateCommand('build', config, graph, 'the production build')}.`);
  }
  if (config.gates.test) {
    verificationPlan.push(`Run ${gateCommand('test', config, graph, 'the test suite')}.`);
  }
  if (config.gates.blockUnprovenDone) {
    verificationPlan.push('Record an EvidenceItem per claim; block "done" on any unproven required check.');
  }
  if (verificationPlan.length === 0) {
    verificationPlan.push('Manually verify the goal is met and nothing else changed.');
  }

  // --- definition of done (gate config + matched packs) ---------------------
  const definitionOfDone: string[] = [];
  if (config.gates.typecheck) {
    definitionOfDone.push(`\`${gateCommand('typecheck', config, graph, 'tsc --noEmit')}\` passes.`);
  }
  if (config.gates.lint) {
    definitionOfDone.push(`\`${gateCommand('lint', config, graph, 'eslint .')}\` passes.`);
  }
  if (config.gates.build) {
    definitionOfDone.push(`\`${gateCommand('build', config, graph, 'build')}\` succeeds.`);
  }
  if (config.gates.test) {
    definitionOfDone.push(`\`${gateCommand('test', config, graph, 'test')}\` is green.`);
  }
  if (packs.length > 0) definitionOfDone.push('All applicable stack-pack quality gates are satisfied.');
  definitionOfDone.push('Every acceptance criterion above is met.');
  if (config.gates.blockUnprovenDone) {
    definitionOfDone.push('Evidence is recorded for each required check (unproven "done" is blocked).');
  }

  // --- assumptions (record guesses explicitly) ------------------------------
  if (candidatePaths.length === 0) {
    assumptions.push('No existing files clearly match the task; treated as a new addition.');
  }
  assumptions.push(
    'Affected areas and regression risks were inferred from files matching the task wording; the actual change set may differ.',
  );
  if (packs.length === 0) {
    assumptions.push(
      `No stack pack matched framework "${graph.stack.framework}"; using generic engineering guidance only.`,
    );
  }
  if (classification.signals.includes('no risk keywords detected')) {
    assumptions.push('Task wording carried no explicit risk keywords; risk derives from affected files only.');
  }
  const floor = config.risk.floors[taskType];
  if (floor !== undefined && isAtLeast(riskLevel, floor)) {
    assumptions.push(`Risk floor for task type "${taskType}" (${floor}) was considered.`);
  }

  return {
    goal: buildGoal(task),
    nonGoals: dedupe(nonGoals),
    taskType,
    riskLevel,
    affectedAreas: dedupe(affectedAreas),
    requiredContext: dedupe(requiredContext),
    acceptanceCriteria: dedupe(acceptanceCriteria),
    regressionRisks: dedupe(regressionRisks),
    implementationStages: dedupe(implementationStages),
    verificationPlan: dedupe(verificationPlan),
    definitionOfDone: dedupe(definitionOfDone),
    assumptions: dedupe(assumptions),
  };
}

/** The single task-type-specific implementation stage. */
function taskStage(taskType: TaskType): string {
  switch (taskType) {
    case 'billing':
      return 'Implement Stripe flows server-side; verify webhooks against the raw body and dedupe on event.id.';
    case 'auth':
      return 'Implement auth server-side; verify identity on the server and never trust client-supplied state.';
    case 'database':
      return 'Write a reversible migration with a tested down path; never edit an already-applied migration.';
    case 'security':
      return 'Implement the hardening with validated inputs and least-privilege access; add a regression test.';
    case 'api':
      return 'Implement the endpoint with input validation and an ownership/authorization check.';
    case 'ui':
      return 'Implement the component, keeping secrets and data fetching on the server.';
    case 'devops':
      return 'Apply the infrastructure change behind a reversible, reviewed step; verify against a non-prod target first.';
    case 'release':
      return 'Cut the release behind a passing gate; tag, changelog, and verify the published artifact.';
    case 'dependency':
      return 'Update the dependency, regenerate the lockfile, and run the full gate to catch breaking changes.';
    case 'bugfix':
      return 'Reproduce the bug with a failing test, then implement the minimal fix in the affected files.';
    case 'refactor':
      return 'Refactor behind the existing tests; keep behavior identical and verify no public surface changed.';
    case 'test':
      return 'Add the missing tests against real behavior; avoid mocking away the logic under test.';
    case 'docs':
      return 'Update the documentation to match the current behavior; verify examples actually run.';
    case 'feature':
      return 'Implement the feature in the affected files behind validated inputs and tests.';
    case 'chore':
      return 'Apply the change in the affected files and verify nothing else moved.';
    default: {
      const exhaustive: never = taskType;
      throw new DevCortexError('INTERNAL', `Unhandled task type: ${String(exhaustive)}`);
    }
  }
}
