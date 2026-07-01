/**
 * Premium-UI gate (§7.13) — the highest-bar visual gate, layered above the
 * required `ui` gate. Where `runUiGate` returns pass/fail `CheckResult`s, this
 * gate derives a COMPUTED, non-persisted `UiQualityScore` (0-100 per dimension +
 * a weighted `overall` + ordered `topFixes`), exactly like the `CouncilReport` /
 * `BlastRadius` computed artifacts. Every score is a DETERMINISTIC, TOKENLESS
 * heuristic over the `ProjectGraph` and real file reads (no LLM).
 *
 * The five scored dimensions (each 0-100, higher is better):
 *   visualHierarchy       heading presence + level order (no skips, single <h1>)
 *                         and a varied type scale that establishes focal emphasis
 *   mobileResponsiveness  responsive-breakpoint / media-query coverage across the
 *                         layout files that need it, penalising fixed-px widths
 *   spacingConsistency    share of spacing utilities on the design scale (p-4,
 *                         gap-6) versus arbitrary `[13px]` one-off values
 *   accessibility         alt / label / aria / role coverage across the elements
 *                         that require them
 *   premiumFeel           polish signals (shadow, radius, transition, hover/focus,
 *                         gradient/ring/blur, refined typography) minus
 *                         default-looking patterns (inline hex colours, unstyled
 *                         buttons, native alert()/confirm() dialogs)
 *
 * `overall` is the weighted mean; `topFixes` are the highest-leverage, most
 * actionable improvements, ordered most-impactful (lowest-scoring) first.
 *
 * File reads are fail-safe: an unreadable file is skipped rather than aborting
 * the gate (degrade-don't-crash). A `GateError` is thrown only on invalid input
 * or an internal failure — never on a detected quality issue.
 *
 * Public API:
 *   runPremiumUiGate(root, graph): Promise<UiQualityScore>
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { GateError } from '../domain/index';
import type { FileNode, GateFamily, ProjectGraph, UiQualityScore } from '../domain/index';

// --- constants --------------------------------------------------------------

/** Binds this gate to the Contract taxonomy without a runtime import. */
const GATE_FAMILY = 'premium-ui' satisfies GateFamily;

/** Page/component source files that carry JSX + Tailwind classes. */
const UI_FILE_RE = /\.[jt]sx$/;

/** A fixed pixel width at or above this is treated as a non-responsive container. */
const FIXED_WIDTH_MIN_PX = 200;

/** A dimension scoring below this contributes actionable items to `topFixes`. */
const FIX_THRESHOLD = 80;

/** Cap on the number of `topFixes` surfaced, so one weak surface can't flood them. */
const MAX_TOP_FIXES = 8;

/** Cap on offending files enumerated inside a single fix string. */
const MAX_FILES_LISTED = 3;

/**
 * Dimension weights for the `overall` mean. Accessibility and responsiveness are
 * weighted highest (they gate real usability); the set sums to exactly 1.0.
 */
const WEIGHTS = {
  visualHierarchy: 0.2,
  mobileResponsiveness: 0.25,
  spacingConsistency: 0.15,
  accessibility: 0.25,
  premiumFeel: 0.15,
} as const;

// --- Tailwind / JSX heuristic patterns --------------------------------------

/** Tailwind responsive breakpoint prefix (e.g. `md:flex`, `lg:w-1/2`). */
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

/** Standard spacing utilities on the Tailwind scale (`p-4`, `gap-6`, `space-y-2`, `-mt-1`). */
const STD_SPACING_RE =
  /\b(?:p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|space-[xy])-(?:\d+(?:\.5)?|px|auto)\b/g;
/** Arbitrary one-off spacing values (`p-[13px]`, `gap-[7px]`) that bypass the scale. */
const ARB_SPACING_RE = /\b(?:p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|space-[xy])-\[[^\]]+\]/g;

/** Typographic size scale utilities. */
const TEXT_SIZE_RE = /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g;
/** Font-weight utilities. */
const FONT_WEIGHT_RE =
  /\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g;

