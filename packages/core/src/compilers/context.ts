/**
 * `compileContext` — assemble the minimum-complete, injectable context pack for
 * an already-compiled {@link IntentContract}.
 *
 * Sources (all local, tokenless):
 *   - relevantFiles(graph, intent.goal)         → the files to read
 *   - the matched stack packs (matchPacks(stack)) → patterns / constraints /
 *     forbidden approaches
 *   - the feature ledger                          → related prior features
 *   - the memory ledger (type risk | pattern)     → known failure modes
 *   - the decision ledger (accepted)              → relevant prior decisions
 *
 * The structured fields carry the full curated data; `markdown` is the compact
 * block injected into a host agent and is the artifact bound by the depth token
 * budget — tiny ≤ 800, standard ≤ 2500, deep ≤ 6000 tokens (tokenEstimate ≈
 * chars / 4). Lower depths render fewer sections and fewer items per section; a
 * final clamp guarantees the budget is never exceeded.
 */
import type {
  ContextDepth,
  ContextPack,
  DecisionRecord,
  FeatureRecord,
  FileNode,
  IntentContract,
  MemoryItem,
  ProjectGraph,
  Rule,
  StackPack,
} from '../domain/index';
import { CONTEXT_DEPTHS, DevCortexError } from '../domain/index';
import { relevantFiles } from '../graph';
import { depthForRisk } from '../policy';
import { matchPacks } from '../stackpacks';
import type { DecisionLedger, FeatureLedger, MemoryLedger } from '../ledgers';

/** The three ledgers `compileContext` reads from. */
export interface ContextLedgers {
  memory: MemoryLedger;
  feature: FeatureLedger;
  decision: DecisionLedger;
}

/** Per-depth markdown token ceiling (tokenEstimate ≈ chars / 4). */
const TOKEN_BUDGET: Record<ContextDepth, number> = { tiny: 800, standard: 2500, deep: 6000 };

/** Per-depth caps on how many items each markdown section may render. */
interface DepthLimits {
  files: number;
  patterns: number;
  constraints: number;
  forbidden: number;
  knownFailures: number;
  features: number;
  decisions: number;
  tests: number;
  /** Render the prior-decisions section at all. */
  decisionsSection: boolean;
  /** Include the short "why" detail on forbidden approaches. */
  forbiddenDetail: boolean;
}

const LIMITS: Record<ContextDepth, DepthLimits> = {
  tiny: {
    files: 5,
    patterns: 0,
    constraints: 2,
    forbidden: 2,
    knownFailures: 2,
    features: 2,
    decisions: 0,
    tests: 3,
    decisionsSection: false,
    forbiddenDetail: false,
  },
  standard: {
    files: 10,
    patterns: 5,
    constraints: 5,
    forbidden: 5,
    knownFailures: 5,
    features: 5,
    decisions: 3,
    tests: 6,
    decisionsSection: true,
    forbiddenDetail: true,
  },
  deep: {
    files: 25,
    patterns: 20,
    constraints: 20,
    forbidden: 20,
    knownFailures: 20,
    features: 20,
    decisions: 20,
    tests: 20,
    decisionsSection: true,
    forbiddenDetail: true,
  },
};

const FIELD_CAP = 30;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'with', 'add', 'new', 'use', 'into', 'from', 'this',
  'that', 'our', 'your', 'support', 'implement', 'build', 'create', 'feature', 'change',
]);

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

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

