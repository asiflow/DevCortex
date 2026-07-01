/**
 * review — the working half of the Senior Engineer Council (§7.14).
 *
 * Where {@link convene} decides *which* reviewer lenses fire for a task, `review`
 * actually runs them: each convened lens executes a set of CONCRETE, deterministic
 * checks over the project graph and the files on disk, and emits short,
 * evidence-backed {@link CouncilFinding}s. The council is deliberately quiet — a
 * lens only produces a finding when it observes a real issue, never a speculative
 * "consider…" note — so the output stays actionable rather than noisy.
 *
 * Everything here is tokenless and side-effect-free apart from reading source
 * files. File reads are fail-safe: an unreadable file is skipped (never aborts the
 * review), mirroring the graph scanner's degrade-don't-crash contract.
 *
 * The lenses and their checks:
 *   security      hardcoded secrets in risky files, `NEXT_PUBLIC_*` secrets,
 *                 server secrets leaked into client (`'use client'`) bundles
 *   devops        undocumented env vars, missing Dockerfile, missing CI
 *   qa            risky code files with no accompanying test
 *   architecture  oversized source files, lib/service → UI layering inversions
 *   frontend      unsafe `dangerouslySetInnerHTML` in components
 *   ui-ux         `<img>` without `alt` (accessibility)
 *   documentation missing repository README
 *   performance   large modules that bloat parse/bundle cost
 *   product       placeholder copy / dead links left in shipped UI
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CortexConfig,
  CouncilFinding,
  CouncilReport,
  FileKind,
  FileNode,
  ProjectGraph,
  ReviewerLens,
  RiskLevel,
} from '../domain/index';
import { DevCortexError, REVIEWER_LENSES } from '../domain/index';
import { isProtected } from '../policy/index';

import { canonicalizeLenses } from './convene';

// --- tuning constants -------------------------------------------------------

/** Source files longer than this many lines are flagged by the architect. */
const OVERSIZED_LINES = 400;
/** Modules larger than this many bytes are flagged for parse/bundle cost. */
const LARGE_MODULE_BYTES = 24_576; // 24 KiB
/** Cap secret findings per file so one bad fixture can't flood the report. */
const MAX_SECRETS_PER_FILE = 5;
/** Cap how many env-var / file names are enumerated inside a single finding. */
const MAX_NAMES_LISTED = 8;

/** Canonical rank of each lens, for stable finding ordering. */
const LENS_RANK: ReadonlyMap<ReviewerLens, number> = new Map(
  REVIEWER_LENSES.map((lens, index) => [lens, index]),
);
const LENS_SET: ReadonlySet<ReviewerLens> = new Set(REVIEWER_LENSES);

/** Severity ordering (critical first) for deterministic sorting. */
const SEVERITY_RANK: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** File kinds that carry testable behaviour — the qa lens only cares about these. */
const TESTABLE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'auth',
  'billing',
  'middleware',
  'api',
  'service',
  'lib',
  'component',
  'page',
  'route',
]);

/** UI-layer file kinds — the target of a layering-inversion check. */
const UI_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['page', 'route', 'component']);
/** Lower-layer file kinds that must not depend on the UI layer. */
const LOWER_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['lib', 'service']);
/** File kinds that ship to (or render in) the browser. */
const CLIENT_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['component', 'page', 'route']);

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;
const MARKUP_EXT_RE = /\.(md|mdx|markdown|html?|vue|svelte)$/i;

const ENV_EXAMPLE_BASENAMES: ReadonlySet<string> = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.defaults',
  '.env.local.example',
]);
const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