/** Premium polish signals (non-global — used for surface-level presence tests). */
const SHADOW_RE = /\bshadow(?:-(?:sm|md|lg|xl|2xl|inner|none))?\b/;
const RADIUS_RE = /\brounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?\b/;
const MOTION_RE = /\b(?:transition|duration-\d|ease-(?:in|out|linear|in-out)|animate-)/;
const HOVER_FOCUS_RE = /\b(?:hover|focus|focus-visible|active|group-hover):/;
const ACCENT_RE = /\b(?:ring(?:-\d)?|bg-gradient-to-[trbl]{1,2}|backdrop-blur)\b/;
const REFINED_TYPE_RE = /\b(?:tracking-(?:tighter|tight|normal|wide|wider|widest)|leading-|font-\[)/;

/** Default-looking anti-patterns. */
const INLINE_HEX_RE = /style\s*=\s*\{\{[^}]*#[0-9a-fA-F]{3,8}\b/;
const NATIVE_DIALOG_RE = /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/;

/** Accessibility helpers. */
const ARIA_LABEL_RE = /\b(?:aria-label|aria-labelledby|title)\b/;
const ONCLICK_RE = /\bonClick\b/;
const ROLE_RE = /\brole\s*=/;
const ALT_RE = /\balt\s*=/;
const CLASSNAME_RE = /\b(?:className|class)\s*=/;

/** Non-interactive tags that must not be the sole click target without a role. */
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

// --- internal shapes --------------------------------------------------------

interface DimensionScore {
  score: number;
  /** actionable, human-readable improvements this dimension surfaced */
  issues: string[];
}

interface OpenTag {
  /** raw tag name (e.g. `div`, `img`, `MyComponent`) */
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

function assertGateInputs(root: string, graph: ProjectGraph): void {
  if (typeof root !== 'string' || root.length === 0) {
    throw new GateError('Premium-UI gate requires a non-empty repository root path.');
  }
  if (!isRecord(graph) || !Array.isArray(graph.files)) {
    throw new GateError('Premium-UI gate requires a valid ProjectGraph (with a files array).');
  }
}

// --- scoring helpers --------------------------------------------------------

/** Clamp and round any raw score into the inclusive 0-100 range. */
function clampScore(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Count non-overlapping matches of a global pattern in `content` (lastIndex-safe). */
function countMatches(content: string, re: RegExp): number {
  return content.match(re)?.length ?? 0;
}

/** Truncated, comma-joined list of files for a fix string. */
function joinFiles(files: readonly string[]): string {
  const unique = [...new Set(files)];
  const shown = unique.slice(0, MAX_FILES_LISTED).join(', ');
  const extra = unique.length > MAX_FILES_LISTED ? ` (+${unique.length - MAX_FILES_LISTED} more)` : '';
  return `${shown}${extra}`;
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

/**
 * Extract JSX opening tags with their raw attributes. The scanner is brace- and
 * quote-aware: a `>` inside a `{ () => expr }` handler, a `"a > b"` string, or a
 * `` `${…}` `` template does not prematurely close the tag — a naive
 * `<tag[^>]*>` regex would mis-parse every arrow function.
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
  return stripBraceExpressions(body)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, '');
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

/** Whether a `<button>`/`<a>` is provably lacking accessible text (icon-only). */
function controlIsUnlabeled(el: OpenTag, content: string): boolean {
  if (ARIA_LABEL_RE.test(el.attrs)) return false;
  if (el.selfClosing) return false;
  const bodyEnd = content.indexOf(`</${el.tag}>`, el.bodyStart);
  const body = bodyEnd === -1 ? content.slice(el.bodyStart) : content.slice(el.bodyStart, bodyEnd);
  // A `{…}` body may render text at runtime — stay conservative and only flag an
  // element that is provably text-free.
  return !body.includes('{') && visibleText(body).length === 0;
}

// --- dimension scorers ------------------------------------------------------

/**
 * Heading presence + order across page-like files, plus focal emphasis from a
 * varied type scale. Penalises pages with no heading, multiple `<h1>`, skipped
 * heading levels, and a flat (single-size, single-weight) type scale.
 */
function scoreVisualHierarchy(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): DimensionScore {
  const noHeadingPages: string[] = [];
  const multipleH1: string[] = [];
  const skippedLevels: string[] = [];
  const sizes = new Set<string>();
  const weights = new Set<string>();

  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    for (const m of content.match(TEXT_SIZE_RE) ?? []) sizes.add(m);
    for (const m of content.match(FONT_WEIGHT_RE) ?? []) weights.add(m);

    const levels: number[] = [];
    let h1Count = 0;
    for (const el of scanOpeningTags(content)) {
      const hm = /^h([1-6])$/i.exec(el.tag);
      if (hm?.[1] === undefined) continue;
      const level = Number.parseInt(hm[1], 10);
      levels.push(level);
      if (level === 1) h1Count += 1;
    }

    const isPage = node.kind === 'page' || node.kind === 'route';
    if (isPage && levels.length === 0) noHeadingPages.push(node.path);
    if (h1Count > 1) multipleH1.push(node.path);

    let prev = 0;
    let skipped = false;
    for (const level of levels) {
      if (prev !== 0 && level > prev + 1) skipped = true;
      prev = level;
    }
    if (skipped) skippedLevels.push(node.path);
  }

  const hasHeadings = graph.files.some((n) => {
    const c = contents.get(n.path);
    return c !== undefined && /<h[1-6][\s/>]/i.test(c);
  });
  // A flat type scale only matters on a surface with real content to structure.
  const flatTypeScale = hasHeadings && sizes.size <= 1 && weights.size <= 1;

  let score = 100;
  score -= noHeadingPages.length * 25;
  score -= multipleH1.length * 15;
  score -= skippedLevels.length * 12;
  if (flatTypeScale) score -= 15;

  const issues: string[] = [];
  if (noHeadingPages.length > 0) {
    issues.push(
      `Add a clear heading hierarchy (an <h1>, then ordered <h2>/<h3>) to page(s) ${joinFiles(noHeadingPages)}.`,
    );
  }
  if (multipleH1.length > 0) {
    issues.push(
      `Use a single top-level <h1> per view; ${joinFiles(multipleH1)} declare more than one.`,
    );
  }
  if (skippedLevels.length > 0) {
    issues.push(
      `Don't skip heading levels (e.g. <h1> → <h3>) in ${joinFiles(skippedLevels)}; step down one level at a time.`,
    );
  }
  if (flatTypeScale) {
    issues.push(
      'Establish focal emphasis with a varied type scale — combine distinct text sizes and font weights instead of one flat size.',
    );
  }

  return { score: clampScore(score), issues };
}

/**
 * Responsive-breakpoint / media-query coverage across the files that lay out
 * content, penalised by fixed-px container widths that cannot adapt.
 */
function scoreMobileResponsiveness(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): DimensionScore {
  let needy = 0;
  const nonResponsive: string[] = [];
  const fixedWidth: string[] = [];

  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    const isLayout =
      node.kind === 'page' || node.kind === 'route' || LAYOUT_CLASS_RE.test(content);
    if (isLayout) {
      needy += 1;
      const isResponsive =
        RESPONSIVE_TAILWIND_RE.test(content) || RESPONSIVE_MEDIA_RE.test(content);
      if (!isResponsive) nonResponsive.push(node.path);
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
          fixedWidth.push(node.path);
          hit = true;
        }
      }
    }
  }

  // Nothing needs responsive handling → the surface can't be wrong here.
  const coverage = needy > 0 ? (needy - nonResponsive.length) / needy : 1;
  let score = 100 * coverage;
  score -= fixedWidth.length * 15;

  const issues: string[] = [];
  if (nonResponsive.length > 0) {
    issues.push(
      `Add responsive breakpoints (sm:/md:/lg:) or a media query to layout(s) ${joinFiles(nonResponsive)} so they adapt to small viewports.`,
    );
  }
  if (fixedWidth.length > 0) {
    issues.push(
      `Replace fixed pixel widths with fluid or max-width units in ${joinFiles(fixedWidth)}.`,
    );
  }

  return { score: clampScore(score), issues };
}

/**
 * Share of spacing utilities that sit on the Tailwind design scale versus
 * arbitrary `[13px]` one-offs. A surface with no spacing utilities has no
 * inconsistency to report and scores full marks.
 */
function scoreSpacingConsistency(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): DimensionScore {
  let standard = 0;
  let arbitrary = 0;
  const offenders: string[] = [];

  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;
    standard += countMatches(content, STD_SPACING_RE);
    const arb = countMatches(content, ARB_SPACING_RE);
    arbitrary += arb;
    if (arb > 0) offenders.push(node.path);
  }

  const total = standard + arbitrary;
  const score = total === 0 ? 100 : (100 * standard) / total;

  const issues: string[] = [];
  if (arbitrary > 0) {
    issues.push(
      `Replace ${arbitrary} arbitrary spacing value(s) (e.g. p-[13px]) with design-scale tokens (p-3, gap-4) in ${joinFiles(offenders)}.`,
    );
  }

  return { score: clampScore(score), issues };
}

