/**
 * Quality gates + ship report.
 *
 * `runQualityGate` runs the REAL configured commands (typecheck / lint / build /
 * test) via the evidence layer plus soft route-resolution and env-documentation
 * checks, collecting one `EvidenceItem` per check. `generateShipReport` runs the
 * same checks, classifies a `ShipStatus`, persists a human-readable markdown
 * report under `.cortex/ship-reports/`, and appends every collected evidence
 * item to the (append-only) `EvidenceLedger`.
 *
 * Required vs soft:
 *  - Required checks are the enabled command gates (`config.gates.X === true`
 *    with a `config.commands.X` configured). A failed required check blocks the
 *    ship (`NOT_READY`).
 *  - Soft checks are route resolution and env documentation. A failed soft check
 *    is surfaced as a warning and never blocks.
 *  - A gate that is enabled but has no configured command cannot be verified; it
 *    degrades to a warning note rather than a silent pass or a hard block
 *    (philosophy: evidence over opinions, never block without explanation).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { GateError } from '../domain/index';
import type {
  CheckResult,
  CortexConfig,
  EvidenceItem,
  GateResult,
  ProjectGraph,
  ShipReport,
  ShipStatus,
} from '../domain/index';
import { verifyCommandResult, verifyFileExists } from '../evidence';
import type { EvidenceLedger } from '../ledgers';
import { workspacePaths } from '../workspace/paths';

// --- public types -----------------------------------------------------------

/**
 * The ledgers a ship report needs. Only the append-only `EvidenceLedger` is
 * consumed by the gate, so it is the sole required member; a richer application
 * bundle (memory/feature/decision + evidence) satisfies this structurally.
 */
export interface ShipLedgers {
  evidence: EvidenceLedger;
}

// --- constants --------------------------------------------------------------

const GATE_NAME = 'quality';

/** Command gates, in deterministic report order. */
const COMMAND_GATES = ['typecheck', 'lint', 'build', 'test'] as const;

// --- internal shapes --------------------------------------------------------

interface RichCheck {
  /** the user-facing check result (its `evidenceId` is mutated to the persisted id by the ship report) */
  check: CheckResult;
  /** whether a failure of this check blocks the ship */
  required: boolean;
  /** the single evidence item backing this check */
  evidence: EvidenceItem;
}

interface GateChecks {
  rich: RichCheck[];
  /** soft warning notes with no backing check (e.g. an enabled-but-unconfigured gate) */
  notes: string[];
}

// --- guards -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertGateInputs(root: string, config: CortexConfig, graph: ProjectGraph): void {
  if (typeof root !== 'string' || root.length === 0) {
    throw new GateError('Quality gate requires a non-empty repository root path.');
  }
  if (!isRecord(config) || !isRecord(config.gates) || !isRecord(config.commands)) {
    throw new GateError('Quality gate requires a valid CortexConfig (with gates + commands).');
  }
  if (!isRecord(graph) || !Array.isArray(graph.routes) || !Array.isArray(graph.envVars)) {
    throw new GateError('Quality gate requires a valid ProjectGraph (with routes + envVars).');
  }
}

function hasEvidenceLedger(value: unknown): value is ShipLedgers {
  if (!isRecord(value)) return false;
  const evidence = (value as { evidence?: unknown }).evidence;
  return isRecord(evidence) && typeof (evidence as { add?: unknown }).add === 'function';
}

// --- evidence construction --------------------------------------------------

/** Build an `env`-kind evidence item; there is no shared verifier for env documentation. */
function makeEnvEvidence(name: string, documented: boolean, usedCount: number): EvidenceItem {
  return {
    id: randomUUID(),
    claim: `Env var "${name}" is documented`,
    status: documented ? 'verified' : 'refuted',
    kind: 'env',
    detail: documented
      ? `"${name}" is documented (used in ${usedCount} file(s))`
      : `"${name}" is used in ${usedCount} file(s) but is not documented in an env example/schema`,
    createdAt: new Date().toISOString(),
  };
}

// --- check collection -------------------------------------------------------

/**
 * Run every gate check once. Shared by `runQualityGate` and `generateShipReport`
 * so the real commands execute exactly once per invocation.
 */
