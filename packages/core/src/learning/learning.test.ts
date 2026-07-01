/**
 * Self Meta-Cognitive Learning Engine tests (§7.17) — real filesystem against a
 * freshly mkdtemp'd repo root. No mocks: failures are seeded as real refuted
 * EvidenceItems in the evidence ledger and real runs in the flight recorder,
 * clustered by the real analyzer, and every remedy artifact is read back from
 * disk (known-failure JSON, regression markdown, generated skill, memory item).
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SchemaValidationError } from '../domain/index';
import type { EvidenceKind, EvidenceStatus, LearnedFailure } from '../domain/index';
import { EvidenceLedger, MemoryLedger } from '../ledgers/index';
import { attachEvidence, startRun } from '../runs/index';
import { SkillStore } from '../skills/skill-store';

import {
  analyzeFailures,
  diagnose,
  evidenceSignature,
  failureId,
  knownFailures,
  knownFailureFile,
  learn,
} from './index';

// --- fixtures ----------------------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-learning-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Seed one refuted (or otherwise-statused) evidence item; returns its id. */
async function addEvidence(
  fields: {
    kind: EvidenceKind;
    claim: string;
    detail?: string;
    command?: string;
    exitCode?: number;
    status?: EvidenceStatus;
  },
): Promise<string> {
  const item = await new EvidenceLedger(root).add({
    kind: fields.kind,
    claim: fields.claim,
    detail: fields.detail ?? fields.claim,
    status: fields.status ?? 'refuted',
    ...(fields.command !== undefined ? { command: fields.command } : {}),
    ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
  });
  return item.id;
}

/** A minimal, schema-valid LearnedFailure for direct diagnose/learn tests. */
function makeFailure(overrides: Partial<LearnedFailure> & { signature: string }): LearnedFailure {
  const now = new Date().toISOString();
  const base: LearnedFailure = {
    id: failureId(overrides.signature),
    signature: overrides.signature,
    occurrences: 3,
    diagnosis: diagnose({ signature: overrides.signature } as LearnedFailure),
    remedyKind: 'known-failure',
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides };
}

// --- analyzeFailures ---------------------------------------------------------

