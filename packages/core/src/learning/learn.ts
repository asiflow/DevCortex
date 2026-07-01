// ============================================================================
// learn (§7.17) — turn a diagnosed failure into durable, editable remedies.
//
// `learn` always persists the {@link LearnedFailure} under
// `.cortex/known-failures/`, then — driven by its `remedyKind` — creates ONE
// concrete remedy artifact:
//   - `regression-check` → a markdown regression note beside the record.
//   - `skill`            → a project-generated SkillManifest via the skill store.
//   - `rule`/`workflow`/`stack-pack` → a MemoryItem (risk or pattern) whose
//                          `evidence` refs point back at the refuted evidence.
//   - `known-failure`    → no extra artifact (the record itself is the remedy).
//
// The remedy artifact's ref is recorded on the persisted failure (`remedyRef`)
// so the failure and its fix stay linked. Everything is real filesystem I/O,
// atomic where it writes files directly, deterministic and tokenless. Remedies
// are transparent (plain JSON/markdown under `.cortex/`) and editable, and are
// always grounded in observed evidence — a memory remedy carries the exact
// refuted-evidence refs, never an invented claim.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DevCortexError, LearnedFailureSchema, SchemaValidationError } from '../domain/index';
import type {
  EvidenceRef,
  FailureCategory,
  LearnedFailure,
  MemoryType,
  RiskLevel,
  SkillManifest,
} from '../domain/index';
import { EvidenceLedger, MemoryLedger } from '../ledgers/index';
import type { MemoryInput } from '../ledgers/index';
import { SkillStore, skillsDir } from '../skills/skill-store';
import { assertValidSkill } from '../skills/validation';
import { workspacePaths } from '../workspace/index';

import {
  KnownFailureStore,
  knownFailureFile,
  knownFailuresDir,
} from './known-failure-store';
import { evidenceSignature, signatureTokens } from './signature';

/**
 * Collaborators for {@link learn}, injectable for testing. Any field left unset
 * is constructed from `root`, so `learn(root, failure)` works in production and
 * `learn(root, failure, { memory })` works in a test.
 */
export interface LearnDeps {
  failures?: KnownFailureStore;
  skills?: SkillStore;
  memory?: MemoryLedger;
  evidence?: EvidenceLedger;
}

/** Result of {@link learn}: absolute paths of every artifact created or updated. */
export interface LearnResult {
  created: string[];
}

/** Cap on evidence refs attached to a learned memory, so the record stays small. */
const MAX_EVIDENCE_REFS = 10;

