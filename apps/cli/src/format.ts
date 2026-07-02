// ============================================================================
// Human-readable rendering for the DevCortex CLI.
//
// Pure functions only — each takes already-computed engine data and returns a
// styled string. picocolors auto-disables colour when stdout is not a TTY (and
// under NO_COLOR), so piped/captured output is plain text and assertable.
// ============================================================================

import pc from 'picocolors';

import type {
  BlastRadius,
  CheckResult,
  ContextPack,
  DecisionRecord,
  DetectedStack,
  EvidenceItem,
  FeatureRecord,
  FirewallDecision,
  GateFamily,
  GateResult,
  InstallStatus,
  IntentContract,
  McpPolicy,
  McpServerSpec,
  McpTrust,
  MemoryItem,
  PrivacyMode,
  ProjectGraph,
  RedactionFinding,
  RiskClassification,
  RiskLevel,
  ShipReport,
  ShipStatus,
  SkillManifest,
  SkillStatus,
  StageStatus,
  ToolCallEval,
  UiQualityScore,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStage,
} from '@devcortex/core';
import type { InstallResult } from '@devcortex/claude-code';

const RULE = pc.dim('─'.repeat(56));

function heading(title: string): string {
  return `${pc.bold(pc.cyan(title))}\n${RULE}`;
}

function label(text: string, width = 13): string {
  return pc.dim(text.padEnd(width));
}

function bullets(items: readonly string[], indent = '  '): string {
  if (items.length === 0) return `${indent}${pc.dim('(none)')}`;
  return items.map((item) => `${indent}${pc.dim('•')} ${item}`).join('\n');
}

function numbered(items: readonly string[], indent = '  '): string {
  if (items.length === 0) return `${indent}${pc.dim('(none)')}`;
  return items.map((item, i) => `${indent}${pc.dim(`${i + 1}.`)} ${item}`).join('\n');
}

