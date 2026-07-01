/**
 * UI gate (§7.13) — deep, TOKENLESS, DETERMINISTIC UI-quality heuristics over the
 * `ProjectGraph` and real file reads (no LLM). Every check is a real detector that
 * reads page/component source (`.tsx` / `.jsx`) plus the Tailwind classes inlined
 * in it, and flags a concrete class of UI defect. A finding is a `CheckResult`
 * (never an exception), so the gate NEVER throws on a detected issue. It throws
 * `GateError` only on invalid input or an internal failure.
 *
 * File reads are fail-safe: an unreadable file is skipped (never aborts the gate),
 * mirroring the security gate's degrade-don't-crash contract.
 *
 * The heuristic checks:
 *   responsive     (required)  layout files with no breakpoint/media query;
 *                              fixed-px container widths that don't adapt
 *   data-states    (required)  data-fetching components that don't handle all
 *                              three of loading / empty / error
 *   accessibility  (required)  <img> without alt; button/anchor with no accessible
 *                              text or aria-label; input without an associated
 *                              label; clickable <div>/<span> without a role
 *   keyboard-nav   (required)  onClick on a non-interactive element with no
 *                              keyboard handler (onKeyDown/onKeyUp/onKeyPress)
 *   dark-mode      (soft)      colour-setting files with no `dark:` variant, when
 *                              the project otherwise supports dark mode
 *
 * Public API:
 *   runUiGate(root, graph, config): Promise<{ result: GateResult; evidence: EvidenceItem[] }>
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { GateError } from '../domain/index';
import type {
  CheckResult,
  CortexConfig,
  EvidenceItem,
  EvidenceKind,
  EvidenceStatus,
  FileNode,
  GateFamily,
  GateResult,
  ProjectGraph,
} from '../domain/index';

// --- constants --------------------------------------------------------------

const GATE_NAME = 'ui' satisfies GateFamily;

/** Cap findings enumerated inside a single check's detail, so one bad file can't flood it. */
const MAX_FINDINGS_LISTED = 8;

/** A fixed pixel width at or above this is treated as a non-responsive container width. */
const FIXED_WIDTH_MIN_PX = 200;

/** Page/component source files that carry JSX + Tailwind classes. */
const UI_FILE_RE = /\.[jt]sx$/;