/** First sentence (or a hard char cap) of a longer detail string. */
function firstSentence(detail: string, max = 160): string {
  const trimmed = detail.trim().replace(/\s+/g, ' ');
  const dot = trimmed.indexOf('. ');
  const sentence = dot > 0 ? trimmed.slice(0, dot + 1) : trimmed;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function scriptInvocation(pm: string, script: string): string {
  if (pm === 'pnpm' || pm === 'yarn' || pm === 'bun') return `${pm} ${script}`;
  return `npm run ${script}`;
}

/** Clamp markdown so `ceil(length / 4) <= maxTokens`, cutting at a line break. */
function clampToBudget(markdown: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (markdown.length <= maxChars) return markdown;
  const note = '\n\n_(context truncated to fit the depth budget)_';
  const room = Math.max(0, maxChars - note.length);
  const cut = markdown.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');
  const body = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
  return `${body}${note}`;
}

/**
 * Assemble the {@link ContextPack} for an intent.
 *
 * @throws DevCortexError('INTERNAL') when `intent`, `graph`, or `ledgers` are
 *   structurally invalid. A `LedgerError` from a corrupt ledger entry
 *   propagates unchanged (the caller decides whether to degrade to passive).
 */
export async function compileContext(
  intent: IntentContract,
  graph: ProjectGraph,
  ledgers: ContextLedgers,
  depth: ContextDepth,
): Promise<ContextPack> {
  if (intent === null || typeof intent !== 'object' || typeof intent.goal !== 'string') {
    throw new DevCortexError('INTERNAL', 'compileContext: intent must be an IntentContract');
  }
  if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.files)) {
    throw new DevCortexError('INTERNAL', 'compileContext: graph must be a ProjectGraph');
  }
  if (
    ledgers === null ||
    typeof ledgers !== 'object' ||
    ledgers.memory === undefined ||
    ledgers.feature === undefined ||
    ledgers.decision === undefined
  ) {
    throw new DevCortexError('INTERNAL', 'compileContext: ledgers must include memory, feature, decision');
  }

  // An invalid depth degrades to the depth recommended for the intent's risk.
  const effectiveDepth: ContextDepth = CONTEXT_DEPTHS.includes(depth)
    ? depth
    : depthForRisk(intent.riskLevel);
  const limits = LIMITS[effectiveDepth];

  // --- relevant files (graph) ----------------------------------------------
  const rankedFiles: FileNode[] = relevantFiles(graph, intent.goal);
  const relevantPaths = rankedFiles.map((f) => f.path);
  const relevantSet = new Set(relevantPaths);
  // Token-match against the goal text only; file paths carry generic tokens
  // ("page", "lib", "tsx") that would over-match unrelated ledger entries.
  const goalTokens = tokenize(intent.goal);

  // --- stack packs (patterns / constraints / forbidden approaches) ----------
  const packs: StackPack[] = matchPacks(graph.stack);
  const patternsField: string[] = [];
  const constraintsField: string[] = [];
  const forbiddenField: string[] = [];
  for (const pack of packs) {
    for (const rule of pack.bestPractices) patternsField.push(rule.title);
    for (const note of pack.securityNotes) constraintsField.push(note);
    for (const rule of pack.antiPatterns) {
      forbiddenField.push(`${rule.title}: ${firstSentence(rule.detail)}`);
    }
  }

  // --- related features (feature ledger) ------------------------------------
  const features = await ledgers.feature.list();
  const relatedFeatures: FeatureRecord[] = features.filter((f) =>
    isFeatureRelated(f, relevantSet, goalTokens),
  );
  const relatedFeaturesField = relatedFeatures.map((f) => `${f.feature} (${f.status})`);

  // --- known failures (memory ledger: type risk | pattern) ------------------
  const memories = await ledgers.memory.list(
    (m: MemoryItem) => m.type === 'risk' || m.type === 'pattern',
  );
  memories.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const knownFailuresField = memories.map((m) => `${m.title}: ${m.summary}`);

  // --- prior decisions (decision ledger: accepted, relevant) ----------------
  const decisions = await ledgers.decision.list((d: DecisionRecord) => d.status === 'accepted');
  const relatedDecisions: DecisionRecord[] = decisions.filter((d) =>
    isDecisionRelated(d, relevantSet, goalTokens),
  );

  // --- tests to run ---------------------------------------------------------
  const testFiles = rankedFiles.filter((f) => f.kind === 'test').map((f) => `run ${f.path}`);
  const packTestCommands = packs.flatMap((p) => p.testCommands);
  const scriptCommands: string[] = [];
  for (const key of ['typecheck', 'lint', 'build', 'test', 'e2e'] as const) {
    const script = graph.scripts[key];
    if (typeof script === 'string' && script.trim().length > 0) {
      scriptCommands.push(scriptInvocation(graph.stack.packageManager, key));
    }
  }
  const testsToRunField = dedupe([...testFiles, ...scriptCommands, ...packTestCommands]).slice(
    0,
    FIELD_CAP,
  );

  // --- render the budget-bound markdown -------------------------------------
  const markdown = clampToBudget(
    renderMarkdown({
      intent,
      depth: effectiveDepth,
      limits,
      relevantPaths,
      patterns: dedupe(patternsField),
      constraints: dedupe(constraintsField),
      forbidden: packs.flatMap((p) => p.antiPatterns),
      knownFailures: memories,
      relatedFeatures,
      relatedDecisions,
      tests: testsToRunField,
    }),
    TOKEN_BUDGET[effectiveDepth],
  );

  return {
    depth: effectiveDepth,
    tokenEstimate: Math.ceil(markdown.length / 4),
    relevantFiles: relevantPaths.slice(0, FIELD_CAP),
    relatedFeatures: dedupe(relatedFeaturesField),
    patterns: dedupe(patternsField),
    constraints: dedupe(constraintsField),
    knownFailures: dedupe(knownFailuresField),
    forbiddenApproaches: dedupe(forbiddenField),
    testsToRun: testsToRunField,
    markdown,
  };
}

