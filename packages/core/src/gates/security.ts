/**
 * Security gate (§7.12) — deep, TOKENLESS, DETERMINISTic security heuristics
 * over the `ProjectGraph` and real file reads (no LLM). Every check is a real
 * detector that reads source and flags a concrete class of security defect; a
 * finding is a `CheckResult` (never an exception), so the gate NEVER throws on a
 * detected issue. It throws `GateError` only on invalid input or an internal
 * failure.
 *
 * File reads are fail-safe: an unreadable file is skipped (never aborts the
 * gate), mirroring the graph scanner's degrade-don't-crash contract. Secret
 * values are NEVER echoed into evidence — only the file, line, and a label.
 *
 * The heuristic checks (all blocking / required):
 *   secrets              hardcoded provider tokens + secret assignments in source
 *   client-secret-env    a NEXT_PUBLIC_* var carrying a SECRET/KEY (client bundle)
 *   client-secret-leak   a `'use client'` file reading server secrets via process.env
 *   webhook-signature    webhook/stripe handlers that never verify the signature
 *   input-validation     api routes / server actions using the body with no schema
 *   cors                 an `Access-Control-Allow-Origin: *` wildcard
 *   auth-risk            `getSession()` used to decide authorization (vs `getUser()`)
 *
 * Plus one SOFT (advisory, non-blocking) check:
 *   dependency-audit     `pnpm audit` / `npm audit --json` when a lockfile exists
 *
 * Public API:
 *   runSecurityGate(root, graph, config): Promise<{ result: GateResult; evidence: EvidenceItem[] }>
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
  FileKind,
  FileNode,
  GateResult,
  ProjectGraph,
} from '../domain/index';
import { verifyCommandResult } from '../evidence';

// --- constants --------------------------------------------------------------

const GATE_NAME = 'security';

/** Wall-clock ceiling for the advisory dependency audit. */
const AUDIT_TIMEOUT_MS = 60_000;

/** Cap findings enumerated inside a single check's detail, so one bad file can't flood it. */
const MAX_FINDINGS_LISTED = 8;
/** Cap hardcoded-secret hits reported per file. */
const MAX_SECRETS_PER_FILE = 5;

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;

/** Basenames that are never scanned for secrets. */
const NON_SCANNABLE_BASENAMES: ReadonlySet<string> = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.defaults',
  '.env.local.example',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

/** File kinds that ship to (or render in) the browser. */
const CLIENT_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['component', 'page', 'route']);
/** File kinds where an authorization decision might live. */
const AUTHZ_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'auth',
  'api',
  'middleware',
  'service',
  'page',
  'route',
]);

/**
 * Ordered, most-specific-first hardcoded-secret signatures. Order matters: the
 * scanner reports at most one label per line and the first matching pattern wins,
 * so concrete provider tokens sit ahead of the generic assignment rule.
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'API key (sk-…)', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  {
    label: 'hardcoded secret assignment',
    re: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"][^'"\s]{6,}['"]/i,
  },
];

/** A NEXT_PUBLIC_* var that looks like a real secret (SECRET or KEY et al.). */
const PUBLIC_SECRET_RE = /(SECRET|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|TOKEN)/;
/** Publishable/anon keys are intentionally public — exclude them from the NEXT_PUBLIC_ check. */
const KNOWN_PUBLIC_RE = /(PUBLISHABLE|ANON|PUBLIC_KEY|CLIENT_ID)/;