/**
 * Ordered, most-specific-first hardcoded-secret signatures. Order matters: the
 * scanner reports at most one finding per line and the first matching pattern
 * wins, so the concrete provider tokens sit ahead of the generic assignment rule.
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'PEM private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Stripe secret key', re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: 'OpenAI/Anthropic-style API key', re: /\b(?:sk|pk)-[A-Za-z0-9]{20,}\b/ },
  {
    label: 'hardcoded secret assignment',
    re: /(?:secret|password|passwd|api[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
];

/** Env-var names that look like server secrets (used by the client-leak check). */
const SECRET_ENV_RE = /(SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|APIKEY|API_KEY|_KEY|TOKEN)/;
/** Stronger secret markers for the `NEXT_PUBLIC_*` check (excludes publishable keys). */
const PUBLIC_SECRET_RE = /(SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|TOKEN)/;
const USE_CLIENT_RE = /(^|\n)\s*['"]use client['"]\s*;?/;
const IMG_TAG_RE = /<img\b[^>]*>/gi;
const HAS_ALT_RE = /\balt\s*=/i;
const DEAD_LINK_RE = /href\s*=\s*(['"])\s*#?\s*\1/i;
const PROCESS_ENV_RE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;

const PLACEHOLDER_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'lorem ipsum placeholder copy', re: /lorem ipsum/i },
  { label: '"coming soon" placeholder', re: /coming soon/i },
  { label: '"under construction" placeholder', re: /under construction/i },
];

// --- shared context ---------------------------------------------------------

interface ReviewContext {
  readonly root: string;
  readonly graph: ProjectGraph;
  readonly config: CortexConfig;
  /** repo-relative path -> file content, only for files that read successfully. */
  readonly contents: ReadonlyMap<string, string>;
  /** repo-relative path -> node, for O(1) import target lookups. */
  readonly nodesByPath: ReadonlyMap<string, FileNode>;
}

type LensCheck = (ctx: ReviewContext) => CouncilFinding[];

// --- public entrypoint ------------------------------------------------------

/**
 * Run the convened reviewer lenses over a project graph and its files.
 *
 * @param root   absolute repo root the graph was scanned from.
 * @param graph  the project graph (from `scanProject`/`loadGraph`).
 * @param config the workspace config (drives protected-path + gate-aware checks).
 * @param lenses the lenses to convene (typically the output of {@link convene});
 *   deduped and returned in canonical order on the report.
 * @throws DevCortexError('INTERNAL') when a lens is not a member of
 *   `REVIEWER_LENSES`, or the graph/config is structurally invalid.
 */
export async function review(
  root: string,
  graph: ProjectGraph,
  config: CortexConfig,
  lenses: ReviewerLens[],
): Promise<CouncilReport> {
  if (typeof root !== 'string' || root.length === 0) {
    throw new DevCortexError('INTERNAL', 'review: root must be a non-empty string.');
  }
  if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.files)) {
    throw new DevCortexError('INTERNAL', 'review: graph must be a ProjectGraph.');
  }
  if (config === null || typeof config !== 'object' || config.risk === undefined) {
    throw new DevCortexError('INTERNAL', 'review: config must be a CortexConfig.');
  }
  if (!Array.isArray(lenses)) {
    throw new DevCortexError('INTERNAL', 'review: lenses must be an array of ReviewerLens.');
  }
  for (const lens of lenses) {
    if (!LENS_SET.has(lens)) {
      throw new DevCortexError('INTERNAL', `review: unknown reviewer lens "${String(lens)}"`);
    }
  }

  const active = canonicalizeLenses(lenses);
  const absRoot = path.resolve(root);

  try {
    const contents = await loadContents(absRoot, graph, config, active);
    const nodesByPath = new Map(graph.files.map((node) => [node.path, node]));
    const ctx: ReviewContext = { root: absRoot, graph, config, contents, nodesByPath };

    const findings: CouncilFinding[] = [];
    for (const lens of active) {
      findings.push(...LENS_CHECKS[lens](ctx));
    }
    findings.sort(compareFindings);

    return {
      task: `project review (${graph.stack.framework}/${graph.stack.language})`,
      lenses: active,
      findings,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof DevCortexError) {
      throw err;
    }
    throw new DevCortexError('INTERNAL', `review failed at ${absRoot}`, { cause: err });
  }
}

// --- file loading -----------------------------------------------------------

/**
 * Read exactly the files the active lenses need, once, in parallel. Unreadable
 * files are silently skipped (fail-safe) so one permission error never fails the
 * whole review.
 */