function isFeatureRelated(
  feature: FeatureRecord,
  relevantSet: ReadonlySet<string>,
  goalTokens: ReadonlySet<string>,
): boolean {
  const surfaces = [
    ...feature.routes,
    ...feature.components,
    ...feature.apiEndpoints,
    ...feature.databaseTables,
    ...feature.envVars,
  ];
  if (surfaces.some((s) => relevantSet.has(s))) return true;
  for (const token of tokenize(`${feature.feature} ${feature.purpose}`)) {
    if (goalTokens.has(token)) return true;
  }
  return false;
}

function isDecisionRelated(
  decision: DecisionRecord,
  relevantSet: ReadonlySet<string>,
  goalTokens: ReadonlySet<string>,
): boolean {
  if (decision.affectedFiles.some((f) => relevantSet.has(f))) return true;
  for (const token of tokenize(`${decision.decision} ${decision.context}`)) {
    if (goalTokens.has(token)) return true;
  }
  return false;
}

interface RenderInput {
  intent: IntentContract;
  depth: ContextDepth;
  limits: DepthLimits;
  relevantPaths: string[];
  patterns: string[];
  constraints: string[];
  forbidden: Rule[];
  knownFailures: MemoryItem[];
  relatedFeatures: FeatureRecord[];
  relatedDecisions: DecisionRecord[];
  tests: string[];
}

function renderMarkdown(input: RenderInput): string {
  const { intent, depth, limits } = input;
  const sections: string[] = [];

  sections.push(
    [
      `## DevCortex context — ${intent.taskType} · ${intent.riskLevel} risk · ${depth}`,
      `**Goal:** ${intent.goal}`,
    ].join('\n'),
  );

  const files = input.relevantPaths.slice(0, limits.files);
  if (files.length > 0) {
    sections.push(['### Relevant files', ...files.map((p) => `- ${p}`)].join('\n'));
  }

  // Forbidden approaches are high-value even at tiny depth.
  const forbidden = input.forbidden.slice(0, limits.forbidden);
  if (forbidden.length > 0) {
    const lines = forbidden.map((rule) =>
      limits.forbiddenDetail ? `- ${rule.title} — ${firstSentence(rule.detail)}` : `- ${rule.title}`,
    );
    sections.push(['### Do NOT', ...lines].join('\n'));
  }

  const constraints = input.constraints.slice(0, limits.constraints);
  if (constraints.length > 0) {
    sections.push(['### Constraints', ...constraints.map((c) => `- ${c}`)].join('\n'));
  }

  const patterns = input.patterns.slice(0, limits.patterns);
  if (limits.patterns > 0 && patterns.length > 0) {
    sections.push(['### Patterns to follow', ...patterns.map((p) => `- ${p}`)].join('\n'));
  }

  const failures = input.knownFailures.slice(0, limits.knownFailures);
  if (failures.length > 0) {
    sections.push(
      ['### Known failure modes', ...failures.map((m) => `- ${m.title}: ${m.summary}`)].join('\n'),
    );
  }

  const relatedFeatures = input.relatedFeatures.slice(0, limits.features);
  if (relatedFeatures.length > 0) {
    sections.push(
      [
        '### Related features',
        ...relatedFeatures.map((f) => `- ${f.feature} (${f.status})`),
      ].join('\n'),
    );
  }

  if (limits.decisionsSection) {
    const decisions = input.relatedDecisions.slice(0, limits.decisions);
    if (decisions.length > 0) {
      sections.push(
        [
          '### Prior decisions',
          ...decisions.map((d) => `- ${d.decision} → chose ${d.chosenOption}`),
        ].join('\n'),
      );
    }
  }

  const tests = input.tests.slice(0, limits.tests);
  if (tests.length > 0) {
    sections.push(['### Tests to run', ...tests.map((t) => `- ${t}`)].join('\n'));
  }

  return sections.join('\n\n');
}