/** Non-public, secret-looking env var names (client-leak check). */
const SECRET_ENV_RE = /(SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|APIKEY|API_KEY|_KEY|TOKEN)/;
const USE_CLIENT_RE = /(^|\n)\s*['"]use client['"]\s*;?/;
const USE_SERVER_RE = /(^|\n)\s*['"]use server['"]\s*;?/;
const PROCESS_ENV_RE =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;

/** A webhook handler is trusted only if it verifies the signature. */
const WEBHOOK_VERIFY_RE = /construct(?:event)?|verif(?:y|ies|ied|ication)|validatesignature|checksignature/i;

/** The handler reads the untrusted request body. */
const BODY_READ_RE = /\b(?:req|request|ctx\.req|context\.req)\.(?:body|json|text|formData|arrayBuffer)\b/i;
/** The handler validates the body against a schema before trusting it. */
const VALIDATION_RE =
  /\.safeParse\s*\(|\.parseAsync\s*\(|\bz\.object\b|\bzod\b|\byup\b|\bjoi\b|valibot|superstruct|class-validator|\.validate\s*\(|[A-Za-z_$][\w$]*Schema\s*\.\s*parse\s*\(/i;

/** `Access-Control-Allow-Origin` header name occurrences. */
const ACAO_RE = /access-control-allow-origin/gi;
/** A wildcard value within a short window after the header name. */
const ACAO_WILDCARD_RE = /[:=,]\s*["'`]?\s*\*/;

const GET_SESSION_RE = /\bgetSession\s*\(/;
const GET_USER_RE = /\bgetUser\s*\(/;
/** Signals that an authorization decision is being made in this file. */
const AUTHZ_SIGNAL_RE =
  /(?:\brole\b|\broles\b|is[_-]?admin|permission|authorize|unauthoriz|forbidden|redirect\s*\(|\b401\b|\b403\b)/i;

// --- internal shapes --------------------------------------------------------

interface SecurityFinding {
  file: string;
  line?: number;
  detail: string;
}

interface RichCheck {
  check: CheckResult;
  /** whether a failure of this check blocks the gate verdict */
  required: boolean;
  evidence: EvidenceItem;
}

interface EvidenceFields {
  claim: string;
  status: EvidenceStatus;
  kind: EvidenceKind;
  detail: string;
  command?: string;
  exitCode?: number;
  output?: string;
}

// --- guards -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertGateInputs(root: string, graph: ProjectGraph, config: CortexConfig): void {
  if (typeof root !== 'string' || root.length === 0) {
    throw new GateError('Security gate requires a non-empty repository root path.');
  }
  if (!isRecord(graph) || !Array.isArray(graph.files)) {
    throw new GateError('Security gate requires a valid ProjectGraph (with a files array).');
  }
  if (!isRecord(config)) {
    throw new GateError('Security gate requires a valid CortexConfig.');
  }
}

// --- evidence + check construction ------------------------------------------

function makeEvidence(fields: EvidenceFields): EvidenceItem {
  const item: EvidenceItem = {
    id: randomUUID(),
    claim: fields.claim,
    status: fields.status,
    kind: fields.kind,
    detail: fields.detail,
    createdAt: new Date().toISOString(),
  };
  if (fields.command !== undefined) item.command = fields.command;
  if (fields.exitCode !== undefined) item.exitCode = fields.exitCode;
  if (fields.output !== undefined) item.output = fields.output;
  return item;
}

function renderFinding(finding: SecurityFinding): string {
  const where = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
  return `${where} — ${finding.detail}`;
}

/**
 * Fold a detector's findings into a single required/soft check + backing
 * evidence. A clean detector (zero findings) produces a passing, `verified`
 * check; any finding produces a failing, `refuted` check whose detail enumerates
 * the offending files/lines (capped) — never the secret values themselves.
 */
function buildCategory(
  name: string,
  kind: EvidenceKind,
  subject: string,
  findings: SecurityFinding[],
  required: boolean,
): RichCheck {
  const passed = findings.length === 0;
  const shown = findings.slice(0, MAX_FINDINGS_LISTED).map(renderFinding).join('; ');
  const extra =
    findings.length > MAX_FINDINGS_LISTED ? ` (+${findings.length - MAX_FINDINGS_LISTED} more)` : '';
  const detail = passed
    ? `No ${subject} detected.`
    : `${findings.length} ${subject} finding(s): ${shown}${extra}`;

  const evidence = makeEvidence({
    claim: `No ${subject}`,
    status: passed ? 'verified' : 'refuted',
    kind,
    detail,
  });
  return { required, evidence, check: { name, passed, detail, evidenceId: evidence.id } };
}

// --- file scanning ----------------------------------------------------------

function basenameOf(rel: string): string {
  const normalized = rel.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/** Source files eligible for content scanning (excludes env examples, lockfiles, maps). */
function isScannable(rel: string): boolean {
  const base = basenameOf(rel).toLowerCase();
  if (NON_SCANNABLE_BASENAMES.has(base)) return false;
  if (base.endsWith('.map') || base.endsWith('.min.js')) return false;
  return SOURCE_EXT_RE.test(base);
}

/**
 * Read every scannable source file in the graph once, in parallel. Unreadable
 * files are silently skipped (fail-safe) so one permission error never fails the
 * whole gate.
 */
async function readSources(absRoot: string, graph: ProjectGraph): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const targets = graph.files.filter(
    (node): node is FileNode =>
      isRecord(node) && typeof node.path === 'string' && isScannable(node.path),
  );
  await Promise.all(
    targets.map(async (node) => {
      try {
        contents.set(node.path, await readFile(path.join(absRoot, node.path), 'utf8'));
      } catch {
        // Unreadable file: skip it. This detector simply has nothing to say about it.
      }
    }),
  );
  return contents;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function firstSecretLabel(line: string): string | undefined {
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(line)) return label;
  }
  return undefined;
}

// --- detectors --------------------------------------------------------------

/** Hardcoded provider tokens / secret assignments in source (never echoes the value). */
function detectSecrets(graph: ProjectGraph, contents: ReadonlyMap<string, string>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    let hits = 0;
    for (let i = 0; i < lines.length && hits < MAX_SECRETS_PER_FILE; i += 1) {
      const label = firstSecretLabel(lines[i] ?? '');
      if (label === undefined) continue;
      hits += 1;
      findings.push({
        file: node.path,
        line: i + 1,
        detail: `possible ${label}; move it to an environment variable / secret manager`,
      });
    }
  }
  return findings;
}

/** A NEXT_PUBLIC_* var carrying a real secret — inlined into the public client bundle. */
function detectPublicEnvSecrets(graph: ProjectGraph): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const envVars = Array.isArray(graph.envVars) ? graph.envVars : [];
  for (const env of envVars) {
    if (!isRecord(env) || typeof env.name !== 'string') continue;
    if (!env.name.startsWith('NEXT_PUBLIC_')) continue;
    if (!PUBLIC_SECRET_RE.test(env.name) || KNOWN_PUBLIC_RE.test(env.name)) continue;
    const usedIn = Array.isArray(env.usedIn) ? env.usedIn : [];
    findings.push({
      file: usedIn[0] ?? '(env)',
      detail: `${env.name} is inlined into the public client bundle; use a non-public, server-only variable`,
    });
  }
  return findings;
}

/** A `'use client'` file reading server secrets through process.env (leaked to the browser). */
function detectClientLeaks(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const node of graph.files) {
    if (!CLIENT_KINDS.has(node.kind)) continue;
    const content = contents.get(node.path);
    if (content === undefined || !USE_CLIENT_RE.test(content)) continue;

    const names = new Set<string>();
    PROCESS_ENV_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PROCESS_ENV_RE.exec(content)) !== null) {
      const name = match[1] ?? match[2];
      if (name !== undefined && !name.startsWith('NEXT_PUBLIC_') && SECRET_ENV_RE.test(name)) {
        names.add(name);
      }
    }
    if (names.size > 0) {
      findings.push({
        file: node.path,
        detail: `'use client' file reads server secret(s) via process.env: ${[...names].sort().join(', ')}`,
      });
    }
  }
  return findings;
}

function isHandlerKind(node: FileNode): boolean {
  const p = node.path.toLowerCase();
  return (
    node.kind === 'api' ||
    node.kind === 'billing' ||
    node.kind === 'route' ||
    node.kind === 'middleware' ||
    node.kind === 'service' ||
    p.includes('/api/') ||
    /(^|\/)route\.[cm]?[jt]sx?$/.test(p)
  );
}

function isWebhookHandler(node: FileNode): boolean {
  const p = node.path.toLowerCase();
  const tags = Array.isArray(node.tags) ? node.tags : [];
  const mentionsWebhook = /webhook/.test(p) || tags.includes('webhook') || tags.includes('webhooks');
  const mentionsStripe = /stripe/.test(p) || tags.includes('stripe');
  if (!mentionsWebhook && !mentionsStripe) return false;
  return isHandlerKind(node);
}

/** Webhook/stripe handlers that read the body but never verify the signature. */
function detectWebhookGaps(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const node of graph.files) {
    if (!isWebhookHandler(node)) continue;
    const content = contents.get(node.path);
    if (content === undefined) continue;
    if (WEBHOOK_VERIFY_RE.test(content)) continue;
    findings.push({
      file: node.path,
      detail:
        'webhook handler never verifies the signature (no constructEvent/verify); reject unsigned payloads using the raw body',
    });
  }
  return findings;
}

/** API routes / server actions that consume the request body without schema validation. */
function detectInputValidationGaps(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const node of graph.files) {
    if (isWebhookHandler(node)) continue; // signature verification is that handler's contract
    const content = contents.get(node.path);
    if (content === undefined) continue;

    const p = node.path.toLowerCase();
    const isApi = node.kind === 'api' || p.includes('/api/');
    const isServerAction = USE_SERVER_RE.test(content);
    if (!isApi && !isServerAction) continue;

    if (BODY_READ_RE.test(content) && !VALIDATION_RE.test(content)) {
      findings.push({
        file: node.path,
        detail:
          'reads the request body without a schema/zod parse; validate untrusted input before use',
      });
    }
  }
  return findings;
}

/** A wildcard `Access-Control-Allow-Origin: *` anywhere in source. */
function detectCors(graph: ProjectGraph, contents: ReadonlyMap<string, string>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;
    ACAO_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let hit = false;
    while ((match = ACAO_RE.exec(content)) !== null) {
      const window = content.slice(match.index, match.index + 60);
      if (ACAO_WILDCARD_RE.test(window)) {
        findings.push({
          file: node.path,
          line: lineOf(content, match.index),
          detail: 'Access-Control-Allow-Origin: * exposes the endpoint to every origin; pin an allowlist',
        });
        hit = true;
        break; // one CORS finding per file is enough
      }
    }
    if (hit) continue;
  }
  return findings;
}

