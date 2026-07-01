/**
 * DevOps gate (§7.12 + §7.21) — deep, TOKENLESS, DETERMINISTIC deployment-
 * readiness heuristics over the `ProjectGraph` and real file reads (no LLM). It
 * composes the read-only DevOps Commander diagnostics into a single
 * `GateResult` + one `EvidenceItem` per check.
 *
 * A finding is a `CheckResult` (never an exception), so the gate NEVER throws on
 * a detected issue; it throws `GateError` only on invalid input or an internal
 * failure. Commander file reads are fail-safe (an unreadable file is skipped),
 * so one permission error never fails the whole gate.
 *
 * Checks (required ones block; soft ones are advisory) in report order:
 *   env-vars          (required) every referenced env var is documented in .env.example
 *   docker            (required) Dockerfile: non-root final USER, no secret COPY
 *   secrets-exposure  (required) dotenv/keys/credentials in the tree are gitignored
 *   k8s-nonroot       (required) workload manifests enforce runAsNonRoot / not privileged
 *   ci                (soft)     a CI provider is configured and its config parses
 *   vercel-build      (soft)     Vercel/Next build readiness
 *   rollback-plan     (soft)     a rollback plan is documented
 *
 * A check whose subject is absent (no Dockerfile, no k8s manifests, no env vars)
 * degrades to `unverified` and passes — it is not applicable, not a silent pass.
 *
 * Public API:
 *   runDevopsGate(root, graph, config): Promise<{ result: GateResult; evidence: EvidenceItem[] }>
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { GateError } from '../domain/index';
import type {
  CheckResult,
  CortexConfig,
  EvidenceItem,
  EvidenceKind,
  EvidenceStatus,
  GateResult,
  ProjectGraph,
} from '../domain/index';

import {
  ciHealth,
  diagnoseDocker,
  diagnoseK8s,
  diagnoseVercel,
  productionConfigCheck,
  secretsExposureCheck,
} from './commander';
import type { Diagnostic, DiagnosticFinding } from './commander';

// --- constants --------------------------------------------------------------

const GATE_NAME = 'devops';

/** Cap findings enumerated inside a single check's detail, so one file can't flood it. */
const MAX_FINDINGS_LISTED = 8;

/** Dedicated rollback documents (presence alone satisfies the rollback check). */
const ROLLBACK_DOC_CANDIDATES = [
  'ROLLBACK.md',
  'ROLLBACK.txt',
  'rollback.md',
  'docs/ROLLBACK.md',
  'docs/rollback.md',
  'runbooks/rollback.md',
  'runbook/rollback.md',
  'docs/runbooks/rollback.md',
];

/** Docs that may mention a rollback procedure inline. */
const ROLLBACK_SCAN_DOCS = [
  'README.md',
  'DEPLOY.md',
  'DEPLOYMENT.md',
  'docs/deploy.md',
  'docs/deployment.md',
  'docs/DEPLOY.md',
  'RUNBOOK.md',
  'docs/runbook.md',
  'OPERATIONS.md',
  'docs/operations.md',
];

// --- internal shapes --------------------------------------------------------

interface RichCheck {
  check: CheckResult;
  /** whether a failure of this check blocks the gate verdict. */
  required: boolean;
  evidence: EvidenceItem;
}

interface EvidenceFields {
  claim: string;
  status: EvidenceStatus;
  kind: EvidenceKind;
  detail: string;
}

// --- guards -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertGateInputs(root: string, graph: ProjectGraph, config: CortexConfig): void {
  if (typeof root !== 'string' || root.length === 0) {
    throw new GateError('DevOps gate requires a non-empty repository root path.');
  }
  if (!isRecord(graph) || !Array.isArray(graph.files) || !Array.isArray(graph.envVars)) {
    throw new GateError('DevOps gate requires a valid ProjectGraph (with files + envVars arrays).');
  }
  if (!isRecord(config)) {
    throw new GateError('DevOps gate requires a valid CortexConfig.');
  }
}

// --- evidence + fold --------------------------------------------------------

function makeEvidence(fields: EvidenceFields): EvidenceItem {
  return {
    id: randomUUID(),
    claim: fields.claim,
    status: fields.status,
    kind: fields.kind,
    detail: fields.detail,
    createdAt: new Date().toISOString(),
  };
}

function renderFinding(finding: DiagnosticFinding): string {
  const where =
    finding.file !== undefined
      ? finding.line !== undefined
        ? `${finding.file}:${finding.line} — `
        : `${finding.file} — `
      : '';
  return `[${finding.severity}] ${where}${finding.message}`;
}

function renderDetail(diag: Diagnostic): string {
  if (diag.findings.length === 0) return diag.summary;
  const shown = diag.findings.slice(0, MAX_FINDINGS_LISTED).map(renderFinding).join('; ');
  const extra =
    diag.findings.length > MAX_FINDINGS_LISTED
      ? ` (+${diag.findings.length - MAX_FINDINGS_LISTED} more)`
      : '';
  return `${diag.summary} ${shown}${extra}`;
}

/**
 * Fold a commander `Diagnostic` into a single required/soft gate check + backing
 * evidence. Status mapping: a non-applicable subject is `unverified` (passes); an
 * error finding is `refuted` (fails); a warning-only diagnostic is `partial`
 * (passes); an entirely clean diagnostic is `verified`.
 */
