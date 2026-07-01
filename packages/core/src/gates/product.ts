/**
 * Product gate (§7.21) — deep, TOKENLESS, DETERMINISTIC product-readiness
 * heuristics over the `ProjectGraph`, real file reads, and the `FeatureLedger`
 * (no LLM). Every check is a real detector that reads page/component source
 * (`.tsx` / `.jsx`) and flags a concrete class of "looks-done-but-isn't"
 * product defect. A finding is a `CheckResult` (never an exception), so the gate
 * NEVER throws on a detected issue. It throws `GateError` only on invalid input
 * or an internal failure.
 *
 * File reads are fail-safe: an unreadable file is skipped (never aborts the
 * gate), mirroring the security/UI gates' degrade-don't-crash contract. The JSX
 * scanner is brace- and quote-aware so a `>` inside a `{ () => expr }` handler
 * never prematurely closes a tag.
 *
 * The heuristic checks:
 *   placeholder-pages    (required) page files that render nothing, or only a
 *                                   TODO / "Coming soon" / "Lorem ipsum" stub
 *   fake-buttons         (required) <button> with no onClick, no type=submit,
 *                                   and not inside a <form> — a dead control
 *   dead-links           (required) <a href> pointing at "#", "", or javascript:
 *   missing-states       (required) a client data page that handles neither a
 *                                   loading nor an error state (light check)
 *   acceptance-criteria  (required) FeatureLedger records that claim to be built
 *                                   (shipped/building) but have unmet acceptance
 *                                   criteria or no backing evidence; degrades to
 *                                   a soft advisory if the ledger cannot be read
 *
 * Public API:
 *   runProductGate(root, graph, config): Promise<{ result: GateResult; evidence: EvidenceItem[] }>
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
  FeatureRecord,
  FileNode,
  GateFamily,
  GateResult,
  ProjectGraph,
} from '../domain/index';
import { FeatureLedger } from '../ledgers';

// --- constants --------------------------------------------------------------

const GATE_NAME = 'product' satisfies GateFamily;

/** Cap findings enumerated inside a single check's detail, so one bad file can't flood it. */
const MAX_FINDINGS_LISTED = 8;

/** Page/component source files that carry JSX. */
const UI_FILE_RE = /\.[jt]sx$/;

/** Rendered placeholder copy that essentially only appears in an unfinished page. */
const STRONG_PLACEHOLDER_RE =
  /coming soon|lorem ipsum|under construction|placeholder page|content goes here|page not implemented|not implemented yet/i;
/** A TODO / FIXME / WIP / TBD stub rendered as visible page text (not a comment). */
const TODO_TEXT_RE = /(?:^|\W)(?:todo|fixme|wip|tbd)\b/i;

