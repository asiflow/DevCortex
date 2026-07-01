// ============================================================================
// Skill Engine public API (§7.18).
//
// The built-in pack, the SkillStore and the validators are the substrate; this
// module is the behaviour the rest of DevCortex consumes:
//
//   loadSkills(root)                     — built-in pack ∪ project skills, deduped
//   recommendSkills(task, graph, config) — rank skills by task + detected stack
//   installSkill(root, skill)            — validate then persist a project skill
//   generateSkillFromFailure(failure)    — deterministic skill from a diagnosis
//
// Everything here is deterministic and tokenless (the OSS layer): recommendation
// is pure keyword/stack matching — no LLM call — so the same task + graph always
// yields the same ranking. Persistence reuses SkillStore (atomic, schema-checked
// writes under `.cortex/skills/`) and every skill that reaches disk first passes
// the strict `assertValidSkill` gate, so a hollow or path-escaping skill can
// never be installed.
// ============================================================================

import { LearnedFailureSchema, SchemaValidationError } from '../domain/index';
import type {
  CortexConfig,
  DetectedStack,
  FailureCategory,
  LearnedFailure,
  ProjectGraph,
  SkillManifest,
} from '../domain/index';

import { builtInSkills } from './built-in';
import { SkillStore } from './skill-store';
import { assertValidSkill } from './validation';

// --- load -------------------------------------------------------------------

/**
 * Every skill available in `root`: the built-in pack merged with the project's
 * own skills under `.cortex/skills/`.
 *
 * A project skill whose id matches a built-in one *overrides* it in place (a
 * project may deliberately customise a shipped skill). Ordering is
 * deterministic — built-in order first (with any overrides applied), then the
 * remaining project skills sorted by id — so callers and snapshots are stable
 * regardless of filesystem `readdir` order. Project skills are read through
 * {@link SkillStore}, so each is re-validated against the disk contract; a
 * corrupt file surfaces as a LedgerError rather than poisoning the result.
 */
export async function loadSkills(root: string): Promise<SkillManifest[]> {
  const project = (await new SkillStore(root).all())
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const byId = new Map<string, SkillManifest>();
  for (const skill of builtInSkills) {
    byId.set(skill.id, skill);
  }
  for (const skill of project) {
    byId.set(skill.id, skill);
  }

  const result: SkillManifest[] = [];
  const emitted = new Set<string>();
  for (const skill of builtInSkills) {
    result.push(byId.get(skill.id) ?? skill);
    emitted.add(skill.id);
  }
  for (const skill of project) {
    if (!emitted.has(skill.id)) {
      result.push(skill);
      emitted.add(skill.id);
    }
  }
  return result;
}

// --- recommend --------------------------------------------------------------

/** A skill paired with the deterministic score {@link recommendSkills} ranked it by. */
interface ScoredSkill {
  skill: SkillManifest;
  score: number;
  index: number;
}

/**
 * Rank the available skills for a task, most-relevant first.
 *
 * Scoring is deterministic and tokenless:
 *  - **task signal** — each of the skill's `triggers` that fully appears in the
 *    task (all of a multi-word trigger's tokens present) contributes its token
 *    count, so specific multi-word triggers outweigh single generic keywords.
 *  - **stack signal** — each distinct keyword derived from the detected stack
 *    (`graph.stack` framework / language / package manager / deployment targets)
 *    and the force-loaded `config.stackPacks` that appears in the skill's
 *    triggers contributes one point.
 *
 * Only skills with a positive score are returned (a skill with no task or stack
 * signal is not relevant). Ties preserve the input order, so the ranking is
 * stable. `pool` defaults to the built-in pack — the always-available set — but
 * a caller that has already {@link loadSkills | loaded} project skills may pass
 * them in to rank the full set.
 */
export function recommendSkills(
  task: string,
  graph: ProjectGraph,
  config: CortexConfig,
  pool: readonly SkillManifest[] = builtInSkills,
): SkillManifest[] {
  const taskTokens = new Set(tokenize(task));
  const stackTokens = stackKeywords(graph.stack, config);

  const scored: ScoredSkill[] = [];
  pool.forEach((skill, index) => {
    const score = taskScore(skill, taskTokens) + stackScore(skill, stackTokens);
    if (score > 0) {
      scored.push({ skill, score, index });
    }
  });

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map((entry) => entry.skill);
}

/** Sum of token counts for every trigger fully present in the task. */
function taskScore(skill: SkillManifest, taskTokens: ReadonlySet<string>): number {
  let score = 0;
  for (const trigger of skill.triggers) {
    const tokens = tokenize(trigger);
    if (tokens.length === 0) {
      continue;
    }
    if (tokens.every((token) => taskTokens.has(token))) {
      score += tokens.length;
    }
  }
  return score;
}