function foldDiagnostic(
  name: string,
  kind: EvidenceKind,
  diag: Diagnostic,
  required: boolean,
): RichCheck {
  const hasError = diag.findings.some((f) => f.severity === 'error');
  const hasWarning = diag.findings.some((f) => f.severity === 'warning');

  let status: EvidenceStatus;
  let passed: boolean;
  if (!diag.applicable) {
    status = 'unverified';
    passed = true;
  } else if (hasError) {
    status = 'refuted';
    passed = false;
  } else if (hasWarning) {
    status = 'partial';
    passed = true;
  } else {
    status = 'verified';
    passed = true;
  }

  const detail = renderDetail(diag);
  const evidence = makeEvidence({ claim: `devops:${name}`, status, kind, detail });
  return { required, evidence, check: { name, passed, detail, evidenceId: evidence.id } };
}

// --- rollback-plan check (inline; not a commander diagnostic) ----------------

async function isFileAt(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

async function readFileSafe(abs: string): Promise<string | undefined> {
  try {
    return await readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * A rollback plan exists if a dedicated ROLLBACK doc is present, an npm script
 * mentions rollback, or a deploy/runbook doc describes a rollback. Absence is a
 * (soft) warning — every deployable project should document how to revert.
 */
async function rollbackPlanCheck(root: string, graph: ProjectGraph): Promise<Diagnostic> {
  const absRoot = path.resolve(root);

  for (const candidate of ROLLBACK_DOC_CANDIDATES) {
    if (await isFileAt(path.join(absRoot, candidate))) {
      return {
        name: 'rollback-plan',
        applicable: true,
        ok: true,
        findings: [{ severity: 'info', file: candidate, message: 'dedicated rollback plan present.' }],
        summary: `Rollback plan documented (${candidate}).`,
      };
    }
  }

  const scripts = isRecord(graph.scripts) ? graph.scripts : {};
  for (const [key, value] of Object.entries(scripts)) {
    if (/rollback/i.test(key) || (typeof value === 'string' && /rollback/i.test(value))) {
      return {
        name: 'rollback-plan',
        applicable: true,
        ok: true,
        findings: [{ severity: 'info', message: `rollback path present (npm script "${key}").` }],
        summary: `Rollback path present (script "${key}").`,
      };
    }
  }

  for (const candidate of ROLLBACK_SCAN_DOCS) {
    const content = await readFileSafe(path.join(absRoot, candidate));
    if (content !== undefined && /\brollback\b/i.test(content)) {
      return {
        name: 'rollback-plan',
        applicable: true,
        ok: true,
        findings: [{ severity: 'info', file: candidate, message: 'rollback procedure documented in a runbook/deploy doc.' }],
        summary: `Rollback procedure documented (${candidate}).`,
      };
    }
  }

  return {
    name: 'rollback-plan',
    applicable: true,
    ok: true,
    findings: [
      {
        severity: 'warning',
        message:
          'no rollback plan found (no ROLLBACK doc, rollback npm script, or runbook mention); document how to revert a bad deploy before shipping.',
      },
    ],
    summary: 'No rollback plan documented.',
  };
}

// --- public entrypoint ------------------------------------------------------

/**
 * Run the deep DevOps gate against `root`. Returns the `GateResult` (whose
 * `passed` reflects only the required checks) plus every collected
 * `EvidenceItem` (exactly one per check). Findings are `CheckResult`s, never
 * exceptions; `GateError` is thrown only on invalid input or an internal failure.
 *
 * @param root   absolute repo root the graph was scanned from.
 * @param graph  the project graph (from `scanProject`/`loadGraph`).
 * @param config the workspace config.
 */
export async function runDevopsGate(
  root: string,
  graph: ProjectGraph,
  config: CortexConfig,
): Promise<{ result: GateResult; evidence: EvidenceItem[] }> {
  assertGateInputs(root, graph, config);
  const absRoot = path.resolve(root);

  try {
    const [prodConfig, docker, secrets, k8s, ci, vercel] = await Promise.all([
      productionConfigCheck(root, graph),
      diagnoseDocker(root),
      secretsExposureCheck(root, graph),
      diagnoseK8s(root),
      ciHealth(root),
      diagnoseVercel(root, graph),
    ]);
    const rollback = await rollbackPlanCheck(root, graph);

    const rich: RichCheck[] = [
      foldDiagnostic('env-vars', 'env', prodConfig, true),
      foldDiagnostic('docker', 'file', docker, true),
      foldDiagnostic('secrets-exposure', 'file', secrets, true),
      foldDiagnostic('k8s-nonroot', 'file', k8s, true),
      foldDiagnostic('ci', 'file', ci, false),
      foldDiagnostic('vercel-build', 'file', vercel, false),
      foldDiagnostic('rollback-plan', 'file', rollback, false),
    ];

    const passed = rich.every((entry) => !entry.required || entry.check.passed);

    const result: GateResult = {
      gate: GATE_NAME,
      passed,
      checks: rich.map((entry) => entry.check),
    };
    return { result, evidence: rich.map((entry) => entry.evidence) };
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw new GateError(`DevOps gate failed at ${absRoot}`, { cause: err });
  }
}