/** `getSession()` used to decide authorization where `getUser()` (re-validated) is required. */
function detectAuthRisk(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const node of graph.files) {
    if (!AUTHZ_KINDS.has(node.kind)) continue;
    const content = contents.get(node.path);
    if (content === undefined) continue;
    if (!GET_SESSION_RE.test(content) || GET_USER_RE.test(content)) continue;
    if (!AUTHZ_SIGNAL_RE.test(content)) continue;
    findings.push({
      file: node.path,
      detail:
        'decides authorization from getSession() (unverified storage read); use getUser() which re-validates with the auth server',
    });
  }
  return findings;
}

// --- advisory dependency audit ----------------------------------------------

async function isFileAt(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

/**
 * Best-effort `pnpm/npm audit`. Advisory only (never blocks): a missing lockfile,
 * a nonzero exit (vulnerabilities or offline registry), or a spawn failure all
 * degrade to a non-blocking check rather than throwing.
 */
async function runDependencyAudit(root: string): Promise<RichCheck> {
  const name = 'dependency-audit';

  let command: string | undefined;
  if (await isFileAt(path.join(root, 'pnpm-lock.yaml'))) command = 'pnpm audit --json';
  else if (await isFileAt(path.join(root, 'package-lock.json'))) command = 'npm audit --json';

  if (command === undefined) {
    const detail = 'No pnpm/npm lockfile found; dependency audit skipped (advisory).';
    const evidence = makeEvidence({ claim: 'Dependency audit', status: 'unverified', kind: 'command', detail });
    return { required: false, evidence, check: { name, passed: true, detail, evidenceId: evidence.id } };
  }

  try {
    const raw = await verifyCommandResult(command, { cwd: root, timeoutMs: AUDIT_TIMEOUT_MS });
    const passed = raw.status === 'verified';
    const detail = passed
      ? `${command} reported no known vulnerabilities.`
      : `${command} exited ${raw.exitCode ?? 'nonzero'} — review advisories (advisory, non-blocking).`;
    const evidence = makeEvidence({
      claim: `Dependency audit (${command}) finds no known vulnerabilities`,
      status: raw.status,
      kind: 'command',
      detail,
      ...(raw.command !== undefined ? { command: raw.command } : {}),
      ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
      ...(raw.output !== undefined ? { output: raw.output } : {}),
    });
    return { required: false, evidence, check: { name, passed, detail, evidenceId: evidence.id } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const detail = `Dependency audit could not run (${reason}); skipped (advisory).`;
    const evidence = makeEvidence({ claim: 'Dependency audit', status: 'unverified', kind: 'command', detail });
    return { required: false, evidence, check: { name, passed: true, detail, evidenceId: evidence.id } };
  }
}

// --- public entrypoint ------------------------------------------------------

/**
 * Run the deep security gate against `root`. Returns the `GateResult` (whose
 * `passed` reflects only the required heuristic checks) plus every collected
 * `EvidenceItem`. Findings are `CheckResult`s, never exceptions; `GateError` is
 * thrown only on invalid input or an internal failure.
 *
 * @param root   absolute repo root the graph was scanned from.
 * @param graph  the project graph (from `scanProject`/`loadGraph`).
 * @param config the workspace config.
 */
export async function runSecurityGate(
  root: string,
  graph: ProjectGraph,
  config: CortexConfig,
): Promise<{ result: GateResult; evidence: EvidenceItem[] }> {
  assertGateInputs(root, graph, config);
  const absRoot = path.resolve(root);

  try {
    const contents = await readSources(absRoot, graph);

    const rich: RichCheck[] = [
      buildCategory('secrets', 'file', 'hardcoded secret', detectSecrets(graph, contents), true),
      buildCategory(
        'client-secret-env',
        'env',
        'secret exposed via NEXT_PUBLIC_ env var',
        detectPublicEnvSecrets(graph),
        true,
      ),
      buildCategory(
        'client-secret-leak',
        'file',
        'server secret read in a client component',
        detectClientLeaks(graph, contents),
        true,
      ),
      buildCategory(
        'webhook-signature',
        'file',
        'unverified webhook handler',
        detectWebhookGaps(graph, contents),
        true,
      ),
      buildCategory(
        'input-validation',
        'file',
        'unvalidated request body',
        detectInputValidationGaps(graph, contents),
        true,
      ),
      buildCategory('cors', 'file', 'wildcard CORS origin', detectCors(graph, contents), true),
      buildCategory('auth-risk', 'file', 'insecure authorization check', detectAuthRisk(graph, contents), true),
      await runDependencyAudit(absRoot),
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
    throw new GateError(`Security gate failed at ${absRoot}`, { cause: err });
  }
}