/** Count of distinct stack keywords that appear among the skill's trigger tokens. */
function stackScore(skill: SkillManifest, stackTokens: ReadonlySet<string>): number {
  if (stackTokens.size === 0) {
    return 0;
  }
  const skillTokens = new Set<string>();
  for (const trigger of skill.triggers) {
    for (const token of tokenize(trigger)) {
      skillTokens.add(token);
    }
  }
  let score = 0;
  for (const token of stackTokens) {
    if (skillTokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

/** Keyword set derived from the detected stack plus any force-loaded stack packs. */
function stackKeywords(stack: DetectedStack, config: CortexConfig): Set<string> {
  const keywords = new Set<string>();
  const add = (value: string): void => {
    for (const token of tokenize(value)) {
      keywords.add(token);
    }
  };
  if (stack.framework !== 'unknown') {
    add(stack.framework);
  }
  if (stack.language !== 'unknown') {
    add(stack.language);
  }
  if (stack.packageManager !== 'unknown') {
    add(stack.packageManager);
  }
  for (const target of stack.deploymentTargets) {
    add(target);
  }
  for (const pack of config.stackPacks) {
    add(pack);
  }
  return keywords;
}

// --- install ----------------------------------------------------------------

/**
 * Validate `skill` against the strict engine contract and persist it under
 * `.cortex/skills/<id>.json`, overwriting any existing skill with the same id.
 *
 * Validation happens *before* any I/O, so a hollow (no triggers / no checklist)
 * or unsafely-named skill is rejected with a {@link SchemaValidationError} and
 * never reaches disk. The write itself is atomic (temp file + rename) via
 * {@link SkillStore}.
 */
export async function installSkill(root: string, skill: SkillManifest): Promise<void> {
  assertValidSkill(skill, 'install');
  await new SkillStore(root).save(skill);
}

// --- generate from failure --------------------------------------------------

/** Fixed provenance used only when a failure carries no usable timestamp. */
const GENERATED_FALLBACK_AT = '2026-07-01T00:00:00.000Z';

/** Category-specific opening checklist step for a generated remedy skill. */
const CHECKLIST_BY_CATEGORY: Record<FailureCategory, string> = {
  'missing-context': 'Gather the surrounding files, types and environment before editing.',
  'missing-skill': 'Capture the proven approach as a reusable, checklisted skill.',
  'outdated-docs': 'Confirm the current supported API/version against authoritative docs before using it.',
  'wrong-package': 'Verify the package name, its exports and its installed version actually resolve.',
  'bad-rule':
    'Reconcile the change with the offending lint/style rule — fix the code or the rule, never suppress it.',
  'missing-test': 'Add or update a test that reproduces the failure before changing behaviour.',
  'weak-agent': 'Slow down: restate the goal and the constraints, then act deliberately.',
  'missing-mcp': 'Confirm the required MCP/tool is installed and reachable before relying on it.',
};

/** Category-specific MCP hints; categories not listed carry none. */
const MCP_BY_CATEGORY: Partial<Record<FailureCategory, string[]>> = {
  'missing-mcp': ['Install and verify the MCP/tool this task depends on before proceeding.'],
  'outdated-docs': ['Docs MCP (read-only) to confirm the current, supported API.'],
};

/** Generic stop tokens that carry no signal as skill triggers. */
const TRIGGER_STOP_TOKENS: ReadonlySet<string> = new Set([
  'cmd',
  'exit',
  'exitcode',
  'code',
  'claim',
]);

/**
 * Build a deterministic, experimental {@link SkillManifest} from a diagnosed
 * recurring failure.
 *
 * The manifest is a pure function of `failure` — its id (`remedy-<failure-id>`),
 * triggers (the diagnosis category plus meaningful signature keywords), the
 * category-specific checklist and its timestamps all derive from the input, so
 * the same failure always generates the same skill (no clock, no randomness).
 * The result is passed through {@link assertValidSkill} before being returned,
 * so a caller can install it directly with confidence it satisfies the strict
 * contract.
 *
 * @throws SchemaValidationError when `failure` is not a valid LearnedFailure.
 */
export function generateSkillFromFailure(failure: LearnedFailure): SkillManifest {
  const parsed = LearnedFailureSchema.safeParse(failure);
  if (!parsed.success) {
    throw new SchemaValidationError('generateSkillFromFailure() requires a valid LearnedFailure.', {
      details: parsed.error.issues,
      cause: parsed.error,
    });
  }
  const f = parsed.data;
  const createdAt = f.createdAt || f.updatedAt || GENERATED_FALLBACK_AT;
  const updatedAt = f.updatedAt || f.createdAt || GENERATED_FALLBACK_AT;
  const plural = f.occurrences === 1 ? '' : 's';

  const skill: SkillManifest = {
    id: `remedy-${f.id}`,
    name: `Remedy for recurring ${f.diagnosis.category} failure`,
    description: `Auto-generated from ${f.occurrences} recurring "${f.diagnosis.category}" failure${plural}. ${f.diagnosis.cause}`.trim(),
    triggers: deriveTriggers(f),
    checklist: [
      CHECKLIST_BY_CATEGORY[f.diagnosis.category],
      `Reproduce the recorded failure before editing (signature: ${f.signature}).`,
      'Fix the root cause, not the symptom — never suppress or silence the error.',
      'Re-run the exact check that was refuted and confirm it now passes.',
    ],
    commands: [],
    antiPatterns: [`Repeating the change that produced: ${f.signature}`],
    mcpRecommendations: MCP_BY_CATEGORY[f.diagnosis.category] ?? [],
    status: 'experimental',
    source: 'project-generated',
    createdAt,
    updatedAt,
  };

  // Defensive: the construction above always satisfies the strict contract
  // (category guarantees ≥1 trigger and ≥1 checklist step); this makes that an
  // enforced invariant so a future edit cannot silently emit an invalid skill.
  assertValidSkill(skill, 'generate');
  return skill;
}

/** Non-empty trigger set: the diagnosis category plus meaningful signature keywords. */
function deriveTriggers(failure: LearnedFailure): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [failure.diagnosis.category, ...tokenize(failure.signature, 3)]) {
    if (candidate.length > 0 && !TRIGGER_STOP_TOKENS.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out.slice(0, 8);
}

// --- shared tokenizer -------------------------------------------------------

/**
 * Lowercased alphanumeric tokens (runs of length ≥ `min`), deduped and
 * order-preserving. The single deterministic tokenizer behind recommendation
 * matching and trigger derivation.
 */
function tokenize(text: string, min = 1): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= min && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}