async function loadContents(
  absRoot: string,
  graph: ProjectGraph,
  config: CortexConfig,
  active: readonly ReviewerLens[],
): Promise<Map<string, string>> {
  const needed = filesToRead(graph, config, active);
  const contents = new Map<string, string>();
  await Promise.all(
    [...needed].map(async (rel) => {
      try {
        contents.set(rel, await readFile(path.join(absRoot, rel), 'utf8'));
      } catch {
        // Unreadable file: skip it. The lens simply has nothing to say about it.
      }
    }),
  );
  return contents;
}

/** Union of the repo-relative files any active lens must read. */
function filesToRead(
  graph: ProjectGraph,
  config: CortexConfig,
  active: readonly ReviewerLens[],
): Set<string> {
  const lensSet = new Set(active);
  const needSource = lensSet.has('architect') || lensSet.has('performance');
  const needClient = lensSet.has('frontend') || lensSet.has('ui-ux') || lensSet.has('security');
  const needProduct = lensSet.has('product');
  const needSecrets = lensSet.has('security');

  const files = new Set<string>();
  for (const node of graph.files) {
    if (needSource && isSourceFile(node.path)) {
      files.add(node.path);
    }
    if (needProduct && isProductScannable(node.path)) {
      files.add(node.path);
    }
    if (needClient && CLIENT_KINDS.has(node.kind)) {
      files.add(node.path);
    }
    if (needSecrets && isRisky(node, config) && isSecretScannable(node.path)) {
      files.add(node.path);
    }
  }
  return files;
}

// --- security ---------------------------------------------------------------

function securityFindings(ctx: ReviewContext): CouncilFinding[] {
  const findings: CouncilFinding[] = [];

  // 1. Hardcoded secrets in risky files (never echo the secret itself).
  for (const node of ctx.graph.files) {
    if (!isRisky(node, ctx.config) || !isSecretScannable(node.path)) {
      continue;
    }
    const content = ctx.contents.get(node.path);
    if (content === undefined) {
      continue;
    }
    let hits = 0;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits < MAX_SECRETS_PER_FILE; i += 1) {
      const line = lines[i] ?? '';
      const label = firstSecretLabel(line);
      if (label === undefined) {
        continue;
      }
      hits += 1;
      findings.push(
        makeFinding(
          'security',
          'critical',
          'Hardcoded secret in source',
          `Possible ${label} committed at line ${i + 1}; move it to an environment variable / secret manager.`,
          node.path,
        ),
      );
    }
  }

  // 2. Secrets exposed through a NEXT_PUBLIC_* var (inlined into the client bundle).
  for (const env of ctx.graph.envVars) {
    if (env.name.startsWith('NEXT_PUBLIC_') && PUBLIC_SECRET_RE.test(env.name)) {
      findings.push(
        makeFinding(
          'security',
          'high',
          'Secret exposed via NEXT_PUBLIC_ env var',
          `${env.name} is inlined into the public client bundle; a real secret must use a non-public, server-only variable.`,
          firstOrUndefined(env.usedIn),
        ),
      );
    }
  }

  // 3. Server secrets read inside a 'use client' file (leaked into the browser).
  for (const node of ctx.graph.files) {
    if (!CLIENT_KINDS.has(node.kind)) {
      continue;
    }
    const content = ctx.contents.get(node.path);
    if (content === undefined || !USE_CLIENT_RE.test(content)) {
      continue;
    }
    const leaked = clientSecretRefs(content);
    if (leaked.length > 0) {
      findings.push(
        makeFinding(
          'security',
          'high',
          'Server secret read in a client component',
          `'use client' file reads server secret(s) via process.env: ${listNames(leaked)}; these are exposed in the browser bundle.`,
          node.path,
        ),
      );
    }
  }

  return findings;
}

// --- devops -----------------------------------------------------------------