/** Colour a risk level by severity; always upper-cased for scanability. */
export function riskTag(level: RiskLevel): string {
  const text = level.toUpperCase();
  switch (level) {
    case 'low':
      return pc.green(text);
    case 'medium':
      return pc.yellow(text);
    case 'high':
      return pc.red(text);
    case 'critical':
      return pc.bold(pc.red(text));
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

function statusTag(status: ShipStatus): string {
  switch (status) {
    case 'READY':
      return pc.bold(pc.green(status));
    case 'READY_WITH_WARNINGS':
      return pc.bold(pc.yellow(status));
    case 'NOT_READY':
      return pc.bold(pc.red(status));
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function yesNo(flag: boolean): string {
  return flag ? pc.red('AFFECTED') : pc.dim('—');
}

function listOrDash(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : pc.dim('—');
}

// --- preflight --------------------------------------------------------------

export interface PreflightView {
  task: string;
  risk: RiskClassification;
  /** null when blast radius was skipped because the pipeline exceeded the latency budget. */
  blast: BlastRadius | null;
  intent: IntentContract;
  context: ContextPack;
}

export function renderPreflight(view: PreflightView): string {
  const { task, risk, blast, intent, context } = view;
  const lines: string[] = [
    heading('CORTEX PREFLIGHT'),
    `${label('Task')}${task}`,
    `${label('Type · Risk')}${risk.taskType} · ${riskTag(risk.riskLevel)}`,
    `${label('Signals')}${listOrDash(risk.signals)}`,
    `${label('Goal')}${intent.goal}`,
    '',
  ];

  if (blast === null) {
    lines.push(`${pc.bold('Blast radius')}  ${pc.dim('(blast radius skipped — over time budget)')}`);
  } else {
    lines.push(
      `${pc.bold('Blast radius')}  severity ${riskTag(blast.severity)}`,
      `  ${label('routes')}${listOrDash(blast.affectedRoutes)}`,
      `  ${label('components')}${listOrDash(blast.affectedComponents)}`,
      `  ${label('api')}${listOrDash(blast.affectedApi)}`,
      `  ${label('tables')}${listOrDash(blast.affectedTables)}`,
      `  ${label('auth')}${yesNo(blast.affectsAuth)}`,
      `  ${label('billing')}${yesNo(blast.affectsBilling)}`,
      `  ${label('env vars')}${listOrDash(blast.affectedEnvVars)}`,
      `  ${label('checks')}${listOrDash(blast.requiredChecks)}`,
    );
    if (blast.fragileAreas.length > 0) {
      lines.push(`  ${label('fragile')}${blast.fragileAreas.join(', ')}`);
    }
  }

  lines.push(
    '',
    pc.bold('Definition of done'),
    bullets(intent.definitionOfDone),
    '',
    pc.bold('Acceptance criteria'),
    bullets(intent.acceptanceCriteria),
    '',
    `${pc.bold('Context pack')}  ${context.depth} · ~${context.tokenEstimate} tok`,
    context.markdown.trimEnd(),
  );

  return lines.join('\n');
}

// --- ship -------------------------------------------------------------------

export interface ShipView {
  report: ShipReport;
  blocked: boolean;
  reasons: string[];
  reportPath: string;
}

function checkLine(check: CheckResult, ok: boolean): string {
  const mark = ok ? pc.green('✓') : pc.red('✗');
  return `  ${mark} ${pc.bold(check.name)} ${pc.dim('—')} ${check.detail}`;
}

export function renderShipStatus(view: ShipView): string {
  const { report, blocked, reasons, reportPath } = view;
  const lines: string[] = [
    heading('CORTEX SHIP STATUS'),
    `${label('Status')}${statusTag(report.status)}`,
    '',
    pc.bold(`Passed (${report.passed.length})`),
  ];

  lines.push(
    report.passed.length > 0
      ? report.passed.map((c) => checkLine(c, true)).join('\n')
      : `  ${pc.dim('(none)')}`,
  );

  lines.push('', pc.bold(`Blocked (${report.blocked.length})`));
  lines.push(
    report.blocked.length > 0
      ? report.blocked.map((c) => checkLine(c, false)).join('\n')
      : `  ${pc.dim('(none)')}`,
  );

  if (report.warnings.length > 0) {
    lines.push('', pc.bold(`Warnings (${report.warnings.length})`));
    lines.push(report.warnings.map((w) => `  ${pc.yellow('!')} ${w}`).join('\n'));
  }

  if (blocked && reasons.length > 0) {
    lines.push('', pc.bold(pc.red('Unproven "done" is blocked')));
    lines.push(reasons.map((r) => `  ${pc.red('✗')} ${r}`).join('\n'));
  }

  if (report.suggestedPrompt !== undefined && report.suggestedPrompt.length > 0) {
    lines.push('', pc.bold('Suggested next step'), `  ${report.suggestedPrompt}`);
  }

  lines.push('', `${label('Report')}${pc.dim(reportPath)}`);
  return lines.join('\n');
}

// --- scan / init ------------------------------------------------------------

function stackSummary(stack: DetectedStack): string {
  const version = stack.frameworkVersion !== undefined ? ` ${stack.frameworkVersion}` : '';
  const mono = stack.monorepo ? ' · monorepo' : '';
  return `${stack.framework}${version} · ${stack.language} · ${stack.packageManager}${mono}`;
}

export function renderScan(graph: ProjectGraph): string {
  const s = graph.stats;
  return [
    heading('CORTEX SCAN'),
    `${label('Stack')}${stackSummary(graph.stack)}`,
    `${label('Files')}${s.fileCount}`,
    `${label('Routes')}${s.routeCount} (${s.apiCount} api)`,
    `${label('Tests')}${s.testCount}`,
    `${label('Risky')}${s.riskyCount}`,
    `${label('Env vars')}${graph.envVars.length}`,
    `${label('Scripts')}${listOrDash(Object.keys(graph.scripts))}`,
  ].join('\n');
}

export function renderInit(created: readonly string[], graph: ProjectGraph): string {
  return [
    heading('CORTEX INIT'),
    `${label('Stack')}${stackSummary(graph.stack)}`,
    `${label('Files')}${graph.stats.fileCount} scanned`,
    '',
    pc.bold(`Created (${created.length})`),
    bullets(created),
    '',
    pc.dim('Next: `devcortex install claude` · `devcortex preflight "<task>"`'),
  ].join('\n');
}

// --- doctor -----------------------------------------------------------------

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

function doctorMark(status: DoctorStatus): string {
  switch (status) {
    case 'ok':
      return pc.green('✓');
    case 'warn':
      return pc.yellow('!');
    case 'fail':
      return pc.red('✗');
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function renderDoctor(checks: readonly DoctorCheck[]): string {
  const lines = [heading('CORTEX DOCTOR')];
  for (const check of checks) {
    lines.push(`${doctorMark(check.status)} ${pc.bold(check.name)} ${pc.dim('—')} ${check.detail}`);
  }
  return lines.join('\n');
}

// --- context ----------------------------------------------------------------

export function renderContext(pack: ContextPack): string {
  return [
    heading('CORTEX CONTEXT'),
    `${label('Depth')}${pack.depth} · ~${pack.tokenEstimate} tok`,
    `${label('Files')}${listOrDash(pack.relevantFiles)}`,
    '',
    pack.markdown.trimEnd(),
  ].join('\n');
}

// --- verify -----------------------------------------------------------------

export function renderVerify(result: GateResult): string {
  const lines = [
    heading('CORTEX VERIFY'),
    `${label('Gate')}${result.gate}`,
    `${label('Result')}${result.passed ? pc.green('PASS') : pc.red('FAIL')}`,
    '',
    pc.bold(`Checks (${result.checks.length})`),
  ];
  for (const check of result.checks) {
    lines.push(checkLine(check, check.passed));
  }
  return lines.join('\n');
}

// --- memory -----------------------------------------------------------------

export function renderMemoryList(items: readonly MemoryItem[]): string {
  const lines = [heading(`MEMORY LEDGER (${items.length})`)];
  if (items.length === 0) {
    lines.push(pc.dim('  (empty — `devcortex memory add --title ... --summary ...`)'));
    return lines.join('\n');
  }
  for (const item of items) {
    lines.push(
      `${pc.dim(item.id.slice(0, 8))} ${pc.bold(item.title)} ${pc.dim(`[${item.type}]`)} ${riskTag(item.riskLevel)}`,
    );
  }
  return lines.join('\n');
}

export function renderMemoryItem(item: MemoryItem): string {
  return [
    heading('MEMORY ITEM'),
    `${label('Id')}${item.id}`,
    `${label('Type')}${item.type}`,
    `${label('Title')}${item.title}`,
    `${label('Summary')}${item.summary}`,
    `${label('Source')}${item.source}`,
    `${label('Confidence')}${item.confidence}`,
    `${label('Risk')}${riskTag(item.riskLevel)}`,
    `${label('Files')}${listOrDash(item.relatedFiles)}`,
    `${label('Features')}${listOrDash(item.relatedFeatures)}`,
    `${label('Created')}${item.createdAt}`,
    `${label('Updated')}${item.updatedAt}`,
  ].join('\n');
}

// --- feature ----------------------------------------------------------------

export function renderFeatureList(items: readonly FeatureRecord[]): string {
  const lines = [heading(`FEATURE LEDGER (${items.length})`)];
  if (items.length === 0) {
    lines.push(pc.dim('  (empty — `devcortex feature add --name ... --purpose ...`)'));
    return lines.join('\n');
  }
  for (const item of items) {
    lines.push(`${pc.dim(item.id.slice(0, 8))} ${pc.bold(item.feature)} ${pc.dim(`[${item.status}]`)}`);
  }
  return lines.join('\n');
}

export function renderFeatureItem(item: FeatureRecord): string {
  return [
    heading('FEATURE RECORD'),
    `${label('Id')}${item.id}`,
    `${label('Feature')}${item.feature}`,
    `${label('Status')}${item.status}`,
    `${label('Purpose')}${item.purpose}`,
    `${label('User value')}${item.userValue}`,
    `${label('Routes')}${listOrDash(item.routes)}`,
    `${label('Components')}${listOrDash(item.components)}`,
    `${label('API')}${listOrDash(item.apiEndpoints)}`,
    `${label('Tables')}${listOrDash(item.databaseTables)}`,
    `${label('Env vars')}${listOrDash(item.envVars)}`,
    `${label('Acceptance')}`,
    bullets(item.acceptanceCriteria),
    `${label('Known risks')}`,
    bullets(item.knownRisks),
  ].join('\n');
}

export function renderDecision(item: DecisionRecord): string {
  return [
    heading('DECISION RECORD'),
    `${label('Id')}${item.id}`,
    `${label('Decision')}${item.decision}`,
    `${label('Status')}${item.status}`,
    `${label('Chosen')}${item.chosenOption}`,
    `${label('Reason')}${item.reason}`,
  ].join('\n');
}

// --- install ----------------------------------------------------------------

export function renderInstall(result: InstallResult, note?: string): string {
  if (result.status === 'plan') {
    const lines = [
      heading('CORTEX INSTALL — PLAN'),
      pc.yellow(result.reason),
      '',
      pc.bold(`Would change (${result.plan.length})`),
    ];
    for (const item of result.plan) {
      lines.push(`  ${pc.cyan(item.action.padEnd(9))} ${item.path}`);
      lines.push(`            ${pc.dim(item.reason)}`);
    }
    lines.push('', pc.dim('Re-run with `--force` to apply.'));
    return lines.join('\n');
  }

  const lines = [heading('CORTEX INSTALL — APPLIED'), pc.bold(`Files (${result.files.length})`)];
  for (const file of result.files) {
    const mark = file.action === 'unchanged' ? pc.dim('=') : pc.green('✓');
    lines.push(`  ${mark} ${pc.cyan(file.action.padEnd(9))} ${file.path}`);
  }
  lines.push('', pc.dim(note ?? 'DevCortex host integration installed.'));
  return lines.join('\n');
}

/** One host's outcome inside a `devcortex install --all` run. */
export interface InstallAllItemView {
  target: string;
  label: string;
  result: InstallResult;
}

export function renderInstallAll(items: readonly InstallAllItemView[]): string {
  const lines = [heading('CORTEX INSTALL — ALL HOSTS')];
  for (const { label, target, result } of items) {
    const tag = pc.dim(`(${target})`);
    if (result.status === 'plan') {
      lines.push(
        `  ${pc.yellow('plan'.padEnd(8))} ${pc.bold(label)} ${tag} — ${result.plan.length} file(s) would change`,
      );
    } else {
      const changed = result.files.filter((f) => f.action !== 'unchanged').length;
      const mark = changed > 0 ? pc.green('✓') : pc.dim('=');
      lines.push(
        `  ${mark} ${pc.cyan('applied'.padEnd(8))} ${pc.bold(label)} ${tag} — ${result.files.length} file(s), ${changed} changed`,
      );
    }
  }
  const planned = items.filter((i) => i.result.status === 'plan').length;
  lines.push(
    '',
    planned > 0
      ? pc.dim(`${planned} host(s) returned a plan — re-run \`install --all --force\` to apply.`)
      : pc.dim('All host integrations installed.'),
  );
  return lines.join('\n');
}

// --- plan --------------------------------------------------------------------

/** Whether a workflow stage will run, be skipped by risk, or hand off to the agent. */
export type PlanStageState = 'run' | 'skip' | 'handoff';

export interface PlanStageView {
  stage: WorkflowStage;
  state: PlanStageState;
  floor: RiskLevel;
}

export interface PlanView {
  task: string;
  workflowId: string;
  workflowName: string;
  taskType: string;
  riskLevel: RiskLevel;
  stages: PlanStageView[];
  implementationStages: string[];
  definitionOfDone: string[];
}

function planStateTag(state: PlanStageState): string {
  switch (state) {
    case 'run':
      return pc.green('run');
    case 'skip':
      return pc.dim('skip');
    case 'handoff':
      return pc.cyan('handoff');
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function renderPlan(view: PlanView): string {
  const lines: string[] = [
    heading('CORTEX PLAN'),
    `${label('Task')}${view.task}`,
    `${label('Workflow')}${view.workflowId} ${pc.dim('—')} ${view.workflowName}`,
    `${label('Type · Risk')}${view.taskType} · ${riskTag(view.riskLevel)}`,
    '',
    pc.bold(`Workflow stages (${view.stages.length})`),
  ];
  view.stages.forEach((s, i) => {
    lines.push(`  ${pc.dim(String(i + 1).padStart(2))}. ${s.stage.padEnd(13)} ${planStateTag(s.state)}`);
  });
  lines.push(
    '',
    pc.bold(`Implementation plan (${view.implementationStages.length})`),
    numbered(view.implementationStages),
    '',
    pc.bold('Definition of done'),
    bullets(view.definitionOfDone),
  );
  return lines.join('\n');
}

// --- learn -------------------------------------------------------------------

export interface LearnFailureView {
  id: string;
  signature: string;
  occurrences: number;
  category: string;
  cause: string;
  remedyKind: string;
}

export interface LearnView {
  analyzed: number;
  failures: LearnFailureView[];
  created: string[];
}

export function renderLearn(view: LearnView): string {
  const lines: string[] = [
    heading('CORTEX LEARN'),
    `${label('Analyzed')}${view.analyzed} recurring failure(s)`,
  ];
  if (view.analyzed === 0) {
    lines.push('', pc.dim('  (no recurring failures observed — nothing to learn yet)'));
    return lines.join('\n');
  }
  lines.push('', pc.bold(`Learned (${view.failures.length})`));
  for (const f of view.failures) {
    lines.push(
      `  ${pc.dim(f.id.slice(0, 8))} ${pc.bold(`[${f.category}]`)} ${pc.dim(`×${f.occurrences}`)} ${pc.dim('→')} ${f.remedyKind}`,
    );
    lines.push(`           ${pc.dim(f.cause)}`);
  }
  lines.push('', pc.bold(`Created (${view.created.length})`), bullets(view.created));
  return lines.join('\n');
}

// --- skills ------------------------------------------------------------------

export interface SkillListItemView {
  id: string;
  name: string;
  status: SkillStatus;
  source: string;
  builtIn: boolean;
  installed: boolean;
}

export function renderSkillList(items: readonly SkillListItemView[]): string {
  const lines = [heading(`SKILL REGISTRY (${items.length})`)];
  if (items.length === 0) {
    lines.push(pc.dim('  (no skills)'));
    return lines.join('\n');
  }
  for (const s of items) {
    const marks: string[] = [pc.dim(`[${s.status}]`)];
    if (s.installed) marks.push(pc.green('installed'));
    lines.push(`${pc.bold(s.id.padEnd(28))} ${s.name}`);
    lines.push(`  ${marks.join(' ')} ${pc.dim(`· ${s.source}`)}`);
  }
  return lines.join('\n');
}

export interface SkillRecommendationView {
  id: string;
  name: string;
  score: number;
  matched: string[];
  status: SkillStatus;
}

export function renderSkillRecommend(task: string, recs: readonly SkillRecommendationView[]): string {
  const lines: string[] = [heading('CORTEX SKILL RECOMMEND'), `${label('Task')}${task}`, ''];
  if (recs.length === 0) {
    lines.push(pc.dim('  (no skill matched this task)'));
    return lines.join('\n');
  }
  lines.push(pc.bold(`Recommended (${recs.length})`));
  for (const r of recs) {
    lines.push(`  ${pc.bold(r.id)} ${pc.dim('—')} ${r.name}`);
    lines.push(`    ${pc.cyan(`score ${r.score}`)} ${pc.dim(`· matched: ${r.matched.join(', ')}`)}`);
  }
  return lines.join('\n');
}

export function renderSkillItem(skill: SkillManifest, filePath: string): string {
  return [
    heading('SKILL INSTALLED'),
    `${label('Id')}${skill.id}`,
    `${label('Name')}${skill.name}`,
    `${label('Status')}${skill.status}`,
    `${label('Source')}${skill.source}`,
    `${label('Triggers')}${listOrDash(skill.triggers)}`,
    '',
    pc.bold(`Checklist (${skill.checklist.length})`),
    bullets(skill.checklist),
    '',
    `${label('Path')}${pc.dim(filePath)}`,
  ].join('\n');
}

// --- workflows ---------------------------------------------------------------

export function renderWorkflowList(defs: readonly WorkflowDefinition[]): string {
  const lines = [heading(`WORKFLOW REGISTRY (${defs.length})`)];
  for (const def of defs) {
    const floor = def.minRisk !== undefined ? riskTag(def.minRisk) : pc.dim('LOW');
    lines.push(`${pc.bold(def.id.padEnd(20))} ${def.name}`);
    lines.push(
      `  ${pc.dim('floor')} ${floor} ${pc.dim(`· ${def.stages.length} stages · types: ${def.taskTypes.join(', ')}`)}`,
    );
  }
  return lines.join('\n');
}

function workflowRunStatusTag(status: WorkflowRunStatus): string {
  switch (status) {
    case 'completed':
      return pc.bold(pc.green('COMPLETED'));
    case 'blocked':
      return pc.bold(pc.yellow('BLOCKED'));
    case 'failed':
      return pc.bold(pc.red('FAILED'));
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function stageMark(status: StageStatus): string {
  switch (status) {
    case 'ok':
      return pc.green('✓');
    case 'skipped':
      return pc.dim('○');
    case 'failed':
      return pc.red('✗');
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function renderWorkflowRun(run: WorkflowRun): string {
  const lines: string[] = [
    heading('CORTEX WORKFLOW RUN'),
    `${label('Id')}${run.id}`,
    `${label('Workflow')}${run.workflowId}`,
    `${label('Risk')}${riskTag(run.riskLevel)}`,
    `${label('Status')}${workflowRunStatusTag(run.status)}`,
    '',
    pc.bold(`Stages (${run.stages.length})`),
  ];
  for (const s of run.stages) {
    lines.push(
      `  ${stageMark(s.status)} ${pc.bold(s.stage.padEnd(13))} ${pc.dim(s.status)} ${pc.dim('—')} ${s.detail}`,
    );
  }
  return lines.join('\n');
}

// --- gate --------------------------------------------------------------------

/**
 * A check-based gate family's outcome (code / ui / security / devops / product).
 * `gate` is the underlying GateResult label (e.g. `quality` for the `code`
 * family); `passed` is the gate's own verdict — true iff every REQUIRED check
 * passed. `evidence` is carried for `--json` consumers; the human render shows
 * the per-check pass/fail + detail.
 */
export interface GateCheckView {
  kind: 'checks';
  family: GateFamily;
  gate: string;
  passed: boolean;
  checks: CheckResult[];
  evidence: EvidenceItem[];
}

/** The premium-UI family's outcome: a computed quality score, not pass/fail checks. */
export interface GateScoreView {
  kind: 'score';
  family: 'premium-ui';
  score: UiQualityScore;
}

export type GateFamilyView = GateCheckView | GateScoreView;

export interface GateReportView {
  stack: DetectedStack;
  families: GateFamily[];
  results: GateFamilyView[];
  /** true when no check-based gate reported a failing required check. */
  ok: boolean;
}

/** Colour a 0-100 score band for scanability (cosmetic only — not a pass line). */
function scoreTag(score: number): string {
  const text = String(score);
  if (score >= 80) return pc.green(text);
  if (score >= 60) return pc.yellow(text);
  return pc.red(text);
}

function scoreLine(name: string, score: number): string {
  return `  ${pc.dim(name.padEnd(22))} ${scoreTag(score)}`;
}

function renderGateScore(view: GateScoreView): string[] {
  const s = view.score;
  const lines: string[] = [
    `${pc.bold(view.family)} ${pc.dim('—')} score ${scoreTag(s.overall)}${pc.dim('/100')}`,
    scoreLine('visual hierarchy', s.visualHierarchy),
    scoreLine('mobile responsiveness', s.mobileResponsiveness),
    scoreLine('spacing consistency', s.spacingConsistency),
    scoreLine('accessibility', s.accessibility),
    scoreLine('premium feel', s.premiumFeel),
  ];
  lines.push(`  ${pc.bold(`Top fixes (${s.topFixes.length})`)}`);
  lines.push(bullets(s.topFixes, '    '));
  return lines;
}

function renderGateChecks(view: GateCheckView): string[] {
  const tag = view.passed ? pc.green('PASS') : pc.red('FAIL');
  const label = view.gate === view.family ? view.family : `${view.family} (${view.gate})`;
  const lines: string[] = [
    `${pc.bold(label)} ${pc.dim('—')} ${tag} ${pc.dim(`(${view.checks.length} checks)`)}`,
  ];
  if (view.checks.length === 0) {
    lines.push(`  ${pc.dim('(no checks)')}`);
  } else {
    for (const check of view.checks) lines.push(checkLine(check, check.passed));
  }
  return lines;
}

export function renderGate(view: GateReportView): string {
  const lines: string[] = [
    heading('CORTEX GATE'),
    `${label('Stack')}${stackSummary(view.stack)}`,
    `${label('Families')}${listOrDash(view.families)}`,
    `${label('Result')}${view.ok ? pc.green('PASS') : pc.red('FAIL')}`,
  ];
  if (view.results.length === 0) {
    lines.push('', pc.dim('  (no gate families applicable to this stack)'));
    return lines.join('\n');
  }
  for (const result of view.results) {
    lines.push('');
    lines.push(...(result.kind === 'score' ? renderGateScore(result) : renderGateChecks(result)));
  }
  return lines.join('\n');
}

// --- mcp / firewall / privacy (sub-project #5, §7.19-7.20 + §7.22) -----------

/** Colour an MCP trust level by how much it can be relied on. */
function trustTag(trust: McpTrust): string {
  switch (trust) {
    case 'trusted':
      return pc.green('trusted');
    case 'community':
      return pc.yellow('community');
    case 'unknown':
      return pc.red('unknown');
    default: {
      const _exhaustive: never = trust;
      return _exhaustive;
    }
  }
}

/** Colour a firewall verdict by severity; upper-cased for scanability. */
function decisionTag(decision: FirewallDecision): string {
  switch (decision) {
    case 'allow':
      return pc.bold(pc.green('ALLOW'));
    case 'require-approval':
      return pc.bold(pc.yellow('REQUIRE-APPROVAL'));
    case 'deny':
      return pc.bold(pc.red('DENY'));
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

/** Colour a privacy mode: local-only (safest) green → deep-cloud (most exposed) red. */
function privacyTag(mode: PrivacyMode): string {
  switch (mode) {
    case 'local-only':
      return pc.green(mode);
    case 'metadata-cloud':
      return pc.yellow(mode);
    case 'deep-cloud':
      return pc.red(mode);
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** A three-line summary block for one MCP server spec. */
function serverLines(spec: McpServerSpec): string[] {
  const writes = spec.tools.filter((t) => t.access === 'write').length;
  const destructive = spec.tools.filter((t) => t.destructive).length;
  const mutating = writes > 0 || destructive > 0 ? ` ${pc.dim(`(${writes} write, ${destructive} destructive)`)}` : '';
  const secrets = spec.secretsRequired.length > 0 ? spec.secretsRequired.join(', ') : pc.dim('none');
  const sandbox = spec.sandbox ? pc.green('yes') : pc.dim('no');
  return [
    `  ${pc.bold(spec.id.padEnd(18))} ${spec.name} ${pc.dim('·')} ${trustTag(spec.trust)}`,
    `    ${pc.dim('source')} ${spec.source}`,
    `    ${pc.dim('tools')}  ${spec.tools.length}${mutating} ${pc.dim('·')} secrets: ${secrets} ${pc.dim('·')} sandbox: ${sandbox}`,
  ];
}

// --- mcp list ----------------------------------------------------------------

export interface McpListView {
  installed: McpServerSpec[];
  recommended: McpServerSpec[];
}

export function renderMcpList(view: McpListView): string {
  const lines = [heading('CORTEX MCP — SERVERS'), '', pc.bold(`Installed (${view.installed.length})`)];
  if (view.installed.length === 0) {
    lines.push(`  ${pc.dim('(none wired into .mcp.json)')}`);
  } else {
    for (const spec of view.installed) lines.push(...serverLines(spec));
  }
  lines.push('', pc.bold(`Recommended (${view.recommended.length})`));
  if (view.recommended.length === 0) {
    lines.push(`  ${pc.dim('(every catalog server is already installed)')}`);
  } else {
    for (const spec of view.recommended) lines.push(...serverLines(spec));
  }
  lines.push('', pc.dim('Install one with `devcortex mcp install <id>` (read-only posture by default).'));
  return lines.join('\n');
}

// --- mcp recommend -----------------------------------------------------------

export function renderMcpRecommend(task: string, recs: readonly McpServerSpec[]): string {
  const lines = [heading('CORTEX MCP RECOMMEND'), `${label('Task')}${task}`, ''];
  if (recs.length === 0) {
    lines.push(pc.dim('  (no catalog server matched this task or stack)'));
    return lines.join('\n');
  }
  lines.push(pc.bold(`Recommended (${recs.length})`));
  for (const spec of recs) lines.push(...serverLines(spec));
  return lines.join('\n');
}

// --- mcp install -------------------------------------------------------------

export interface McpInstallView {
  id: string;
  status: InstallStatus;
  posture: string;
  specPath: string;
  mcpJsonPath: string;
}

export function renderMcpInstall(view: McpInstallView): string {
  const status =
    view.status === 'exists' ? pc.yellow('exists (nothing written)') : pc.green(view.status);
  const lines = [
    heading('CORTEX MCP INSTALL'),
    `${label('Server')}${view.id}`,
    `${label('Status')}${status}`,
    `${label('Posture')}${view.posture}`,
    `${label('Spec')}${pc.dim(view.specPath)}`,
    `${label('Config')}${pc.dim(view.mcpJsonPath)}`,
    '',
    view.status === 'exists'
      ? pc.dim('Already present in .mcp.json — re-run with `--force` to overwrite it.')
      : pc.dim('Installed read-only; every write/destructive tool requires approval per the firewall policy.'),
  ];
  return lines.join('\n');
}

// --- mcp audit ---------------------------------------------------------------

export function renderMcpAudit(findings: readonly string[]): string {
  const lines = [heading('CORTEX MCP AUDIT')];
  if (findings.length === 0) {
    lines.push('', `  ${pc.green('✓')} No risky MCP configuration detected.`);
    return lines.join('\n');
  }
  lines.push('', pc.bold(`Findings (${findings.length})`));
  for (const finding of findings) lines.push(`  ${pc.yellow('!')} ${finding}`);
  return lines.join('\n');
}

// --- firewall show -----------------------------------------------------------

export interface FirewallPolicyView {
  source: 'default' | 'file';
  path: string | null;
  policy: McpPolicy;
}

export function renderFirewallPolicy(view: FirewallPolicyView): string {
  const p = view.policy;
  const source =
    view.source === 'file' && view.path !== null
      ? pc.dim(view.path)
      : pc.dim('built-in safe defaults (no policy file)');
  const budgetEntries = Object.entries(p.budgets);
  const lines = [
    heading('CORTEX FIREWALL POLICY'),
    `${label('Source')}${source}`,
    `${label('Dry run')}${p.dryRun ? pc.yellow('on') : pc.dim('off')}`,
    '',
    pc.bold(`Allow (${p.allow.length})`),
    bullets(p.allow),
    '',
    pc.bold(`Require approval (${p.requireApproval.length})`),
    bullets(p.requireApproval),
    '',
    pc.bold(`Deny (${p.deny.length})`),
    bullets(p.deny),
    '',
    pc.bold(`Budgets (${budgetEntries.length})`),
    budgetEntries.length > 0
      ? budgetEntries.map(([k, v]) => `  ${pc.dim('•')} ${k}: ${v}`).join('\n')
      : `  ${pc.dim('(none)')}`,
  ];
  return lines.join('\n');
}

// --- firewall check ----------------------------------------------------------

export interface FirewallCheckView {
  server: string;
  tool: string;
  evaluation: ToolCallEval;
}

export function renderFirewallCheck(view: FirewallCheckView): string {
  const e = view.evaluation;
  const lines = [
    heading('CORTEX FIREWALL CHECK'),
    `${label('Call')}${view.server}.${view.tool}`,
    `${label('Decision')}${decisionTag(e.decision)}`,
    `${label('Risk')}${scoreTag(e.riskScore)}${pc.dim('/100')}`,
    '',
    pc.bold(`Reasons (${e.reasons.length})`),
    bullets(e.reasons),
  ];
  if (e.redactedArgs !== undefined) {
    lines.push('', `${label('Args')}${e.redactedArgs}`);
  }
  return lines.join('\n');
}

// --- privacy status ----------------------------------------------------------

export interface PrivacyModeView {
  mode: PrivacyMode;
  active: boolean;
  permits: string;
  retention: string;
  leavesMachine: boolean;
}

export interface PrivacyStatusView {
  active: PrivacyMode;
  modes: PrivacyModeView[];
}

export function renderPrivacyStatus(view: PrivacyStatusView): string {
  const lines = [heading('CORTEX PRIVACY'), `${label('Mode')}${privacyTag(view.active)}`, '', pc.bold('Modes')];
  for (const m of view.modes) {
    const marker = m.active ? pc.green('▶') : ' ';
    // Pad the raw string before colouring so alignment survives ANSI codes.
    const namePad = m.mode.padEnd(16);
    const name = m.active ? pc.bold(pc.cyan(namePad)) : pc.dim(namePad);
    lines.push(`  ${marker} ${name}${m.permits} ${pc.dim(`· retention ${m.retention}`)}`);
  }
  return lines.join('\n');
}

// --- privacy redact ----------------------------------------------------------

export interface PrivacyRedactView {
  file: string;
  findings: RedactionFinding[];
  totalMasked: number;
  originalBytes: number;
  redactedBytes: number;
}

export function renderPrivacyRedact(view: PrivacyRedactView): string {
  const lines = [
    heading('CORTEX PRIVACY REDACT'),
    `${label('File')}${view.file}`,
    `${label('Size')}${view.originalBytes} B ${pc.dim('→')} ${view.redactedBytes} B redacted`,
    `${label('Masked')}${view.totalMasked} occurrence(s)`,
    '',
    pc.bold(`Findings (${view.findings.length})`),
  ];
  if (view.findings.length === 0) {
    lines.push(`  ${pc.green('✓')} No secrets or PII detected.`);
  } else {
    for (const f of view.findings) {
      lines.push(`  ${pc.yellow('•')} ${pc.bold(f.kind.padEnd(12))} ${pc.dim('×')}${f.count}`);
    }
  }
  return lines.join('\n');
}