/** Persist a learned failure and create its diagnosed remedy. */
export async function learn(
  root: string,
  failure: LearnedFailure,
  deps: LearnDeps = {},
): Promise<LearnResult> {
  const parsed = LearnedFailureSchema.safeParse(failure);
  if (!parsed.success) {
    throw new SchemaValidationError('learn() requires a valid LearnedFailure.', {
      details: parsed.error.issues,
      cause: parsed.error,
    });
  }
  const input = parsed.data;
  const failures = deps.failures ?? new KnownFailureStore(root);

  // Create the remedy first so its ref can be recorded on the persisted failure.
  const remedy = await createRemedy(root, input, deps);

  const existing = await failures.get(input.id);
  const now = new Date().toISOString();
  const record: LearnedFailure = {
    ...input,
    remedyRef: remedy.remedyRef ?? input.remedyRef,
    // Preserve the original createdAt across re-learning; always bump updatedAt.
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
  await failures.save(record);

  return { created: [knownFailureFile(root, record.id), ...remedy.created] };
}

// --- remedy creation --------------------------------------------------------

interface RemedyOutcome {
  created: string[];
  remedyRef?: string;
}

async function createRemedy(
  root: string,
  failure: LearnedFailure,
  deps: LearnDeps,
): Promise<RemedyOutcome> {
  switch (failure.remedyKind) {
    case 'regression-check': {
      const file = await writeRegressionNote(root, failure);
      return { created: [file], remedyRef: file };
    }
    case 'skill': {
      const skills = deps.skills ?? new SkillStore(root);
      const skill = buildSkill(failure);
      assertValidSkill(skill, 'learning');
      const saved = await skills.save(skill);
      return { created: [path.join(skillsDir(root), `${saved.id}.json`)], remedyRef: saved.id };
    }
    case 'rule':
    case 'workflow':
    case 'stack-pack': {
      const memory = deps.memory ?? new MemoryLedger(root);
      const evidence = deps.evidence ?? new EvidenceLedger(root);
      const refs = await matchingEvidenceRefs(evidence, failure.signature);
      const item = await memory.add(buildMemoryInput(failure, refs));
      const file = path.join(workspacePaths(root).memoryDir, `${item.id}.json`);
      return { created: [file], remedyRef: item.id };
    }
    case 'known-failure':
      return { created: [] };
    default: {
      // Exhaustiveness guard: unreachable for a schema-valid LearningRemedy.
      const exhaustive: never = failure.remedyKind;
      throw new SchemaValidationError(`Unknown remedy kind "${String(exhaustive)}".`);
    }
  }
}

/** Atomically write a human-readable regression note beside the failure record. */
async function writeRegressionNote(root: string, failure: LearnedFailure): Promise<string> {
  const dir = knownFailuresDir(root);
  const file = path.join(dir, `${failure.id}.regression.md`);
  const tmp = path.join(dir, `.${failure.id}.regression.${randomUUID()}.md.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, renderRegressionNote(failure), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new DevCortexError('INTERNAL', `Unable to write regression note to ${file}.`, {
      cause: err,
    });
  }
  return file;
}

function renderRegressionNote(failure: LearnedFailure): string {
  return [
    `# Regression check: ${failure.id}`,
    '',
    `- **Signature:** \`${failure.signature}\``,
    `- **Observed:** ${failure.occurrences}×`,
    `- **Diagnosis:** ${failure.diagnosis.category} — ${failure.diagnosis.cause}`,
    '',
    '## Check',
    '',
    'Before shipping a change that touches this area, reproduce and confirm the',
    'previously-refuted check now passes:',
    '',
    '```',
    failure.signature,
    '```',
    '',
    'This note is transparent and editable — refine the check as the fix hardens.',
    '',
  ].join('\n');
}

// --- generated skill --------------------------------------------------------

/** Deterministic per-category checklist steps prepended to the common ones. */
const CHECKLIST_BY_CATEGORY: Record<FailureCategory, string[]> = {
  'missing-context': ['Gather the surrounding files, types and env before editing.'],
  'missing-skill': ['Capture the proven approach as a reusable, checklisted skill.'],
  'outdated-docs': ['Confirm the current supported API/version before using it.'],
  'wrong-package': ['Verify the package name, export and version actually resolve.'],
  'bad-rule': ['Reconcile the change with the offending lint/style rule (fix code or the rule).'],
  'missing-test': ['Add or update a test that reproduces the failure first.'],
  'weak-agent': ['Slow down: restate the goal and constraints before acting.'],
  'missing-mcp': ['Confirm the required MCP/tool is installed and reachable first.'],
};

function buildSkill(failure: LearnedFailure): SkillManifest {
  const now = new Date().toISOString();
  return {
    id: `remedy-${failure.id}`,
    name: `Remedy for recurring ${failure.diagnosis.category} failure`,
    description: `Auto-generated from ${failure.occurrences} recurring failures. ${failure.diagnosis.cause}`,
    triggers: skillTriggers(failure),
    checklist: [
      ...CHECKLIST_BY_CATEGORY[failure.diagnosis.category],
      `Reproduce the recorded failure before editing (signature: ${failure.signature}).`,
      'Fix the root cause, not the symptom; do not suppress the error.',
      'Re-run the exact check that was refuted and confirm it now passes.',
    ],
    commands: [],
    antiPatterns: [`Repeating the change that produced: ${failure.signature}`],
    mcpRecommendations: [],
    status: 'experimental',
    source: 'project-generated',
    createdAt: now,
    updatedAt: now,
  };
}

/** Non-empty trigger set: the category plus meaningful signature keywords. */
function skillTriggers(failure: LearnedFailure): string[] {
  const stop = new Set(['cmd', 'exit', 'claim']);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of [failure.diagnosis.category, ...signatureTokens(failure.signature)]) {
    if (token.length > 0 && !stop.has(token) && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out.slice(0, 8);
}

// --- generated memory -------------------------------------------------------

function buildMemoryInput(failure: LearnedFailure, evidence: EvidenceRef[]): MemoryInput {
  const type: MemoryType = failure.remedyKind === 'rule' ? 'risk' : 'pattern';
  const riskLevel: RiskLevel = type === 'risk' ? 'high' : 'medium';
  return {
    type,
    title: `Recurring ${failure.diagnosis.category} failure`,
    summary: `${failure.diagnosis.cause} Observed ${failure.occurrences}×. Remedy kind: ${failure.remedyKind}.`,
    source: 'learning-engine',
    confidence: learnedConfidence(failure.occurrences),
    evidence,
    relatedFiles: [],
    relatedFeatures: [],
    riskLevel,
  };
}

/** Confidence grows with observed recurrences but never reaches certainty. */
function learnedConfidence(occurrences: number): number {
  return Math.min(0.95, 0.5 + 0.1 * occurrences);
}

/** Refuted evidence refs whose signature matches — the memory's evidence base. */
async function matchingEvidenceRefs(
  evidence: EvidenceLedger,
  signature: string,
): Promise<EvidenceRef[]> {
  const items = await evidence.all();
  const refs: EvidenceRef[] = [];
  for (const item of items) {
    if (item.status === 'refuted' && evidenceSignature(item) === signature) {
      refs.push({ id: item.id, claim: item.claim, status: item.status });
      if (refs.length >= MAX_EVIDENCE_REFS) {
        break;
      }
    }
  }
  return refs;
}