/**
 * Alt / label / aria / role coverage across the elements that require them:
 * `<img>` alt text, labeled form controls, accessible button/anchor text, and a
 * semantic role on clickable non-interactive elements.
 */
function scoreAccessibility(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): DimensionScore {
  let total = 0;
  let good = 0;
  const missingAlt: string[] = [];
  const unlabeledInput: string[] = [];
  const unlabeledControl: string[] = [];
  const clickableNoRole: string[] = [];

  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    for (const el of scanOpeningTags(content)) {
      const lower = el.tag.toLowerCase();

      if (lower === 'img') {
        total += 1;
        if (ALT_RE.test(el.attrs)) good += 1;
        else missingAlt.push(node.path);
        continue;
      }

      if (lower === 'input' || lower === 'select' || lower === 'textarea') {
        total += 1;
        if (inputHasLabel(el.attrs, content)) good += 1;
        else unlabeledInput.push(node.path);
        continue;
      }

      if (lower === 'button' || lower === 'a') {
        total += 1;
        if (!controlIsUnlabeled(el, content)) good += 1;
        else unlabeledControl.push(node.path);
        continue;
      }

      if (NON_INTERACTIVE_TAGS.has(lower) && ONCLICK_RE.test(el.attrs)) {
        total += 1;
        if (ROLE_RE.test(el.attrs)) good += 1;
        else clickableNoRole.push(node.path);
      }
    }
  }

  const coverage = total > 0 ? good / total : 1;
  const score = 100 * coverage;

  const issues: string[] = [];
  if (missingAlt.length > 0) {
    issues.push(
      `Add alt text to <img> elements (alt="" if decorative) in ${joinFiles(missingAlt)}.`,
    );
  }
  if (unlabeledInput.length > 0) {
    issues.push(
      `Associate a label (htmlFor, aria-label, or aria-labelledby) with form control(s) in ${joinFiles(unlabeledInput)}.`,
    );
  }
  if (unlabeledControl.length > 0) {
    issues.push(
      `Give icon-only button/anchor controls an accessible name (aria-label) in ${joinFiles(unlabeledControl)}.`,
    );
  }
  if (clickableNoRole.length > 0) {
    issues.push(
      `Use a <button>, or add role + tabIndex + a key handler, to clickable non-interactive elements in ${joinFiles(clickableNoRole)}.`,
    );
  }

  return { score: clampScore(score), issues };
}