async function runGateChecks(
  root: string,
  config: CortexConfig,
  graph: ProjectGraph,
): Promise<GateChecks> {
  const rich: RichCheck[] = [];
  const notes: string[] = [];

  // Required command gates (typecheck / lint / build / test).
  for (const gate of COMMAND_GATES) {
    if (config.gates[gate] !== true) continue;

    const command = config.commands[gate];
    if (typeof command !== 'string' || command.trim().length === 0) {
      notes.push(
        `The ${gate} gate is enabled but no command is configured (config.commands.${gate}); ${gate} could not be verified.`,
      );
      continue;
    }

    const evidence = await verifyCommandResult(command, { cwd: root });
    const passed = evidence.status === 'verified';
    rich.push({
      required: true,
      evidence,
      check: { name: gate, passed, detail: evidence.detail, evidenceId: evidence.id },
    });
  }

  // Soft check: every route's backing file resolves on disk.
  for (const route of graph.routes) {
    if (!isRecord(route) || typeof route.file !== 'string' || route.file.length === 0) continue;
    const evidence = await verifyFileExists(root, route.file);
    const passed = evidence.status === 'verified';
    rich.push({
      required: false,
      evidence,
      check: {
        name: `route:${route.routePath}`,
        passed,
        detail: passed
          ? `Route "${route.routePath}" resolves to ${route.file}`
          : `Route "${route.routePath}" backing file "${route.file}" is missing`,
        evidenceId: evidence.id,
      },
    });
  }

  // Soft check: every referenced env var is documented.
  for (const envVar of graph.envVars) {
    if (!isRecord(envVar) || typeof envVar.name !== 'string' || envVar.name.length === 0) continue;
    const documented = envVar.documented === true;
    const usedCount = Array.isArray(envVar.usedIn) ? envVar.usedIn.length : 0;
    const evidence = makeEnvEvidence(envVar.name, documented, usedCount);
    rich.push({
      required: false,
      evidence,
      check: {
        name: `env:${envVar.name}`,
        passed: documented,
        detail: documented
          ? `Env var "${envVar.name}" is documented`
          : `Env var "${envVar.name}" is used in ${usedCount} file(s) but is not documented`,
        evidenceId: evidence.id,
      },
    });
  }

  return { rich, notes };
}

// --- runQualityGate ---------------------------------------------------------

/**
 * Run the configured quality gate against `root`. Returns the `GateResult`
 * (whose `passed` reflects only the required command checks) plus every
 * collected `EvidenceItem`. Throws `GateError` on invalid input; verifier
 * internal failures surface as `EvidenceError`.
 */
export async function runQualityGate(
  root: string,
  config: CortexConfig,
  graph: ProjectGraph,
): Promise<{ result: GateResult; evidence: EvidenceItem[] }> {
  assertGateInputs(root, config, graph);

  const { rich } = await runGateChecks(root, config, graph);
  const required = rich.filter((entry) => entry.required);
  const passed = required.every((entry) => entry.check.passed);

  const result: GateResult = {
    gate: GATE_NAME,
    passed,
    checks: rich.map((entry) => entry.check),
  };

  return { result, evidence: rich.map((entry) => entry.evidence) };
}

// --- ship report ------------------------------------------------------------

function buildSuggestedPrompt(
  status: Exclude<ShipStatus, 'READY'>,
  blocked: CheckResult[],
  warnings: string[],
): string {
  if (status === 'NOT_READY') {
    const lines = blocked.map((check) => `- ${check.name}: ${check.detail}`);
    return [
      'DevCortex ship gate: NOT_READY. These required checks failed and must pass before the work can be marked done:',
      ...lines,
      'Fix the root cause of each failure (do not suppress, skip, or weaken the check), re-run the gate, and confirm every required check exits 0. Re-run `devcortex ship` and proceed only when it reports READY.',
    ].join('\n');
  }

  const lines = warnings.map((warning) => `- ${warning}`);
  return [
    'DevCortex ship gate: READY_WITH_WARNINGS. All required checks pass, but address these warnings before shipping:',
    ...lines,
    'Resolve each warning or consciously accept it, recording any accepted risk in the decision ledger.',
  ].join('\n');
}