describe('analyzeFailures', () => {
  it('clusters recurring refuted evidence by signature and counts occurrences', async () => {
    // Same command/exit-code refuted three times => one learned failure.
    for (let i = 0; i < 3; i += 1) {
      await addEvidence({ kind: 'test', claim: 'unit suite red', command: 'pnpm test', exitCode: 1 });
    }
    // A one-off refuted failure stays below threshold.
    await addEvidence({ kind: 'build', claim: 'flaky once', command: 'pnpm build', exitCode: 2 });
    // Verified evidence is not a failure and must be ignored.
    await addEvidence({ kind: 'test', claim: 'green', command: 'pnpm test', exitCode: 0, status: 'verified' });

    const learned = await analyzeFailures(root);

    expect(learned).toHaveLength(1);
    const [failure] = learned;
    expect(failure?.signature).toBe('test:cmd=pnpm test#exit=1');
    expect(failure?.occurrences).toBe(3);
    expect(failure?.id).toBe(failureId('test:cmd=pnpm test#exit=1'));
    expect(failure?.diagnosis.category).toBe('missing-test');
    expect(failure?.remedyKind).toBe('regression-check');
  });

  it('respects a custom minOccurrences threshold', async () => {
    for (let i = 0; i < 3; i += 1) {
      await addEvidence({ kind: 'test', claim: 'red', command: 'pnpm test', exitCode: 1 });
    }
    expect(await analyzeFailures(root, { minOccurrences: 4 })).toEqual([]);
    expect(await analyzeFailures(root, { minOccurrences: 3 })).toHaveLength(1);
  });

  it('surfaces a failure that spans multiple runs even with a single evidence item', async () => {
    // One refuted evidence item, referenced by two distinct runs => run spread 2.
    const evidenceId = await addEvidence({
      kind: 'lint',
      claim: 'eslint failure',
      command: 'pnpm lint',
      exitCode: 1,
    });
    const runA = await startRun(root, 'first attempt');
    const runB = await startRun(root, 'second attempt');
    await attachEvidence(root, runA.id, evidenceId);
    await attachEvidence(root, runB.id, evidenceId);

    const learned = await analyzeFailures(root);

    expect(learned).toHaveLength(1);
    expect(learned[0]?.occurrences).toBe(2); // max(evidenceCount=1, runSpread=2)
    expect(learned[0]?.diagnosis.category).toBe('bad-rule');
    expect(learned[0]?.remedyKind).toBe('rule');
  });

  it('returns nothing on a clean project', async () => {
    expect(await analyzeFailures(root)).toEqual([]);
  });

  it('orders multiple learned failures most-recurring first', async () => {
    for (let i = 0; i < 3; i += 1) {
      await addEvidence({ kind: 'test', claim: 'red', command: 'pnpm test', exitCode: 1 });
    }
    for (let i = 0; i < 2; i += 1) {
      await addEvidence({ kind: 'lint', claim: 'lint red', command: 'pnpm lint', exitCode: 1 });
    }

    const learned = await analyzeFailures(root);
    expect(learned.map((f) => f.occurrences)).toEqual([3, 2]);
    expect(learned.map((f) => f.diagnosis.category)).toEqual(['missing-test', 'bad-rule']);

    // Persisting both keeps the same most-recurring-first order on read-back.
    for (const failure of learned) {
      await learn(root, failure);
    }
    const stored = await knownFailures(root);
    expect(stored.map((f) => f.occurrences)).toEqual([3, 2]);
  });

  it('rejects a non-positive-integer threshold', async () => {
    await expect(analyzeFailures(root, { minOccurrences: 0 })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
  });
});

// --- diagnose ----------------------------------------------------------------

describe('diagnose', () => {
  it('maps signatures to deterministic categories', () => {
    const category = (signature: string): string => diagnose(makeFailure({ signature })).category;
    expect(category('test:cmd=pnpm test#exit=1')).toBe('missing-test');
    expect(category('import:claim=cannot find module foo')).toBe('wrong-package');
    expect(category('lint:cmd=pnpm lint#exit=1')).toBe('bad-rule');
    expect(category('env:claim=environment variable missing')).toBe('missing-context');
    expect(category('build:claim=api is deprecated')).toBe('outdated-docs');
    expect(category('runtime:claim=some unexplained crash')).toBe('weak-agent');
  });

  it('always includes the signature in the human-readable cause', () => {
    const d = diagnose(makeFailure({ signature: 'lint:cmd=pnpm lint#exit=1' }));
    expect(d.cause).toContain('pnpm lint');
  });
});

// --- learn -------------------------------------------------------------------

describe('learn', () => {
  it('persists the learned failure and a regression-check note', async () => {
    for (let i = 0; i < 2; i += 1) {
      await addEvidence({ kind: 'test', claim: 'red', command: 'pnpm test', exitCode: 1 });
    }
    const [failure] = await analyzeFailures(root);
    expect(failure).toBeDefined();

    const { created } = await learn(root, failure as LearnedFailure);

    expect(created).toHaveLength(2);
    const recordPath = knownFailureFile(root, (failure as LearnedFailure).id);
    expect(created).toContain(recordPath);
    const notePath = created.find((p) => p.endsWith('.regression.md'));
    expect(notePath).toBeDefined();

    // Both artifacts exist on disk and the note references the signature.
    await expect(stat(recordPath)).resolves.toBeDefined();
    const note = await readFile(notePath as string, 'utf8');
    expect(note).toContain((failure as LearnedFailure).signature);

    // knownFailures reads it back with the remedyRef wired to the note.
    const stored = await knownFailures(root);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.remedyKind).toBe('regression-check');
    expect(stored[0]?.remedyRef).toBe(notePath);
  });

  it('generates an experimental skill for a skill-remedy failure', async () => {
    const failure = makeFailure({
      signature: 'runtime:claim=agent looped without progress',
      remedyKind: 'skill',
      diagnosis: {
        category: 'weak-agent',
        cause: 'weak agent behavior (signature: runtime:claim=agent looped without progress).',
      },
    });

    const { created } = await learn(root, failure);

    const skills = await new SkillStore(root).all();
    expect(skills).toHaveLength(1);
    const [skill] = skills;
    expect(skill?.status).toBe('experimental');
    expect(skill?.source).toBe('project-generated');
    expect(skill?.triggers.length).toBeGreaterThan(0);
    expect(skill?.checklist.length).toBeGreaterThan(0);
    expect(created.some((p) => p.endsWith(`${skill?.id}.json`))).toBe(true);

    const stored = await knownFailures(root);
    expect(stored[0]?.remedyRef).toBe(skill?.id);
  });

  it('records a risk memory item with evidence refs for a rule-remedy failure', async () => {
    // Two refuted items so the memory carries real evidence refs.
    await addEvidence({ kind: 'import', claim: 'cannot find module left-pad', command: 'pnpm build', exitCode: 1 });
    await addEvidence({ kind: 'import', claim: 'cannot find module left-pad', command: 'pnpm build', exitCode: 1 });
    const [failure] = await analyzeFailures(root);
    expect(failure?.remedyKind).toBe('rule');

    const { created } = await learn(root, failure as LearnedFailure);

    const memory = await new MemoryLedger(root).all();
    expect(memory).toHaveLength(1);
    const [item] = memory;
    expect(item?.type).toBe('risk');
    expect(item?.riskLevel).toBe('high');
    expect(item?.confidence).toBeGreaterThan(0.5);
    expect(item?.confidence).toBeLessThan(1);
    expect(item?.evidence.length).toBeGreaterThan(0);
    expect(item?.evidence.every((ref) => ref.status === 'refuted')).toBe(true);
    expect(created.some((p) => p.endsWith(`${item?.id}.json`))).toBe(true);
  });

  it('preserves createdAt but bumps updatedAt when re-learning the same failure', async () => {
    const failure = makeFailure({
      signature: 'test:cmd=pnpm test#exit=1',
      remedyKind: 'regression-check',
    });

    await learn(root, failure);
    const first = (await knownFailures(root))[0];
    expect(first).toBeDefined();

    // Re-learn the same signature (same content-addressed id) with more occurrences.
    await learn(root, { ...failure, occurrences: 9 });
    const stored = await knownFailures(root);

    expect(stored).toHaveLength(1); // same id => overwrite, not duplicate
    expect(stored[0]?.createdAt).toBe(first?.createdAt);
    expect(stored[0]?.occurrences).toBe(9);
  });

  it('creates only the record for a known-failure remedy', async () => {
    const failure = makeFailure({
      signature: 'command:cmd=custom thing#exit=7',
      remedyKind: 'known-failure',
    });

    const { created } = await learn(root, failure);

    expect(created).toEqual([knownFailureFile(root, failure.id)]);
    expect(await new SkillStore(root).all()).toEqual([]);
    expect(await new MemoryLedger(root).all()).toEqual([]);
  });

  it('rejects an invalid LearnedFailure', async () => {
    const bad = { signature: 'x' } as unknown as LearnedFailure;
    await expect(learn(root, bad)).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

// --- signature ---------------------------------------------------------------

describe('evidenceSignature', () => {
  it('is stable and command/exit-code addressed, ignoring incidental whitespace', async () => {
    await addEvidence({ kind: 'test', claim: 'red', command: '  pnpm    test  ', exitCode: 1 });
    const [item] = await new EvidenceLedger(root).all();
    expect(item).toBeDefined();
    if (item === undefined) {
      return;
    }
    expect(evidenceSignature(item)).toBe('test:cmd=pnpm test#exit=1');
  });

  it('marks a missing exit code as NA and falls back to the claim without a command', async () => {
    await addEvidence({ kind: 'command', claim: 'process was killed', command: 'pnpm dev' });
    await addEvidence({ kind: 'route', claim: '  /dashboard   404s ' });
    const items = await new EvidenceLedger(root).all();
    const signatures = items.map(evidenceSignature).sort();
    expect(signatures).toEqual(['command:cmd=pnpm dev#exit=NA', 'route:claim=/dashboard 404s']);
  });
});