/**
 * Polish signals that separate premium from generic UI (shadow, radius, motion,
 * hover/focus states, accent depth, refined typography) minus default-looking
 * patterns (inline hex colours, unstyled buttons, native alert/confirm dialogs).
 */
function scorePremiumFeel(
  graph: ProjectGraph,
  contents: ReadonlyMap<string, string>,
): DimensionScore {
  let hasShadow = false;
  let hasRadius = false;
  let hasMotion = false;
  let hasHoverFocus = false;
  let hasAccent = false;
  let hasRefinedType = false;

  const inlineHexFiles: string[] = [];
  const nativeDialogFiles: string[] = [];
  const unstyledButtonFiles: string[] = [];

  for (const node of graph.files) {
    const content = contents.get(node.path);
    if (content === undefined) continue;

    if (SHADOW_RE.test(content)) hasShadow = true;
    if (RADIUS_RE.test(content)) hasRadius = true;
    if (MOTION_RE.test(content)) hasMotion = true;
    if (HOVER_FOCUS_RE.test(content)) hasHoverFocus = true;
    if (ACCENT_RE.test(content)) hasAccent = true;
    if (REFINED_TYPE_RE.test(content)) hasRefinedType = true;

    if (INLINE_HEX_RE.test(content)) inlineHexFiles.push(node.path);
    if (NATIVE_DIALOG_RE.test(content)) nativeDialogFiles.push(node.path);

    for (const el of scanOpeningTags(content)) {
      if (el.tag.toLowerCase() === 'button' && !CLASSNAME_RE.test(el.attrs)) {
        unstyledButtonFiles.push(node.path);
        break; // one unstyled-button finding per file is enough
      }
    }
  }

  // Neutral baseline plus additive credit for each polish signal category.
  let score = 55;
  if (hasShadow) score += 10;
  if (hasRadius) score += 12;
  if (hasMotion) score += 8;
  if (hasHoverFocus) score += 10;
  if (hasAccent) score += 8;
  if (hasRefinedType) score += 7;

  score -= inlineHexFiles.length * 10;
  score -= unstyledButtonFiles.length * 8;
  score -= nativeDialogFiles.length * 8;

  const issues: string[] = [];
  if (!hasRadius && !hasShadow) {
    issues.push(
      'Add depth with rounded corners and shadows (rounded-lg, shadow-md) — flat, borderless surfaces read as generic.',
    );
  }
  if (!hasHoverFocus) {
    issues.push('Add interactive hover/focus states (hover:, focus-visible:) to controls.');
  }
  if (!hasMotion) {
    issues.push('Add subtle motion (transition, duration-, ease-) so state changes feel intentional.');
  }
  if (inlineHexFiles.length > 0) {
    issues.push(
      `Replace inline hex colours with theme tokens/utilities in ${joinFiles(inlineHexFiles)}.`,
    );
  }
  if (unstyledButtonFiles.length > 0) {
    issues.push(
      `Style the default browser buttons in ${joinFiles(unstyledButtonFiles)} instead of shipping unstyled controls.`,
    );
  }
  if (nativeDialogFiles.length > 0) {
    issues.push(
      `Replace native alert()/confirm()/prompt() dialogs with in-app UI in ${joinFiles(nativeDialogFiles)}.`,
    );
  }

  return { score: clampScore(score), issues };
}