/** Tailwind responsive breakpoint prefix (e.g. `md:flex`, `lg:w-1/2`, `2xl:[…]`). */
const RESPONSIVE_TAILWIND_RE = /(?:^|[\s"'`{])(?:sm|md|lg|xl|2xl):[\w[-]/;
/** CSS media queries / JS responsive affordances. */
const RESPONSIVE_MEDIA_RE = /@media\b|useMediaQuery|matchMedia|<picture[\s>]|srcSet|\bsizes=/;

/** Layout containers that ought to adapt across viewports. */
const LAYOUT_CLASS_RE =
  /\bflex\b|\bgrid\b|\bcontainer\b|\bmax-w-|\bmin-h-screen\b|\bw-screen\b|\bw-full\b|\bcolumns-/;

/** Tailwind arbitrary width `w-[640px]`. */
const TW_FIXED_W_RE = /\bw-\[(\d+)px\]/g;
/** Quoted / CSS pixel width `width: 640px`, `maxWidth: "300px"`. */
const CSS_PX_W_RE = /\b(?:width|min-width|max-width|minWidth|maxWidth)\s*:\s*['"]?(\d+)px/gi;
/** Bare React style-object width `width: 640` (React interprets a number as px). */
const JS_NUM_W_RE = /\b(?:width|minWidth|maxWidth)\s*:\s*(\d+)\s*(?:[,}]|$)/g;

/** Client-side data hooks — a component using one renders while data loads. */
const CLIENT_DATA_HOOK_RE = /\b(?:useQuery|useSuspenseQuery|useInfiniteQuery|useSWR|useMutation)\b/;
const USE_CLIENT_RE = /(^|\n)\s*['"]use client['"]\s*;?/;
const RAW_FETCH_RE = /\bfetch\s*\(|\baxios\b/;

const LOADING_RE =
  /\bisLoading\b|\bisFetching\b|\bisPending\b|\bisValidating\b|\bloading\b|\bpending\b|<Skeleton|<Spinner|<Loader|aria-busy/i;
const ERROR_RE =
  /\bisError\b|\.error\b|\berror\b|\bcatch\s*\(|\btry\s*\{|\bonError\b|role\s*=\s*['"]alert['"]|<ErrorBoundary|<Error\b/i;
const EMPTY_RE =
  /\.length\s*===\s*0|\.length\s*<\s*1|\.length\s*\?|!\s*data\b|!\s*items\b|\bdata\s*\?\.\s*length|\bisEmpty\b|<EmptyState|\bempty\b|no\s+(?:results|items|data|records)|nothing\s+found/i;

/** Colour-setting Tailwind utilities (bg/text/border of a named palette colour). */
const COLOR_CLASS_RE =
  /\b(?:bg|text|border)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/;
const DARK_VARIANT_RE = /\bdark:/;

/** Non-interactive tags that must not be the sole click target without a11y affordances. */
const NON_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'div',
  'span',
  'li',
  'p',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
  'main',
  'ul',
  'ol',
  'td',
  'tr',
]);

const ARIA_LABEL_RE = /\b(?:aria-label|aria-labelledby|title)\b/;
const ONCLICK_RE = /\bonClick\b/;
const KEY_HANDLER_RE = /\bon(?:KeyDown|KeyUp|KeyPress)\b/;
const ROLE_RE = /\brole\s*=/;

// --- internal shapes --------------------------------------------------------

interface UiFinding {
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
}

interface OpenTag {
  /** lowercase-insensitive raw tag name (e.g. `div`, `img`, `MyComponent`) */
  tag: string;
  /** the raw attribute text between the tag name and the closing `>` */
  attrs: string;
  /** index of the opening `<` */
  index: number;
  /** index just past the closing `>` (start of the element body) */
  bodyStart: number;
  selfClosing: boolean;
}

// --- guards -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertGateInputs(root: string, graph: ProjectGraph, config: CortexConfig): void {
  if (typeof root !== 'string' || root.length === 0) {
    throw new GateError('UI gate requires a non-empty repository root path.');
  }
  if (!isRecord(graph) || !Array.isArray(graph.files)) {
    throw new GateError('UI gate requires a valid ProjectGraph (with a files array).');
  }
  if (!isRecord(config)) {
    throw new GateError('UI gate requires a valid CortexConfig.');
  }
}

// --- evidence + check construction ------------------------------------------

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

function renderFinding(finding: UiFinding): string {
  const where = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
  return `${where} — ${finding.detail}`;
}

/**
 * Fold a detector's findings into a single check + backing evidence. A clean
 * detector (zero findings) produces a passing, `verified` check; any finding
 * produces a failing, `refuted` check whose detail enumerates the offending
 * files/lines (capped).
 */
function buildCategory(
  name: string,
  subject: string,
  findings: UiFinding[],
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
    kind: 'file',
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

function isUiFile(rel: string): boolean {
  const base = basenameOf(rel).toLowerCase();
  if (base.endsWith('.test.tsx') || base.endsWith('.test.jsx')) return false;
  if (base.endsWith('.stories.tsx') || base.endsWith('.stories.jsx')) return false;
  return UI_FILE_RE.test(base);
}

/**
 * Read every UI source file in the graph once, in parallel. Unreadable files are
 * silently skipped (fail-safe) so one permission error never fails the gate.
 */
async function readUiSources(
  absRoot: string,
  graph: ProjectGraph,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const targets = graph.files.filter(
    (node): node is FileNode =>
      isRecord(node) && typeof node.path === 'string' && isUiFile(node.path),
  );
  await Promise.all(
    targets.map(async (node) => {
      try {
        contents.set(node.path, await readFile(path.join(absRoot, node.path), 'utf8'));
      } catch {
        // Unreadable file: skip it. This gate simply has nothing to say about it.
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

/**
 * Extract JSX opening tags with their raw attributes. The scanner is brace- and
 * quote-aware: a `>` inside a `{ () => expr }` handler, a `"a > b"` string, or a
 * `` `${…}` `` template does not prematurely close the tag — a naive
 * `<tag[^>]*>` regex would mis-parse every arrow function. Closing tags,
 * fragments (`<>`), and comments (`<!--`) are ignored.
 */
function scanOpeningTags(content: string): OpenTag[] {
  const tags: OpenTag[] = [];
  const start = /<([A-Za-z][\w.-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(content)) !== null) {
    const tag = match[1];
    if (tag === undefined) continue;

    let i = start.lastIndex;
    let depth = 0;
    let quote = '';
    let close = -1;
    while (i < content.length) {
      const ch = content[i];
      if (ch === undefined) break;
      if (quote !== '') {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        if (depth > 0) depth -= 1;
      } else if (ch === '>' && depth === 0) {
        close = i;
        break;
      }
      i += 1;
    }
    if (close === -1) break; // unterminated tag: nothing more to scan reliably

    const attrs = content.slice(start.lastIndex, close);
    tags.push({
      tag,
      attrs,
      index: match.index,
      bodyStart: close + 1,
      selfClosing: attrs.trimEnd().endsWith('/'),
    });
    start.lastIndex = close + 1;
  }
  return tags;
}

/** Remove all `{ … }` expressions (brace-aware) from a fragment of JSX body. */
function stripBraceExpressions(body: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      if (depth > 0) depth -= 1;
    } else if (depth === 0 && ch !== undefined) {
      out += ch;
    }
  }
  return out;
}

/** The visible text of an element body once child tags and `{…}` are removed. */
function visibleText(body: string): string {
  return stripBraceExpressions(body).replace(/<[^>]*>/g, '').replace(/\s+/g, '');
}

// --- detectors --------------------------------------------------------------

/** Layout files with no responsive handling + fixed-px container widths. */
function detectResponsive(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): UiFinding[] {
  const findings: UiFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    const isLayout = node.kind === 'page' || node.kind === 'route' || LAYOUT_CLASS_RE.test(content);
    const isResponsive = RESPONSIVE_TAILWIND_RE.test(content) || RESPONSIVE_MEDIA_RE.test(content);
    if (isLayout && !isResponsive) {
      findings.push({
        file: node.path,
        detail:
          'layout uses no responsive breakpoints (sm:/md:/lg:) or media query; it will not adapt to small viewports',
      });
    }

    for (const re of [TW_FIXED_W_RE, CSS_PX_W_RE, JS_NUM_W_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let hit = false;
      while (!hit && (m = re.exec(content)) !== null) {
        const raw = m[1];
        if (raw === undefined) continue;
        const px = Number.parseInt(raw, 10);
        if (Number.isFinite(px) && px >= FIXED_WIDTH_MIN_PX) {
          findings.push({
            file: node.path,
            line: lineOf(content, m.index),
            detail: `fixed ${px}px width does not adapt across viewports; use a fluid or max-width unit`,
          });
          hit = true; // one fixed-width finding per file per pattern is enough
        }
      }
    }
  }
  return findings;
}

/** Data-fetching components that don't render all three of loading / empty / error. */
function detectDataStates(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): UiFinding[] {
  const findings: UiFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    const usesClientHook = CLIENT_DATA_HOOK_RE.test(content);
    const fetchesInClient = USE_CLIENT_RE.test(content) && RAW_FETCH_RE.test(content);
    if (!usesClientHook && !fetchesInClient) continue;

    const missing: string[] = [];
    if (!LOADING_RE.test(content)) missing.push('loading');
    if (!EMPTY_RE.test(content)) missing.push('empty');
    if (!ERROR_RE.test(content)) missing.push('error');
    if (missing.length === 0) continue;

    findings.push({
      file: node.path,
      detail: `data-fetching component does not handle ${missing.join(' / ')} state(s)`,
    });
  }
  return findings;
}

/** Accessibility defects: missing alt, unlabeled controls, clickable non-interactive without role. */
function detectAccessibility(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): UiFinding[] {
  const findings: UiFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    for (const el of scanOpeningTags(content)) {
      const line = lineOf(content, el.index);
      const lower = el.tag.toLowerCase();

      // <img> without alt (alt="" is allowed — decorative).
      if (lower === 'img' && !/\balt\s*=/.test(el.attrs)) {
        findings.push({
          file: node.path,
          line,
          detail: '<img> has no alt attribute; add alt text (or alt="" if decorative)',
        });
        continue;
      }

      // <input>/<select>/<textarea> without an associated label.
      if (
        (lower === 'input' || lower === 'select' || lower === 'textarea') &&
        !inputHasLabel(el.attrs, content)
      ) {
        findings.push({
          file: node.path,
          line,
          detail: `<${lower}> has no associated label (aria-label, aria-labelledby, or a matching htmlFor)`,
        });
        continue;
      }

      // <button>/<a> with neither accessible text nor an aria-label.
      if ((lower === 'button' || lower === 'a') && !el.selfClosing) {
        if (ARIA_LABEL_RE.test(el.attrs)) continue;
        const bodyEnd = content.indexOf(`</${el.tag}>`, el.bodyStart);
        const body = bodyEnd === -1 ? content.slice(el.bodyStart) : content.slice(el.bodyStart, bodyEnd);
        // A `{…}` body may render text at runtime — stay conservative and only
        // flag an element that is provably text-free (e.g. an icon-only button).
        if (!body.includes('{') && visibleText(body).length === 0) {
          findings.push({
            file: node.path,
            line,
            detail: `<${lower}> has no accessible text or aria-label (icon-only control?)`,
          });
        }
        continue;
      }

      // Clickable non-interactive element without a semantic role.
      if (NON_INTERACTIVE_TAGS.has(lower) && ONCLICK_RE.test(el.attrs) && !ROLE_RE.test(el.attrs)) {
        findings.push({
          file: node.path,
          line,
          detail: `clickable <${lower}> has no role; use a <button> or add role + tabIndex`,
        });
      }
    }
  }
  return findings;
}

function inputHasLabel(attrs: string, content: string): boolean {
  if (/\b(?:aria-label|aria-labelledby)\b/.test(attrs)) return true;
  const typeMatch = /\btype\s*=\s*['"]([a-z]+)['"]/i.exec(attrs);
  const type = typeMatch?.[1]?.toLowerCase();
  if (type !== undefined && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) {
    return true;
  }
  const idMatch = /\bid\s*=\s*['"]([^'"]+)['"]/.exec(attrs);
  const id = idMatch?.[1];
  if (id !== undefined) {
    if (content.includes(`htmlFor="${id}"`) || content.includes(`htmlFor='${id}'`)) return true;
    if (content.includes(`for="${id}"`) || content.includes(`for='${id}'`)) return true;
  }
  return false;
}

/** onClick on a non-interactive element with no keyboard handler. */
function detectKeyboardNav(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): UiFinding[] {
  const findings: UiFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    for (const el of scanOpeningTags(content)) {
      const lower = el.tag.toLowerCase();
      if (!NON_INTERACTIVE_TAGS.has(lower)) continue;
      if (!ONCLICK_RE.test(el.attrs) || KEY_HANDLER_RE.test(el.attrs)) continue;
      findings.push({
        file: node.path,
        line: lineOf(content, el.index),
        detail: `clickable <${lower}> has an onClick but no keyboard handler (onKeyDown); it is unreachable by keyboard`,
      });
    }
  }
  return findings;
}

/**
 * Dark-mode inconsistency: files that set palette colours but ship no `dark:`
 * variant, reported only when the project otherwise supports dark mode (so a
 * project that simply never adopted dark mode is not spuriously flagged).
 */
function detectDarkMode(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): UiFinding[] {
  const projectUsesDarkMode = [...contents.values()].some((c) => DARK_VARIANT_RE.test(c));
  if (!projectUsesDarkMode) return [];

  const findings: UiFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;
    if (!COLOR_CLASS_RE.test(content) || DARK_VARIANT_RE.test(content)) continue;
    findings.push({
      file: node.path,
      detail:
        'sets palette colours (bg-/text-) but has no dark: variant; inconsistent with the project’s dark mode',
    });
  }
  return findings;
}

// --- public entrypoint ------------------------------------------------------

/**
 * Run the deep UI gate against `root`. Returns the `GateResult` (whose `passed`
 * reflects only the required heuristic checks) plus every collected
 * `EvidenceItem`. Findings are `CheckResult`s, never exceptions; `GateError` is
 * thrown only on invalid input or an internal failure.
 *
 * @param root   absolute repo root the graph was scanned from.
 * @param graph  the project graph (from `scanProject`/`loadGraph`).
 * @param config the workspace config.
 */
export async function runUiGate(
  root: string,
  graph: ProjectGraph,
  config: CortexConfig,
): Promise<{ result: GateResult; evidence: EvidenceItem[] }> {
  assertGateInputs(root, graph, config);
  const absRoot = path.resolve(root);

  try {
    const contents = await readUiSources(absRoot, graph);

    const rich: RichCheck[] = [
      buildCategory('responsive', 'non-responsive layout', detectResponsive(graph, contents), true),
      buildCategory('data-states', 'unhandled data state', detectDataStates(graph, contents), true),
      buildCategory('accessibility', 'accessibility', detectAccessibility(graph, contents), true),
      buildCategory('keyboard-nav', 'keyboard-inaccessible control', detectKeyboardNav(graph, contents), true),
      buildCategory('dark-mode', 'dark-mode inconsistency', detectDarkMode(graph, contents), false),
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
    throw new GateError(`UI gate failed at ${absRoot}`, { cause: err });
  }
}
