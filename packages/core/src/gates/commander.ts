/**
 * DevOps Commander (§7.21) — a READ-ONLY, TOKENLESS, DETERMINISTIC deployment
 * diagnostician. Every function inspects the repo (real file reads) + the
 * `ProjectGraph` and returns a structured `Diagnostic` (findings + an `ok`
 * flag); nothing here mutates the filesystem, spawns a deploy, or calls an LLM.
 *
 * File reads are fail-safe: an unreadable/absent file degrades the relevant
 * diagnostic to `applicable: false` or a warning finding — it never aborts the
 * scan. The only thrown error is `GateError` on invalid input (empty root /
 * malformed graph); a detected deployment defect is a finding, never an
 * exception.
 *
 * Diagnostics (each is independently callable):
 *   diagnoseDocker            Dockerfile present, non-root final USER, multi-stage,
 *                             no secret COPY, pinned base image
 *   diagnoseVercel            Vercel/Next build readiness (vercel.json parses,
 *                             build script, next.config)
 *   diagnoseGithubActions     .github/workflows/* parse + trigger/job summary
 *   diagnoseK8s               workload manifests enforce runAsNonRoot / not privileged
 *   productionConfigCheck     every referenced env var documented in .env.example
 *   secretsExposureCheck      dotenv/keys/credentials in the tree are gitignored
 *   ciHealth                  a CI provider is configured and its config parses
 *   deploymentReadiness       aggregate readiness roll-up over all of the above
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import picomatch from 'picomatch';
import { parseAllDocuments } from 'yaml';

import { GateError } from '../domain/index';
import type { CortexConfig, ProjectGraph } from '../domain/index';

// --- public types -----------------------------------------------------------

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface DiagnosticFinding {
  /** `error` blocks readiness; `warning` is advisory; `info` is contextual. */
  severity: DiagnosticSeverity;
  message: string;
  /** repo-relative POSIX path the finding refers to, when applicable. */
  file?: string;
  line?: number;
}

export interface Diagnostic {
  /** stable diagnostic id, e.g. `docker`, `k8s`, `ci`. */
  name: string;
  /** whether the diagnostic's subject exists in the repo at all. */
  applicable: boolean;
  /** true when the (applicable) diagnostic found no error-severity finding. */
  ok: boolean;
  findings: DiagnosticFinding[];
  /** one-line human summary. */
  summary: string;
}

export const DEPLOYMENT_READINESS_LEVELS = ['READY', 'READY_WITH_WARNINGS', 'NOT_READY'] as const;
export type DeploymentReadinessLevel = (typeof DEPLOYMENT_READINESS_LEVELS)[number];

export interface DeploymentReadiness {
  /** true when no diagnostic produced an error-severity finding. */
  ok: boolean;
  level: DeploymentReadinessLevel;
  diagnostics: Diagnostic[];
  /** every finding across all diagnostics, flattened, in diagnostic order. */
  findings: DiagnosticFinding[];
  summary: string;
}

// --- constants --------------------------------------------------------------

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
]);

/** Directories a Kubernetes manifest is conventionally found in. */
const K8S_DIRS = [
  'k8s',
  'kubernetes',
  'manifests',
  'deploy',
  'deployment',
  'deployments',
  '.k8s',
  'helm',
  'charts',
  'infra',
  'ops',
];

/** Kubernetes workload kinds that own a pod template we can inspect. */
const WORKLOAD_KINDS: ReadonlySet<string> = new Set([
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
  'CronJob',
]);

/** Env vars supplied by the platform/runtime — not expected in `.env.example`. */
const PLATFORM_ENV: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'PORT',
  'HOST',
  'HOSTNAME',
  'CI',
  'TZ',
  'LANG',
  'PWD',
  'HOME',
  'PATH',
  'TMPDIR',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_REGION',
  'NEXT_RUNTIME',
  'NEXT_PHASE',
]);

const ENV_EXAMPLE_FILES = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.defaults',
  'env.example',
];

/** File-based CI providers (path relative to root -> label). */
const FILE_CI_PROVIDERS: ReadonlyArray<{ file: string; name: string; yaml: boolean }> = [
  { file: '.gitlab-ci.yml', name: 'GitLab CI', yaml: true },
  { file: '.circleci/config.yml', name: 'CircleCI', yaml: true },
  { file: '.travis.yml', name: 'Travis CI', yaml: true },
  { file: 'azure-pipelines.yml', name: 'Azure Pipelines', yaml: true },
  { file: 'Jenkinsfile', name: 'Jenkins', yaml: false },
  { file: 'bitbucket-pipelines.yml', name: 'Bitbucket Pipelines', yaml: true },
  { file: '.drone.yml', name: 'Drone CI', yaml: true },
];