function devopsFindings(ctx: ReviewContext): CouncilFinding[] {
  const findings: CouncilFinding[] = [];

  const undocumented = ctx.graph.envVars.filter((env) => !env.documented).map((env) => env.name);
  if (undocumented.length > 0) {
    findings.push(
      makeFinding(
        'devops',
        'medium',
        'Undocumented environment variables',
        `${undocumented.length} env var(s) are referenced in code but absent from any .env.example: ${listNames(undocumented)}.`,
      ),
    );
  }

  if (!hasDockerfile(ctx.graph)) {
    findings.push(
      makeFinding(
        'devops',
        'low',
        'No Dockerfile found',
        'No Dockerfile detected; reproducible container builds are recommended for deployable services.',
      ),
    );
  }

  if (!hasContinuousIntegration(ctx.graph)) {
    findings.push(
      makeFinding(
        'devops',
        'medium',
        'No CI configuration found',
        'No CI workflow detected (.github/workflows, .gitlab-ci.yml, etc.); gates should run automatically on every change.',
      ),
    );
  }

  return findings;
}

// --- qa ---------------------------------------------------------------------

function qaFindings(ctx: ReviewContext): CouncilFinding[] {
  const testNodes = ctx.graph.files.filter((node) => node.kind === 'test');
  const testedPaths = new Set<string>();
  const testedStems = new Set<string>();
  for (const test of testNodes) {
    for (const imported of test.imports) {
      testedPaths.add(imported);
    }
    testedStems.add(testStem(test.path));
  }

  // A missing test matters more when the test gate is actually enforced.
  const severity: RiskLevel = ctx.config.gates.test ? 'high' : 'medium';
  const findings: CouncilFinding[] = [];
  for (const node of ctx.graph.files) {
    if (node.kind === 'test' || !TESTABLE_KINDS.has(node.kind) || !isRisky(node, ctx.config)) {
      continue;
    }
    const coveredByImport =
      testedPaths.has(node.path) || node.importedBy.some((p) => isTestPath(p));
    const coveredByName = testedStems.has(baseStem(node.path));
    if (coveredByImport || coveredByName) {
      continue;
    }
    findings.push(
      makeFinding(
        'qa',
        severity,
        'Risky file has no test',
        `${node.path} touches a ${node.kind} surface but no test references it; add coverage before shipping.`,
        node.path,
      ),
    );
  }
  return findings;
}

// --- architecture -----------------------------------------------------------

function architectureFindings(ctx: ReviewContext): CouncilFinding[] {
  const findings: CouncilFinding[] = [];

  for (const node of ctx.graph.files) {
    if (!isSourceFile(node.path)) {
      continue;
    }
    const content = ctx.contents.get(node.path);
    if (content === undefined) {
      continue;
    }
    const lineCount = content.split(/\r?\n/).length;
    if (lineCount > OVERSIZED_LINES) {
      findings.push(
        makeFinding(
          'architect',
          'medium',
          'Oversized source file',
          `${node.path} is ${lineCount} lines (> ${OVERSIZED_LINES}); consider splitting it into cohesive units.`,
          node.path,
        ),
      );
    }
  }

  // Layering inversion: a lower-layer (lib/service) file importing the UI layer.
  for (const node of ctx.graph.files) {
    if (!LOWER_KINDS.has(node.kind)) {
      continue;
    }
    for (const imported of node.imports) {
      const target = ctx.nodesByPath.get(imported);
      if (target !== undefined && UI_KINDS.has(target.kind)) {
        findings.push(
          makeFinding(
            'architect',
            'medium',
            'Layering inversion',
            `${node.kind} file ${node.path} imports ${target.kind} ${target.path}; lower layers should not depend on the UI layer.`,
            node.path,
          ),
        );
      }
    }
  }

  return findings;
}

// --- frontend ---------------------------------------------------------------

function frontendFindings(ctx: ReviewContext): CouncilFinding[] {
  const findings: CouncilFinding[] = [];
  for (const node of ctx.graph.files) {
    if (!CLIENT_KINDS.has(node.kind)) {
      continue;
    }
    const content = ctx.contents.get(node.path);
    if (content !== undefined && content.includes('dangerouslySetInnerHTML')) {
      findings.push(
        makeFinding(
          'frontend',
          'medium',
          'Unsafe dangerouslySetInnerHTML',
          `${node.path} renders raw HTML via dangerouslySetInnerHTML; sanitize the input or render structured content to avoid XSS.`,
          node.path,
        ),
      );
    }
  }
  return findings;
}