function renderChecksTable(checks: CheckResult[]): string {
  if (checks.length === 0) return '_none_';
  const rows = checks.map(
    (check) =>
      `| ${check.name} | ${check.passed ? 'pass' : 'fail'} | ${check.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${check.evidenceId ?? '—'} |`,
  );
  return ['| Check | Result | Detail | Evidence |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function renderEvidenceList(rich: RichCheck[]): string {
  if (rich.length === 0) return '_none_';
  return rich
    .map((entry) => {
      const { evidence, check } = entry;
      const id = check.evidenceId ?? evidence.id;
      const command = evidence.command !== undefined ? ` \`${evidence.command}\`` : '';
      const exit = evidence.exitCode !== undefined ? ` (exit ${evidence.exitCode})` : '';
      return `- \`${id}\` [${evidence.status}] ${evidence.kind}${command}${exit} — ${evidence.claim}`;
    })
    .join('\n');
}

function renderMarkdown(report: ShipReport, rich: RichCheck[]): string {
  const sections: string[] = [
    '# DevCortex Ship Report',
    '',
    `- **Status:** ${report.status}`,
    `- **Generated:** ${report.generatedAt}`,
    `- **Required checks passed:** ${report.blocked.length === 0 ? 'yes' : 'no'}`,
    `- **Evidence items:** ${report.evidenceIds.length}`,
    '',
    '## Passed',
    '',
    renderChecksTable(report.passed),
    '',
    '## Blocked (required failures)',
    '',
    renderChecksTable(report.blocked),
    '',
    '## Warnings',
    '',
    report.warnings.length === 0 ? '_none_' : report.warnings.map((w) => `- ${w}`).join('\n'),
    '',
  ];

  if (report.suggestedPrompt !== undefined) {
    sections.push('## Suggested next prompt', '', '```text', report.suggestedPrompt, '```', '');
  }

  sections.push('## Evidence', '', renderEvidenceList(rich), '');
  return `${sections.join('\n')}`;
}

async function persistShipReport(
  root: string,
  report: ShipReport,
  rich: RichCheck[],
): Promise<string> {
  const paths = workspacePaths(root);
  // ISO timestamp is not a safe filename (colons, dots); a short uuid suffix
  // guarantees uniqueness for reports generated within the same millisecond.
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const file = path.join(paths.shipReportsDir, `${stamp}-${randomUUID().slice(0, 8)}.md`);

  try {
    await mkdir(paths.shipReportsDir, { recursive: true });
    await writeFile(file, renderMarkdown(report, rich), 'utf8');
  } catch (err) {
    throw new GateError(`Unable to write ship report to ${file}.`, { cause: err });
  }
  return file;
}

/**
 * Run the quality gate and synthesize a `ShipReport`. Classifies status
 * (`NOT_READY` if any required check failed, `READY_WITH_WARNINGS` if all
 * required pass but soft warnings exist, otherwise `READY`), attaches a
 * `suggestedPrompt` whenever the status is not `READY`, persists a markdown
 * report under `.cortex/ship-reports/`, and appends every evidence item to the
 * `EvidenceLedger`. Throws `GateError` on invalid input/ledger or a write
 * failure; ledger persistence failures surface as `LedgerError`.
 */
export async function generateShipReport(
  root: string,
  config: CortexConfig,
  graph: ProjectGraph,
  ledgers: ShipLedgers,
): Promise<ShipReport> {
  assertGateInputs(root, config, graph);
  if (!hasEvidenceLedger(ledgers)) {
    throw new GateError('generateShipReport requires a ledger bundle with an EvidenceLedger.');
  }

  const { rich, notes } = await runGateChecks(root, config, graph);

  // Persist every evidence item (append-only) and remap each check's evidenceId
  // to the ledger-assigned id so the report and the ledger never disagree.
  const evidenceIds: string[] = [];
  for (const entry of rich) {
    const source = entry.evidence;
    const persisted = await ledgers.evidence.add({
      claim: source.claim,
      status: source.status,
      kind: source.kind,
      detail: source.detail,
      ...(source.command !== undefined ? { command: source.command } : {}),
      ...(source.exitCode !== undefined ? { exitCode: source.exitCode } : {}),
      ...(source.output !== undefined ? { output: source.output } : {}),
    });
    entry.check.evidenceId = persisted.id;
    evidenceIds.push(persisted.id);
  }

  const blocked = rich
    .filter((entry) => entry.required && !entry.check.passed)
    .map((entry) => entry.check);
  const passed = rich.filter((entry) => entry.check.passed).map((entry) => entry.check);

  const warnings: string[] = [];
  for (const entry of rich) {
    if (!entry.required && !entry.check.passed) warnings.push(entry.check.detail);
  }
  warnings.push(...notes);

  const status: ShipStatus =
    blocked.length > 0 ? 'NOT_READY' : warnings.length > 0 ? 'READY_WITH_WARNINGS' : 'READY';

  const report: ShipReport = {
    status,
    passed,
    blocked,
    warnings,
    evidenceIds,
    generatedAt: new Date().toISOString(),
  };

  if (status !== 'READY') {
    report.suggestedPrompt = buildSuggestedPrompt(status, blocked, warnings);
  }

  await persistShipReport(root, report, rich);
  return report;
}