/** A secret-bearing path: dotenv (non-example), private keys, credentials. */
const SECRET_PATH_RE =
  /(^|\/)\.env(\.[a-z0-9_.-]+)?$|\.pem$|\.key$|\.p12$|\.pfx$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|(^|\/)\.npmrc$|(^|\/)credentials(\.json|\.ya?ml)?$|(^|\/)\.aws(\/|$)|(^|\/)secrets?(\/|$)/i;
/** Templates / public keys are safe to copy or commit. */
const SECRET_PATH_EXCLUDE = /\.env\.(example|sample|template|dist|defaults)$|\.pub$/i;

// --- shared guards / fs helpers ---------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRoot(root: string, fn: string): void {
  if (typeof root !== 'string' || root.length === 0) {
    throw new GateError(`${fn} requires a non-empty repository root path.`);
  }
}

function assertGraph(graph: ProjectGraph, fn: string): void {
  if (!isRecord(graph) || !Array.isArray(graph.files) || !Array.isArray(graph.envVars)) {
    throw new GateError(`${fn} requires a valid ProjectGraph (with files + envVars arrays).`);
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function basenameOf(rel: string): string {
  const normalized = toPosix(rel);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

async function readFileSafe(abs: string): Promise<string | undefined> {
  try {
    return await readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
}

async function isFileAt(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

async function isDirAt(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

async function firstExistingFile(absRoot: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    if (await isFileAt(path.join(absRoot, name))) return name;
  }
  return undefined;
}

/**
 * Bounded, degrade-don't-crash recursive file collector. Returns repo-relative
 * POSIX paths of every file (under `absDir`) whose relative path + basename
 * satisfy `match`, skipping vendored/build directories and capping total work.
 */
async function collectFiles(
  absDir: string,
  match: (rel: string, base: string) => boolean,
  maxDepth = 5,
  cap = 4000,
): Promise<string[]> {
  const out: string[] = [];

  async function recur(current: string, relDir: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= cap) return;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= cap) return;
      const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recur(path.join(current, entry.name), rel, depth + 1);
      } else if (entry.isFile() && match(rel, entry.name)) {
        out.push(rel);
      }
    }
  }

  await recur(absDir, '', 0);
  out.sort();
  return out;
}

// --- diagnostic construction ------------------------------------------------

function makeDiagnostic(
  name: string,
  applicable: boolean,
  findings: DiagnosticFinding[],
  summary: string,
): Diagnostic {
  const ok = applicable ? findings.every((f) => f.severity !== 'error') : true;
  return { name, applicable, ok, findings, summary };
}

function countBy(findings: DiagnosticFinding[], severity: DiagnosticSeverity): number {
  return findings.filter((f) => f.severity === severity).length;
}

// --- yaml ------------------------------------------------------------------

/** Parse a (possibly multi-document) YAML string, tolerating errors per-doc. */
function parseYamlDocuments(content: string): { docs: unknown[]; errors: string[] } {
  const docs: unknown[] = [];
  const errors: string[] = [];
  let parsed: ReturnType<typeof parseAllDocuments>;
  try {
    parsed = parseAllDocuments(content, { logLevel: 'silent' });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { docs, errors };
  }
  for (const doc of parsed) {
    if (doc.errors.length > 0) {
      const first = doc.errors[0];
      errors.push(first ? first.message : 'YAML parse error');
      continue;
    }
    docs.push(doc.toJS());
  }
  return { docs, errors };
}

// ============================================================================
// Docker
// ============================================================================

interface DockerfileInfo {
  fromCount: number;
  finalUser: string | undefined;
  finalUserLine: number | undefined;
  finalUserExplicit: boolean;
  secretCopies: Array<{ spec: string; line: number }>;
  copyAllLines: number[];
  unpinnedBases: Array<{ image: string; line: number }>;
}

function isDockerfileName(base: string): boolean {
  const b = base.toLowerCase();
  if (b === '.dockerignore') return false;
  return b === 'dockerfile' || b.startsWith('dockerfile.') || b.endsWith('.dockerfile');
}

/** Collapse comments + line-continuations into logical instruction lines. */
function logicalDockerLines(content: string): Array<{ text: string; line: number }> {
  const raw = content.split(/\r?\n/);
  const result: Array<{ text: string; line: number }> = [];
  let buffer = '';
  let startLine = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const original = raw[i] ?? '';
    const trimmed = original.trimStart();
    if (buffer.length === 0 && (trimmed.length === 0 || trimmed.startsWith('#'))) continue;
    if (buffer.length === 0) startLine = i + 1;
    const continues = /\\\s*$/.test(original);
    const cleaned = original.replace(/\\\s*$/, '').trim();
    buffer = buffer.length > 0 ? `${buffer} ${cleaned}` : cleaned;
    if (!continues) {
      result.push({ text: buffer, line: startLine });
      buffer = '';
    }
  }
  if (buffer.length > 0) result.push({ text: buffer, line: startLine });
  return result;
}