/** A button becomes "real" through any of these affordances. */
const ONCLICK_RE = /\bon[A-Z][A-Za-z]*\s*=/; // any onClick/onKeyDown/onPointerUp/… handler
const TYPE_SUBMIT_RE = /\btype\s*=\s*['"]?(?:submit|reset)\b/i;
const FORM_ACTION_RE = /\bform[Aa]ction\b/;
const DISABLED_RE = /(?:^|\s)disabled(?:\s|=|\/|$)/;

/** Literal href attribute (string value only; a `{…}` expression is dynamic and skipped). */
const HREF_LITERAL_RE = /\bhref\s*=\s*(['"])([^'"]*)\1/;

/** Client-side data hooks / raw fetch — a page using one renders while data loads. */
const CLIENT_DATA_HOOK_RE = /\b(?:useQuery|useSuspenseQuery|useInfiniteQuery|useSWR|useMutation)\b/;
const USE_CLIENT_RE = /(^|\n)\s*['"]use client['"]\s*;?/;
const RAW_FETCH_RE = /\bfetch\s*\(|\baxios\b/;
const LOADING_RE =
  /\bisLoading\b|\bisFetching\b|\bisPending\b|\bisValidating\b|\bloading\b|\bpending\b|<Skeleton|<Spinner|<Loader|aria-busy/i;
const ERROR_RE =
  /\bisError\b|\.error\b|\berror\b|\bcatch\s*\(|\btry\s*\{|\bonError\b|role\s*=\s*['"]alert['"]|<ErrorBoundary|<Error\b/i;

/** Feature statuses that claim the feature actually exists, so it must be backed by evidence. */
const CLAIMED_STATUSES: ReadonlySet<FeatureRecord['status']> = new Set<FeatureRecord['status']>([
  'shipped',
  'building',
]);

// --- internal shapes --------------------------------------------------------

interface ProductFinding {
  /** the offending location — a repo-relative file path, or a feature label */
  where: string;
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
  /** raw tag name as written (e.g. `div`, `button`, `MyComponent`) */
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
    throw new GateError('Product gate requires a non-empty repository root path.');
  }
  if (!isRecord(graph) || !Array.isArray(graph.files)) {
    throw new GateError('Product gate requires a valid ProjectGraph (with a files array).');
  }
  if (!isRecord(config)) {
    throw new GateError('Product gate requires a valid CortexConfig.');
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

function renderFinding(finding: ProductFinding): string {
  const where = finding.line !== undefined ? `${finding.where}:${finding.line}` : finding.where;
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
  findings: ProductFinding[],
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
async function readUiSources(absRoot: string, graph: ProjectGraph): Promise<Map<string, string>> {
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

/**
 * The visible, rendered text of a file: the text nodes that sit directly after
 * each element's opening tag, with `{…}` expressions removed. Deriving text from
 * real tag boundaries (rather than a raw `>…<` scan) keeps arrow-function `=>`
 * bodies and other code out of the "rendered text", so a `// TODO` comment is
 * never mistaken for a rendered TODO stub.
 */
function renderedText(content: string, tags: OpenTag[]): string {
  const parts: string[] = [];
  for (const tag of tags) {
    if (tag.selfClosing) continue;
    const next = content.indexOf('<', tag.bodyStart);
    const segment = next === -1 ? content.slice(tag.bodyStart) : content.slice(tag.bodyStart, next);
    const text = stripBraceExpressions(segment).replace(/\s+/g, ' ').trim();
    if (text.length > 0) parts.push(text);
  }
  return parts.join(' ');
}

/** Index ranges [openStart, closeEnd) of every `<form>…</form>` block. */
function formRanges(content: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const open = /<form\b/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(content)) !== null) {
    const closeIdx = content.indexOf('</form>', open.lastIndex);
    const end = closeIdx === -1 ? content.length : closeIdx + '</form>'.length;
    ranges.push([match.index, end] as const);
    open.lastIndex = end;
  }
  return ranges;
}

function isInsideForm(index: number, ranges: Array<readonly [number, number]>): boolean {
  return ranges.some(([open, close]) => index > open && index < close);
}

// --- detectors --------------------------------------------------------------

/** Page files that render nothing or only a placeholder/TODO stub. */
function detectPlaceholderPages(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): ProductFinding[] {
  const findings: ProductFinding[] = [];
  for (const node of graph.files) {
    if (node.kind !== 'page') continue;
    const content = contents.get(node.path);
    if (content === undefined) continue;

    const tags = scanOpeningTags(content);
    const text = renderedText(content, tags);

    let reason: string | undefined;
    if (tags.length === 0) {
      reason = 'renders no elements (returns null / an empty fragment)';
    } else if (STRONG_PLACEHOLDER_RE.test(text)) {
      reason = 'renders placeholder copy (e.g. "Coming soon" / "Lorem ipsum")';
    } else if (TODO_TEXT_RE.test(text)) {
      reason = 'renders a TODO/FIXME/WIP stub instead of real content';
    }

    if (reason !== undefined) {
      findings.push({ where: node.path, detail: `placeholder page — ${reason}` });
    }
  }
  return findings;
}

/** `<button>` elements with no click/submit affordance and no enclosing `<form>`. */
function detectFakeButtons(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): ProductFinding[] {
  const findings: ProductFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    const forms = formRanges(content);
    for (const el of scanOpeningTags(content)) {
      if (el.tag.toLowerCase() !== 'button') continue;
      // A button is "real" via an on* handler, a submit/reset type, a formAction
      // server action, an enclosing <form>, or an intentional `disabled` state.
      if (ONCLICK_RE.test(el.attrs)) continue;
      if (TYPE_SUBMIT_RE.test(el.attrs)) continue;
      if (FORM_ACTION_RE.test(el.attrs)) continue;
      if (DISABLED_RE.test(el.attrs)) continue;
      if (isInsideForm(el.index, forms)) continue;

      findings.push({
        where: node.path,
        line: lineOf(content, el.index),
        detail:
          '<button> has no onClick handler, no type="submit", and is not inside a <form>; it does nothing when clicked',
      });
    }
  }
  return findings;
}

/** `<a href>` links pointing at "#", "", or a `javascript:` URL. */
function detectDeadLinks(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): ProductFinding[] {
  const findings: ProductFinding[] = [];
  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    for (const el of scanOpeningTags(content)) {
      if (el.tag.toLowerCase() !== 'a') continue;
      const hrefMatch = HREF_LITERAL_RE.exec(el.attrs);
      const href = hrefMatch?.[2];
      if (href === undefined) continue; // no literal href (missing or `{…}` dynamic): not judged here
      const value = href.trim();
      if (value === '' || value === '#' || /^javascript:/i.test(value)) {
        const shown = value === '' ? '""' : value;
        findings.push({
          where: node.path,
          line: lineOf(content, el.index),
          detail: `<a> has a dead href (${shown}); point it at a real route or use a <button> for actions`,
        });
      }
    }
  }
  return findings;
}

/**
 * Light check: a client-side data page that handles neither a loading nor an
 * error state. Deliberately lighter than the UI gate's data-states check (which
 * requires all three of loading/empty/error) — the product gate only flags a
 * data page that shows the user nothing at all while data loads or fails.
 */
function detectMissingStates(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): ProductFinding[] {
  const findings: ProductFinding[] = [];
  for (const node of graph.files) {
    if (node.kind !== 'page') continue;
    const content = contents.get(node.path);
    if (content === undefined) continue;

    const usesClientHook = CLIENT_DATA_HOOK_RE.test(content);
    const fetchesInClient = USE_CLIENT_RE.test(content) && RAW_FETCH_RE.test(content);
    if (!usesClientHook && !fetchesInClient) continue;

    if (!LOADING_RE.test(content) && !ERROR_RE.test(content)) {
      findings.push({
        where: node.path,
        detail:
          'data page fetches on the client but renders neither a loading nor an error state; the user sees a blank screen while it loads or fails',
      });
    }
  }
  return findings;
}

// --- acceptance criteria (FeatureLedger) ------------------------------------

/** Findings for features that claim to exist but are not backed by met criteria + evidence. */
function featureFindings(features: readonly FeatureRecord[]): ProductFinding[] {
  const findings: ProductFinding[] = [];
  for (const feature of features) {
    if (!isRecord(feature) || !CLAIMED_STATUSES.has(feature.status)) continue;

    const evidence = Array.isArray(feature.evidence) ? feature.evidence : [];
    const criteria = Array.isArray(feature.acceptanceCriteria) ? feature.acceptanceCriteria : [];

    const reasons: string[] = [];
    if (evidence.length === 0) {
      reasons.push('no backing evidence');
    } else {
      const verified = evidence.filter((ref) => isRecord(ref) && ref.status === 'verified').length;
      const refuted = evidence.filter((ref) => isRecord(ref) && ref.status === 'refuted').length;
      if (refuted > 0) reasons.push(`${refuted} refuted evidence item(s)`);
      if (criteria.length > 0 && verified === 0) {
        reasons.push(`${criteria.length} acceptance criteria with no verified evidence`);
      }
    }

    if (reasons.length > 0) {
      findings.push({
        where: `feature "${feature.feature}"`,
        detail: `${feature.status} feature — ${reasons.join('; ')}`,
      });
    }
  }
  return findings;
}

/**
 * Build the acceptance-criteria check from the FeatureLedger. When the ledger
 * reads cleanly this is a required/blocking check; if the ledger cannot be read
 * (corruption, permissions) it degrades to a soft, non-blocking advisory rather
 * than crashing the whole gate — mirroring the security gate's advisory audit.
 */
async function buildAcceptanceCriteriaCheck(root: string): Promise<RichCheck> {
  const name = 'acceptance-criteria';
  try {
    const features = await new FeatureLedger(root).all();
    return buildCategory(name, 'unmet acceptance criteria', featureFindings(features), true);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const detail = `Feature ledger could not be read (${reason}); acceptance-criteria check skipped (advisory).`;
    const evidence = makeEvidence({
      claim: 'Feature acceptance criteria',
      status: 'unverified',
      kind: 'file',
      detail,
    });
    return { required: false, evidence, check: { name, passed: true, detail, evidenceId: evidence.id } };
  }
}

// --- public entrypoint ------------------------------------------------------

/**
 * Run the deep product gate against `root`. Returns the `GateResult` (whose
 * `passed` reflects only the required heuristic checks) plus every collected
 * `EvidenceItem`. Findings are `CheckResult`s, never exceptions; `GateError` is
 * thrown only on invalid input or an internal failure.
 *
 * @param root   absolute repo root the graph was scanned from.
 * @param graph  the project graph (from `scanProject`/`loadGraph`).
 * @param config the workspace config.
 */
export async function runProductGate(
  root: string,
  graph: ProjectGraph,
  config: CortexConfig,
): Promise<{ result: GateResult; evidence: EvidenceItem[] }> {
  assertGateInputs(root, graph, config);
  const absRoot = path.resolve(root);

  try {
    const contents = await readUiSources(absRoot, graph);

    const rich: RichCheck[] = [
      buildCategory('placeholder-pages', 'placeholder page', detectPlaceholderPages(graph, contents), true),
      buildCategory('fake-buttons', 'non-functional button', detectFakeButtons(graph, contents), true),
      buildCategory('dead-links', 'dead link', detectDeadLinks(graph, contents), true),
      buildCategory('missing-states', 'data page with no loading/error state', detectMissingStates(graph, contents), true),
      await buildAcceptanceCriteriaCheck(absRoot),
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
    throw new GateError(`Product gate failed at ${absRoot}`, { cause: err });
  }
}