// --- topFixes ---------------------------------------------------------------

/**
 * Assemble `topFixes` from the lowest-scoring dimensions first. A dimension only
 * contributes when it scores below `FIX_THRESHOLD`; a low dimension with no
 * specific issue still yields a generic, actionable improvement so the caller
 * always gets guidance. The list is deduped and capped.
 */
function buildTopFixes(
  dims: ReadonlyArray<{ label: string; score: number; issues: string[] }>,
): string[] {
  const ordered = [...dims].sort((a, b) => a.score - b.score);
  const fixes: string[] = [];

  for (const dim of ordered) {
    if (dim.score >= FIX_THRESHOLD) continue;
    const items = dim.issues.length > 0 ? dim.issues : [`Improve ${dim.label} (scored ${dim.score}/100).`];
    for (const item of items) {
      if (!fixes.includes(item)) fixes.push(item);
      if (fixes.length >= MAX_TOP_FIXES) return fixes;
    }
  }
  return fixes;
}

// --- public entrypoint ------------------------------------------------------

/**
 * Run the premium-UI gate against `root`, returning a computed `UiQualityScore`.
 * Every dimension and the weighted `overall` land in the inclusive 0-100 range;
 * `topFixes` are the highest-leverage improvements ordered most-impactful-first.
 *
 * Throws `GateError` only on invalid input or an internal failure — a detected
 * quality issue lowers a score, it never throws.
 *
 * @param root  the repository root the graph was scanned from.
 * @param graph the project graph (from `scanProject`/`loadGraph`).
 */
export async function runPremiumUiGate(
  root: string,
  graph: ProjectGraph,
): Promise<UiQualityScore> {
  assertGateInputs(root, graph);
  const absRoot = path.resolve(root);

  try {
    const contents = await readUiSources(absRoot, graph);

    const visualHierarchy = scoreVisualHierarchy(graph, contents);
    const mobileResponsiveness = scoreMobileResponsiveness(graph, contents);
    const spacingConsistency = scoreSpacingConsistency(graph, contents);
    const accessibility = scoreAccessibility(graph, contents);
    const premiumFeel = scorePremiumFeel(graph, contents);

    const overall = clampScore(
      visualHierarchy.score * WEIGHTS.visualHierarchy +
        mobileResponsiveness.score * WEIGHTS.mobileResponsiveness +
        spacingConsistency.score * WEIGHTS.spacingConsistency +
        accessibility.score * WEIGHTS.accessibility +
        premiumFeel.score * WEIGHTS.premiumFeel,
    );

    const topFixes = buildTopFixes([
      { label: 'visual hierarchy', score: visualHierarchy.score, issues: visualHierarchy.issues },
      {
        label: 'mobile responsiveness',
        score: mobileResponsiveness.score,
        issues: mobileResponsiveness.issues,
      },
      {
        label: 'spacing consistency',
        score: spacingConsistency.score,
        issues: spacingConsistency.issues,
      },
      { label: 'accessibility', score: accessibility.score, issues: accessibility.issues },
      { label: 'premium feel', score: premiumFeel.score, issues: premiumFeel.issues },
    ]);

    return {
      visualHierarchy: visualHierarchy.score,
      mobileResponsiveness: mobileResponsiveness.score,
      spacingConsistency: spacingConsistency.score,
      accessibility: accessibility.score,
      premiumFeel: premiumFeel.score,
      overall,
      topFixes,
    };
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw new GateError(`Premium-UI gate failed at ${absRoot} [${GATE_FAMILY}]`, { cause: err });
  }
}