function isRootUser(user: string | undefined): boolean {
  if (user === undefined) return false;
  const u = user.replace(/^["']|["']$/g, '').toLowerCase();
  return /^(0|root)(:(0|root))?$/.test(u);
}

function isSecretPath(spec: string): boolean {
  const clean = spec.replace(/^["']|["']$/g, '');
  if (SECRET_PATH_EXCLUDE.test(clean)) return false;
  return SECRET_PATH_RE.test(clean);
}

function parseDockerfile(content: string): DockerfileInfo {
  const lines = logicalDockerLines(content);
  const stageAliases = new Set<string>();
  const secretCopies: Array<{ spec: string; line: number }> = [];
  const copyAllLines: number[] = [];
  const unpinnedBases: Array<{ image: string; line: number }> = [];
  let fromCount = 0;
  let finalUser: string | undefined;
  let finalUserLine: number | undefined;
  let finalUserExplicit = false;

  for (const { text, line } of lines) {
    const m = /^(\w+)\s+(.*)$/.exec(text);
    if (!m) continue;
    const instruction = (m[1] ?? '').toUpperCase();
    const args = (m[2] ?? '').trim();

    if (instruction === 'FROM') {
      fromCount += 1;
      // A new build stage inherits its user from its own base image, not from a
      // previous stage — reset the final-stage user tracking.
      finalUser = undefined;
      finalUserLine = undefined;
      finalUserExplicit = false;

      const parts = args.split(/\s+/).filter((p) => p.length > 0);
      const image = parts[0] ?? '';
      const asIdx = parts.findIndex((p) => p.toLowerCase() === 'as');
      if (asIdx !== -1) {
        const alias = parts[asIdx + 1];
        if (alias !== undefined) stageAliases.add(alias.toLowerCase());
      }
      const imgLower = image.toLowerCase();
      if (
        image.length > 0 &&
        imgLower !== 'scratch' &&
        !stageAliases.has(imgLower) &&
        !image.includes('$')
      ) {
        const digestPinned = image.includes('@');
        const tag = image.split(':')[1] ?? '';
        if (!digestPinned && (tag.length === 0 || tag.toLowerCase() === 'latest')) {
          unpinnedBases.push({ image, line });
        }
      }
    } else if (instruction === 'USER') {
      const val = args.split(/\s+/)[0] ?? '';
      finalUser = val;
      finalUserLine = line;
      finalUserExplicit = val.length > 0;
    } else if (instruction === 'COPY' || instruction === 'ADD') {
      const tokens = args.split(/\s+/).filter((t) => t.length > 0);
      const fromFlag = tokens.some((t) => /^--from=/i.test(t));
      const sources = tokens.filter((t) => !t.startsWith('--'));
      // Last token is the destination; everything before it is a source.
      const srcs = sources.slice(0, Math.max(0, sources.length - 1));
      for (const src of srcs) {
        if (fromFlag) continue; // `--from=<stage>` copies from an image layer, not the build context
        if (src === '.') copyAllLines.push(line);
        if (isSecretPath(src)) secretCopies.push({ spec: src, line });
      }
    }
  }

  return {
    fromCount,
    finalUser,
    finalUserLine,
    finalUserExplicit,
    secretCopies,
    copyAllLines,
    unpinnedBases,
  };
}

/**
 * Diagnose every Dockerfile in the repo: non-root final `USER`, multi-stage,
 * no secret `COPY`, pinned base image, and a `.dockerignore` guarding `COPY . .`.
 */
export async function diagnoseDocker(root: string): Promise<Diagnostic> {
  assertRoot(root, 'diagnoseDocker');
  const absRoot = path.resolve(root);
  const files = await collectFiles(absRoot, (_rel, base) => isDockerfileName(base), 4);

  if (files.length === 0) {
    return makeDiagnostic(
      'docker',
      false,
      [{ severity: 'info', message: 'No Dockerfile found; container image checks skipped.' }],
      'No Dockerfile present.',
    );
  }

  const hasDockerignore = await isFileAt(path.join(absRoot, '.dockerignore'));
  const findings: DiagnosticFinding[] = [];

  for (const rel of files) {
    const content = await readFileSafe(path.join(absRoot, rel));
    if (content === undefined) {
      findings.push({ severity: 'warning', file: rel, message: 'Dockerfile could not be read.' });
      continue;
    }
    const info = parseDockerfile(content);

    if (!info.finalUserExplicit) {
      findings.push({
        severity: 'error',
        file: rel,
        message:
          'no USER instruction in the final stage; the container runs as root. Add a non-root `USER`.',
      });
    } else if (isRootUser(info.finalUser)) {
      const finding: DiagnosticFinding = {
        severity: 'error',
        file: rel,
        message: `final stage runs as root (USER ${info.finalUser ?? 'root'}); switch to a non-root user.`,
      };
      if (info.finalUserLine !== undefined) finding.line = info.finalUserLine;
      findings.push(finding);
    }

    if (info.fromCount <= 1) {
      findings.push({
        severity: 'warning',
        file: rel,
        message:
          'single-stage build; use a multi-stage build to keep build tooling and dev dependencies out of the final image.',
      });
    }

    for (const secret of info.secretCopies) {
      findings.push({
        severity: 'error',
        file: rel,
        line: secret.line,
        message: `copies a secret-bearing path into the image (${secret.spec}); use build secrets or runtime env instead.`,
      });
    }

    if (!hasDockerignore) {
      for (const line of info.copyAllLines) {
        findings.push({
          severity: 'warning',
          file: rel,
          line,
          message: '`COPY . .` without a .dockerignore may bake secrets/artifacts into the image.',
        });
      }
    }

    for (const base of info.unpinnedBases) {
      findings.push({
        severity: 'warning',
        file: rel,
        line: base.line,
        message: `unpinned base image (${base.image}); pin to a specific tag or digest for reproducible builds.`,
      });
    }
  }

  const summary = `${files.length} Dockerfile(s) analysed; ${countBy(findings, 'error')} blocking issue(s), ${countBy(findings, 'warning')} warning(s).`;
  return makeDiagnostic('docker', true, findings, summary);
}

// ============================================================================
// Vercel / build readiness
// ============================================================================

/** Diagnose Vercel/Next build readiness: vercel.json parses, build script, config. */
export async function diagnoseVercel(root: string, graph: ProjectGraph): Promise<Diagnostic> {
  assertRoot(root, 'diagnoseVercel');
  assertGraph(graph, 'diagnoseVercel');
  const absRoot = path.resolve(root);

  const stack = isRecord(graph.stack) ? graph.stack : undefined;
  const framework = stack && typeof stack.framework === 'string' ? stack.framework : 'unknown';
  const targets =
    stack && Array.isArray(stack.deploymentTargets)
      ? stack.deploymentTargets.filter((t): t is string => typeof t === 'string')
      : [];
  const hasVercelJson = await isFileAt(path.join(absRoot, 'vercel.json'));
  const targetsVercel = targets.some((t) => t.toLowerCase().includes('vercel'));
  const isNext = framework === 'nextjs';
  const applicable = hasVercelJson || targetsVercel || isNext;

  if (!applicable) {
    return makeDiagnostic(
      'vercel',
      false,
      [{ severity: 'info', message: 'No Vercel/Next.js build target detected; build checks skipped.' }],
      'No Vercel deployment target.',
    );
  }

  const findings: DiagnosticFinding[] = [];

  if (hasVercelJson) {
    const content = await readFileSafe(path.join(absRoot, 'vercel.json'));
    if (content === undefined) {
      findings.push({ severity: 'warning', file: 'vercel.json', message: 'vercel.json could not be read.' });
    } else {
      try {
        JSON.parse(content);
      } catch (err) {
        findings.push({
          severity: 'error',
          file: 'vercel.json',
          message: `vercel.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); the deploy cannot parse it.`,
        });
      }
    }
  }

  const scripts = isRecord(graph.scripts) ? graph.scripts : {};
  const buildScript = scripts['build'];
  if (typeof buildScript !== 'string' || buildScript.trim().length === 0) {
    findings.push({
      severity: 'warning',
      message: 'no `build` script defined; Vercel/CI cannot produce a production build.',
    });
  }

  if (isNext) {
    const cfg = await firstExistingFile(absRoot, [
      'next.config.js',
      'next.config.mjs',
      'next.config.ts',
      'next.config.cjs',
    ]);
    if (cfg === undefined) {
      findings.push({
        severity: 'info',
        message: 'no next.config.* found; the build relies entirely on framework defaults.',
      });
    }
  }

  const summary = `Vercel/Next build readiness: ${countBy(findings, 'error')} blocking, ${countBy(findings, 'warning')} warning(s).`;
  return makeDiagnostic('vercel', true, findings, summary);
}

// ============================================================================
// GitHub Actions
// ============================================================================

function extractTriggers(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((t): t is string => typeof t === 'string');
  if (isRecord(on)) return Object.keys(on);
  return [];
}

/** Parse `.github/workflows/*` and summarise workflows, jobs, and triggers. */
export async function diagnoseGithubActions(root: string): Promise<Diagnostic> {
  assertRoot(root, 'diagnoseGithubActions');
  const absRoot = path.resolve(root);
  const wfDir = path.join(absRoot, '.github', 'workflows');

  if (!(await isDirAt(wfDir))) {
    return makeDiagnostic(
      'github-actions',
      false,
      [{ severity: 'info', message: 'No .github/workflows directory; GitHub Actions checks skipped.' }],
      'No GitHub Actions workflows.',
    );
  }

  const files = await collectFiles(wfDir, (_rel, base) => /\.ya?ml$/i.test(base), 1);
  if (files.length === 0) {
    return makeDiagnostic(
      'github-actions',
      false,
      [{ severity: 'info', message: '.github/workflows is present but contains no workflow files.' }],
      'No workflow files.',
    );
  }

  const findings: DiagnosticFinding[] = [];
  const triggers = new Set<string>();
  let workflowCount = 0;
  let jobCount = 0;

  for (const rel of files) {
    const wfRel = `.github/workflows/${rel}`;
    const content = await readFileSafe(path.join(wfDir, rel));
    if (content === undefined) {
      findings.push({ severity: 'warning', file: wfRel, message: 'workflow could not be read.' });
      continue;
    }
    const { docs, errors } = parseYamlDocuments(content);
    if (errors.length > 0) {
      findings.push({ severity: 'error', file: wfRel, message: `workflow YAML failed to parse: ${errors[0]}` });
      continue;
    }
    const doc = docs[0];
    if (!isRecord(doc)) {
      findings.push({ severity: 'warning', file: wfRel, message: 'workflow is not a YAML mapping.' });
      continue;
    }
    workflowCount += 1;
    for (const trigger of extractTriggers(doc['on'])) triggers.add(trigger);
    if (isRecord(doc['jobs'])) jobCount += Object.keys(doc['jobs']).length;
  }

  if (workflowCount > 0 && !triggers.has('push') && !triggers.has('pull_request')) {
    findings.push({
      severity: 'warning',
      message: 'no workflow triggers on push or pull_request; CI may not run on code changes.',
    });
  }

  const triggerList = [...triggers].sort().join(', ');
  const summary = `${workflowCount} workflow(s), ${jobCount} job(s); triggers: ${triggerList.length > 0 ? triggerList : 'none'}.`;
  return makeDiagnostic('github-actions', workflowCount > 0, findings, summary);
}

// ============================================================================
// Kubernetes
// ============================================================================

function securityEnforcesNonRoot(sc: Record<string, unknown>): boolean {
  if (sc['runAsNonRoot'] === true) return true;
  const uid = sc['runAsUser'];
  return typeof uid === 'number' && uid > 0;
}

function extractPodSpec(doc: Record<string, unknown>, kind: string): Record<string, unknown> | undefined {
  const spec = isRecord(doc['spec']) ? doc['spec'] : undefined;
  if (spec === undefined) return undefined;
  if (kind === 'Pod') return spec;
  if (kind === 'CronJob') {
    const jobTemplate = isRecord(spec['jobTemplate']) ? spec['jobTemplate'] : undefined;
    const jobSpec = jobTemplate && isRecord(jobTemplate['spec']) ? jobTemplate['spec'] : undefined;
    const template = jobSpec && isRecord(jobSpec['template']) ? jobSpec['template'] : undefined;
    return template && isRecord(template['spec']) ? template['spec'] : undefined;
  }
  const template = isRecord(spec['template']) ? spec['template'] : undefined;
  return template && isRecord(template['spec']) ? template['spec'] : undefined;
}

function collectContainers(pod: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const key of ['containers', 'initContainers', 'ephemeralContainers']) {
    const arr = pod[key];
    if (Array.isArray(arr)) {
      for (const c of arr) if (isRecord(c)) out.push(c);
    }
  }
  return out;
}

function analyzeWorkload(
  kind: string,
  name: string,
  file: string,
  pod: Record<string, unknown> | undefined,
  findings: DiagnosticFinding[],
): void {
  if (pod === undefined) {
    findings.push({
      severity: 'warning',
      file,
      message: `${kind}/${name} has no pod template spec to inspect for a securityContext.`,
    });
    return;
  }

  const podSc = isRecord(pod['securityContext']) ? pod['securityContext'] : undefined;
  const podNonRoot = podSc !== undefined && securityEnforcesNonRoot(podSc);
  const containers = collectContainers(pod);

  const offenders: string[] = [];
  for (const container of containers) {
    const cName = typeof container['name'] === 'string' ? container['name'] : '(unnamed)';
    const cSc = isRecord(container['securityContext']) ? container['securityContext'] : undefined;
    const containerNonRoot = cSc !== undefined && securityEnforcesNonRoot(cSc);
    if (!podNonRoot && !containerNonRoot) offenders.push(cName);
    if (cSc !== undefined && cSc['privileged'] === true) {
      findings.push({
        severity: 'error',
        file,
        message: `${kind}/${name} container "${cName}" runs privileged; remove privileged: true.`,
      });
    }
  }

  if (containers.length === 0) {
    if (!podNonRoot) {
      findings.push({
        severity: 'error',
        file,
        message: `${kind}/${name} does not enforce runAsNonRoot at the pod level; set securityContext.runAsNonRoot: true.`,
      });
    }
  } else if (offenders.length > 0) {
    findings.push({
      severity: 'error',
      file,
      message: `${kind}/${name} does not enforce runAsNonRoot (pod-level unset and container(s) ${offenders.join(', ')} unset); set securityContext.runAsNonRoot: true.`,
    });
  }
}

/** Diagnose Kubernetes workload manifests: runAsNonRoot enforced, not privileged. */
export async function diagnoseK8s(root: string): Promise<Diagnostic> {
  assertRoot(root, 'diagnoseK8s');
  const absRoot = path.resolve(root);

  const candidates = new Set<string>();
  for (const dir of K8S_DIRS) {
    const absDir = path.join(absRoot, dir);
    if (await isDirAt(absDir)) {
      for (const rel of await collectFiles(absDir, (_rel, base) => /\.ya?ml$/i.test(base), 4)) {
        candidates.add(`${dir}/${rel}`);
      }
    }
  }
  // Root-level manifests (single-file deploys) — depth 0 only.
  for (const rel of await collectFiles(absRoot, (r, b) => /\.ya?ml$/i.test(b) && !r.includes('/'), 0)) {
    candidates.add(rel);
  }

  const findings: DiagnosticFinding[] = [];
  const workloads: string[] = [];

  for (const rel of [...candidates].sort()) {
    const content = await readFileSafe(path.join(absRoot, rel));
    if (content === undefined) continue;
    // Cheap pre-filter: a k8s manifest declares both apiVersion and kind.
    if (!/\bkind\s*:/.test(content) || !/\bapiVersion\s*:/.test(content)) continue;

    const { docs } = parseYamlDocuments(content);
    for (const doc of docs) {
      if (!isRecord(doc)) continue;
      const kind = typeof doc['kind'] === 'string' ? doc['kind'] : '';
      if (!WORKLOAD_KINDS.has(kind)) continue;
      const metadata = isRecord(doc['metadata']) ? doc['metadata'] : undefined;
      const name = metadata && typeof metadata['name'] === 'string' ? metadata['name'] : '(unnamed)';
      workloads.push(`${kind}/${name}`);
      analyzeWorkload(kind, name, rel, extractPodSpec(doc, kind), findings);
    }
  }

  if (workloads.length === 0) {
    return makeDiagnostic(
      'k8s',
      false,
      [{ severity: 'info', message: 'No Kubernetes workload manifests found; k8s security checks skipped.' }],
      'No Kubernetes workloads.',
    );
  }

  const summary = `${workloads.length} workload(s) analysed; ${countBy(findings, 'error')} runAsNonRoot/privileged issue(s).`;
  return makeDiagnostic('k8s', true, findings, summary);
}

// ============================================================================
// Production config (env documentation)
// ============================================================================

function parseEnvNames(content: string): string[] {
  const names: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const m = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
    if (m && m[1] !== undefined) names.push(m[1]);
  }
  return names;
}

/** Every application env var referenced in the graph is documented in `.env.example`. */
export async function productionConfigCheck(root: string, graph: ProjectGraph): Promise<Diagnostic> {
  assertRoot(root, 'productionConfigCheck');
  assertGraph(graph, 'productionConfigCheck');
  const absRoot = path.resolve(root);

  const referenced = new Set<string>();
  for (const env of graph.envVars) {
    if (!isRecord(env) || typeof env.name !== 'string' || env.name.length === 0) continue;
    if (PLATFORM_ENV.has(env.name) || env.name.startsWith('npm_')) continue;
    referenced.add(env.name);
  }

  if (referenced.size === 0) {
    return makeDiagnostic(
      'production-config',
      false,
      [
        {
          severity: 'info',
          message: 'No application environment variables referenced; env documentation check skipped.',
        },
      ],
      'No application env vars referenced.',
    );
  }

  const documented = new Set<string>();
  let exampleFound: string | undefined;
  for (const file of ENV_EXAMPLE_FILES) {
    const content = await readFileSafe(path.join(absRoot, file));
    if (content === undefined) continue;
    exampleFound = exampleFound ?? file;
    for (const name of parseEnvNames(content)) documented.add(name);
  }

  const findings: DiagnosticFinding[] = [];
  if (exampleFound === undefined) {
    findings.push({
      severity: 'warning',
      message: `no .env.example found although ${referenced.size} env var(s) are referenced; add one so required configuration is discoverable.`,
    });
  }

  const undocumented = [...referenced].filter((name) => !documented.has(name)).sort();
  const exampleLabel = exampleFound ?? '.env.example';
  for (const name of undocumented) {
    findings.push({
      severity: 'error',
      message: `env var "${name}" is referenced in code but not documented in ${exampleLabel}.`,
    });
  }

  const summary = `${referenced.size} application env var(s); ${undocumented.length} undocumented.`;
  return makeDiagnostic('production-config', true, findings, summary);
}

// ============================================================================
// Secrets exposure
// ============================================================================

function parseGitignore(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    out.push(line);
  }
  return out;
}

function isGitignored(rel: string, patterns: string[]): boolean {
  const norm = toPosix(rel).replace(/^\.\//, '');
  const base = basenameOf(norm);
  for (const raw of patterns) {
    if (raw.startsWith('!')) continue; // negation: conservatively do not treat as "ignored"
    const pattern = raw.replace(/^\/+/, '').replace(/\/+$/, '');
    if (pattern.length === 0) continue;
    if (pattern === norm || pattern === base) return true;
    let matcher: (input: string) => boolean;
    try {
      matcher = picomatch(pattern, { dot: true });
    } catch {
      continue;
    }
    if (matcher(norm) || matcher(base)) return true;
    try {
      const deep = picomatch(`${pattern}/**`, { dot: true });
      if (deep(norm)) return true;
    } catch {
      // ignore an un-globbable derived pattern
    }
  }
  return false;
}

function secretFileLabel(base: string): string {
  const b = base.toLowerCase();
  if (b.startsWith('.env')) return 'dotenv file';
  if (b.endsWith('.pem')) return 'PEM private key';
  if (b.endsWith('.key')) return 'private key';
  if (b.endsWith('.p12') || b.endsWith('.pfx')) return 'key bundle';
  if (b.startsWith('id_')) return 'SSH private key';
  if (b === '.npmrc') return 'npmrc (may hold an auth token)';
  if (b.includes('credential')) return 'credentials file';
  return 'secret-bearing file';
}

/** Dotenv/private-key/credentials files in the working tree must be gitignored. */
export async function secretsExposureCheck(root: string, graph: ProjectGraph): Promise<Diagnostic> {
  assertRoot(root, 'secretsExposureCheck');
  assertGraph(graph, 'secretsExposureCheck');
  const absRoot = path.resolve(root);

  const candidates = await collectFiles(
    absRoot,
    (_rel, base) => !SECRET_PATH_EXCLUDE.test(base) && SECRET_PATH_RE.test(base),
    3,
  );

  if (candidates.length === 0) {
    return makeDiagnostic(
      'secrets-exposure',
      false,
      [
        {
          severity: 'info',
          message: 'No secret-bearing files (dotenv/keys/credentials) present in the working tree.',
        },
      ],
      'No secret-bearing files present.',
    );
  }

  const gitignore = await readFileSafe(path.join(absRoot, '.gitignore'));
  const patterns = gitignore !== undefined ? parseGitignore(gitignore) : [];
  const findings: DiagnosticFinding[] = [];

  for (const rel of candidates) {
    const label = secretFileLabel(basenameOf(rel));
    if (isGitignored(rel, patterns)) {
      findings.push({ severity: 'info', file: rel, message: `${label} present but gitignored (not committed).` });
    } else {
      findings.push({
        severity: 'error',
        file: rel,
        message: `${label} is in the working tree and not covered by .gitignore; it risks being committed. Add it to .gitignore and rotate the secret if it was ever pushed.`,
      });
    }
  }

  const summary = `${candidates.length} secret-bearing file(s); ${countBy(findings, 'error')} not gitignored.`;
  return makeDiagnostic('secrets-exposure', true, findings, summary);
}

// ============================================================================
// CI health
// ============================================================================

/** A CI provider is configured, and any YAML-based config parses. */
export async function ciHealth(root: string): Promise<Diagnostic> {
  assertRoot(root, 'ciHealth');
  const absRoot = path.resolve(root);

  const present: string[] = [];
  const findings: DiagnosticFinding[] = [];

  const gh = await diagnoseGithubActions(root);
  if (gh.applicable) {
    present.push('GitHub Actions');
    for (const f of gh.findings) if (f.severity === 'error') findings.push(f);
  }

  for (const provider of FILE_CI_PROVIDERS) {
    const abs = path.join(absRoot, provider.file);
    if (!(await isFileAt(abs))) continue;
    present.push(provider.name);
    if (!provider.yaml) continue;
    const content = await readFileSafe(abs);
    if (content === undefined) continue;
    const { errors } = parseYamlDocuments(content);
    if (errors.length > 0) {
      findings.push({
        severity: 'error',
        file: provider.file,
        message: `${provider.name} config failed to parse: ${errors[0]}`,
      });
    }
  }

  if (present.length === 0) {
    findings.push({
      severity: 'warning',
      message:
        'no CI configuration detected (GitHub Actions / GitLab / CircleCI / …); add a pipeline that runs typecheck, lint, build, and test on every push.',
    });
    return makeDiagnostic('ci', true, findings, 'No CI configuration detected.');
  }

  const summary = `CI providers: ${[...new Set(present)].sort().join(', ')}.`;
  return makeDiagnostic('ci', true, findings, summary);
}

// ============================================================================
// Deployment readiness (aggregate)
// ============================================================================

/**
 * Aggregate deployment readiness over every commander diagnostic. Read-only:
 * runs each diagnostic, flattens findings, and classifies a readiness level
 * (`NOT_READY` on any error finding, `READY_WITH_WARNINGS` on warnings only,
 * else `READY`).
 */
export async function deploymentReadiness(
  root: string,
  graph: ProjectGraph,
  config: CortexConfig,
): Promise<DeploymentReadiness> {
  assertRoot(root, 'deploymentReadiness');
  assertGraph(graph, 'deploymentReadiness');

  const diagnostics = await Promise.all([
    productionConfigCheck(root, graph),
    diagnoseDocker(root),
    secretsExposureCheck(root, graph),
    diagnoseK8s(root),
    ciHealth(root),
    diagnoseVercel(root, graph),
    diagnoseGithubActions(root),
  ]);

  const findings = diagnostics.flatMap((d) => d.findings);
  const errorCount = countBy(findings, 'error');
  const warningCount = countBy(findings, 'warning');
  const ok = errorCount === 0;
  const level: DeploymentReadinessLevel =
    errorCount > 0 ? 'NOT_READY' : warningCount > 0 ? 'READY_WITH_WARNINGS' : 'READY';

  const mode = isRecord(config) && typeof config.mode === 'string' ? config.mode : 'unknown';
  const summary = `Deployment readiness: ${level} (mode: ${mode}) — ${errorCount} blocking, ${warningCount} warning(s) across ${diagnostics.length} diagnostics.`;

  return { ok, level, diagnostics, findings, summary };
}