// --- ui-ux ------------------------------------------------------------------

function uiUxFindings(ctx: ReviewContext): CouncilFinding[] {
  const findings: CouncilFinding[] = [];
  for (const node of ctx.graph.files) {
    if (!CLIENT_KINDS.has(node.kind)) {
      continue;
    }
    const content = ctx.contents.get(node.path);
    if (content === undefined) {
      continue;
    }
    const missing = countImgWithoutAlt(content);
    if (missing > 0) {
      findings.push(
        makeFinding(
          'ui-ux',
          'low',
          'Image without alt text',
          `${node.path} has ${missing} <img> tag(s) without an alt attribute; screen readers cannot describe them.`,
          node.path,
        ),
      );
    }
  }
  return findings;
}

// --- documentation ----------------------------------------------------------

function documentationFindings(ctx: ReviewContext): CouncilFinding[] {
  const hasReadme = ctx.graph.files.some((node) => isRootReadme(node.path));
  if (hasReadme) {
    return [];
  }
  return [
    makeFinding(
      'documentation',
      'low',
      'No repository README',
      'No README found at the repository root; add one describing setup, usage, and architecture.',
    ),
  ];
}

// --- performance ------------------------------------------------------------

function performanceFindings(ctx: ReviewContext): CouncilFinding[] {
  const findings: CouncilFinding[] = [];
  for (const node of ctx.graph.files) {
    if (!isSourceFile(node.path)) {
      continue;
    }
    const content = ctx.contents.get(node.path);
    if (content === undefined) {
      continue;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > LARGE_MODULE_BYTES) {
      findings.push(
        makeFinding(
          'performance',
          'low',
          'Large module',
          `${node.path} is ${Math.round(bytes / 1024)} KB (> ${Math.round(LARGE_MODULE_BYTES / 1024)} KB); large modules slow parsing and can bloat bundles.`,
          node.path,
        ),
      );
    }
  }
  return findings;
}

// --- product ----------------------------------------------------------------

function productFindings(ctx: ReviewContext): CouncilFinding[] {
  const findings: CouncilFinding[] = [];
  for (const node of ctx.graph.files) {
    if (!isProductScannable(node.path)) {
      continue;
    }
    const content = ctx.contents.get(node.path);
    if (content === undefined) {
      continue;
    }
    const reasons: string[] = [];
    for (const { label, re } of PLACEHOLDER_PATTERNS) {
      if (re.test(content)) {
        reasons.push(label);
      }
    }
    if (DEAD_LINK_RE.test(content)) {
      reasons.push('dead link (href="#" / empty href)');
    }
    if (reasons.length > 0) {
      findings.push(
        makeFinding(
          'product',
          'low',
          'Placeholder content shipped',
          `${node.path} still contains: ${reasons.join('; ')}. Replace before shipping to users.`,
          node.path,
        ),
      );
    }
  }
  return findings;
}

// --- lens dispatch ----------------------------------------------------------

const LENS_CHECKS: Record<ReviewerLens, LensCheck> = {
  architect: architectureFindings,
  security: securityFindings,
  frontend: frontendFindings,
  'ui-ux': uiUxFindings,
  qa: qaFindings,
  devops: devopsFindings,
  performance: performanceFindings,
  product: productFindings,
  documentation: documentationFindings,
};

// --- helpers ----------------------------------------------------------------

function makeFinding(
  lens: ReviewerLens,
  severity: RiskLevel,
  title: string,
  detail: string,
  file?: string,
): CouncilFinding {
  return file === undefined
    ? { lens, severity, title, detail }
    : { lens, severity, title, detail, file };
}

function compareFindings(a: CouncilFinding, b: CouncilFinding): number {
  const lensDelta = (LENS_RANK.get(a.lens) ?? REVIEWER_LENSES.length) -
    (LENS_RANK.get(b.lens) ?? REVIEWER_LENSES.length);
  if (lensDelta !== 0) {
    return lensDelta;
  }
  const sevDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sevDelta !== 0) {
    return sevDelta;
  }
  const fileDelta = compareStrings(a.file ?? '', b.file ?? '');
  if (fileDelta !== 0) {
    return fileDelta;
  }
  const titleDelta = compareStrings(a.title, b.title);
  return titleDelta !== 0 ? titleDelta : compareStrings(a.detail, b.detail);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRisky(node: FileNode, config: CortexConfig): boolean {
  return node.risky || isProtected(node.path, config);
}

function isSourceFile(rel: string): boolean {
  return SOURCE_EXT_RE.test(rel.toLowerCase());
}

function isProductScannable(rel: string): boolean {
  return isSourceFile(rel) || MARKUP_EXT_RE.test(rel);
}

function isSecretScannable(rel: string): boolean {
  const base = basenameOf(rel).toLowerCase();
  if (LOCKFILE_BASENAMES.has(base) || ENV_EXAMPLE_BASENAMES.has(base)) {
    return false;
  }
  if (base.endsWith('.map') || base.endsWith('.min.js')) {
    return false;
  }
  return true;
}

function firstSecretLabel(line: string): string | undefined {
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(line)) {
      return label;
    }
  }
  return undefined;
}

/** Non-public, secret-looking env vars read via `process.env` in a source string. */
function clientSecretRefs(content: string): string[] {
  const names = new Set<string>();
  PROCESS_ENV_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROCESS_ENV_RE.exec(content)) !== null) {
    const name = match[1] ?? match[2];
    if (name !== undefined && !name.startsWith('NEXT_PUBLIC_') && SECRET_ENV_RE.test(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function countImgWithoutAlt(content: string): number {
  let missing = 0;
  IMG_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMG_TAG_RE.exec(content)) !== null) {
    if (!HAS_ALT_RE.test(match[0])) {
      missing += 1;
    }
  }
  return missing;
}

function hasDockerfile(graph: ProjectGraph): boolean {
  return graph.files.some((node) => {
    const base = basenameOf(node.path).toLowerCase();
    return base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile');
  });
}

function hasContinuousIntegration(graph: ProjectGraph): boolean {
  return graph.files.some((node) => {
    const posix = node.path.replace(/\\/g, '/');
    const base = basenameOf(posix).toLowerCase();
    return (
      posix.startsWith('.github/workflows/') ||
      posix.includes('/.github/workflows/') ||
      base === '.gitlab-ci.yml' ||
      base === 'azure-pipelines.yml' ||
      base === 'jenkinsfile' ||
      posix.includes('.circleci/config.') ||
      posix.includes('.buildkite/')
    );
  });
}

function isRootReadme(rel: string): boolean {
  if (rel.includes('/')) {
    return false;
  }
  return /^readme(\.(md|mdx|markdown|txt|rst))?$/i.test(rel);
}

function isTestPath(rel: string): boolean {
  const base = basenameOf(rel).toLowerCase();
  if (/\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(base)) {
    return true;
  }
  return rel
    .toLowerCase()
    .split('/')
    .slice(0, -1)
    .some((seg) => seg === '__tests__' || seg === '__test__' || seg === 'test' || seg === 'tests' || seg === 'e2e');
}

/** The stem a test file "covers": `foo.test.ts` -> `foo`, `foo.tsx` -> `foo`. */
function testStem(rel: string): string {
  const base = basenameOf(rel);
  return base.replace(/\.(test|spec|e2e)\.[cm]?[jt]sx?$/i, '').replace(/\.[cm]?[jt]sx?$/i, '');
}

/** The stem of a source file: `billing.ts` -> `billing`. */
function baseStem(rel: string): string {
  return basenameOf(rel).replace(/\.[cm]?[jt]sx?$/i, '');
}

function basenameOf(rel: string): string {
  const normalized = rel.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES_LISTED).join(', ');
  return names.length > MAX_NAMES_LISTED ? `${shown}, +${names.length - MAX_NAMES_LISTED} more` : shown;
}

function firstOrUndefined(values: readonly string[]): string | undefined {
  return values.length > 0 ? values[0] : undefined;
}
