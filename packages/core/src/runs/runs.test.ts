/**
 * Agent Flight Recorder tests (§7.16) — real filesystem against a freshly
 * mkdtemp'd repo root. No mocks: every run is a real directory under
 * `.cortex/runs/`, every record.json is real JSON re-validated with the owning
 * zod schema, and the artifact files (jsonl/log/json/md) are read back from disk.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PolicyViolationError, SchemaValidationError, isDevCortexError } from '../domain/index';
import { workspacePaths } from '../workspace/index';

import {
  attachEvidence,
  compareRuns,
  finishRun,
  listRuns,
  loadRun,
  recordArtifact,
  startRun,
} from './index';

// --- fixtures ----------------------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-runs-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Absolute path of an artifact file inside a run directory. */
function artifact(runId: string, name: string): string {
  return path.join(workspacePaths(root).runsDir, runId, name);
}

// --- startRun ----------------------------------------------------------------

describe('startRun', () => {
  it('creates the run directory, all artifact files, and an open record', async () => {
    const run = await startRun(root, 'wire the Stripe webhook');

    expect(run.id).toMatch(/^run-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}$/);
    expect(run.dir).toBe(path.join(workspacePaths(root).runsDir, run.id));
    expect(run.task).toBe('wire the Stripe webhook');
    expect(new Date(run.createdAt).toISOString()).toBe(run.createdAt);
    expect(run.status).toBe('open');
    expect(run.toolCalls).toEqual([]);
    expect(run.commands).toEqual([]);
    expect(run.evidenceIds).toEqual([]);
    expect(run.intentPresent).toBe(false);
    expect(run.contextPresent).toBe(false);
    expect(run.planPresent).toBe(false);
    expect(run.prompt).toBeUndefined();
    expect(run.shipReportPath).toBeUndefined();
    expect(run.learning).toBeUndefined();

    // Every artifact file exists; evidence.json is a valid JSON array from byte 0.
    for (const name of [
      'record.json',
      'prompt.md',
      'intent.md',
      'context.md',
      'plan.md',
      'toolcalls.jsonl',
      'commands.log',
      'evidence.json',
      'ship-report.md',
      'learning.md',
    ]) {
      await expect(readFile(artifact(run.id, name), 'utf8')).resolves.toBeTypeOf('string');
    }
    expect(JSON.parse(await readFile(artifact(run.id, 'evidence.json'), 'utf8'))).toEqual([]);

    // record.json round-trips through loadRun.
    const reloaded = await loadRun(root, run.id);
    expect(reloaded).toEqual(run);
  });

  it('rejects an empty task', async () => {
    await expect(startRun(root, '   ')).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('produces unique ids for rapid successive runs', async () => {
    const runs = await Promise.all([
      startRun(root, 'task a'),
      startRun(root, 'task b'),
      startRun(root, 'task c'),
    ]);
    const ids = new Set(runs.map((r) => r.id));
    expect(ids.size).toBe(3);
  });
});

// --- recordArtifact ----------------------------------------------------------

describe('recordArtifact', () => {
  it('writes the markdown artifacts and flips the coverage flags', async () => {
    const run = await startRun(root, 'onboarding wizard backend');

    await recordArtifact(root, run.id, 'prompt', 'build the onboarding state machine');
    await recordArtifact(root, run.id, 'intent', 'compiled: create onboarding state machine');
    await recordArtifact(root, run.id, 'context', 'context pack: 3 files');
    await recordArtifact(root, run.id, 'plan', '1. schema 2. resolver 3. tests');
    await recordArtifact(root, run.id, 'learning', 'prefer gen_statem for wizard steps');

    expect(await readFile(artifact(run.id, 'prompt.md'), 'utf8')).toBe(
      'build the onboarding state machine',
    );
    expect(await readFile(artifact(run.id, 'intent.md'), 'utf8')).toBe(
      'compiled: create onboarding state machine',
    );
    expect(await readFile(artifact(run.id, 'plan.md'), 'utf8')).toBe('1. schema 2. resolver 3. tests');
    expect(await readFile(artifact(run.id, 'learning.md'), 'utf8')).toBe(
      'prefer gen_statem for wizard steps',
    );

    const reloaded = await loadRun(root, run.id);
    expect(reloaded.prompt).toBe('build the onboarding state machine');
    expect(reloaded.intentPresent).toBe(true);
    expect(reloaded.contextPresent).toBe(true);
    expect(reloaded.planPresent).toBe(true);
    expect(reloaded.learning).toBe('prefer gen_statem for wizard steps');
  });

  it('records ship-report content and points shipReportPath at it', async () => {
    const run = await startRun(root, 'billing service');
    await recordArtifact(root, run.id, 'ship-report', '# Ship Report\nAll green.');

    expect(await readFile(artifact(run.id, 'ship-report.md'), 'utf8')).toBe(
      '# Ship Report\nAll green.',
    );
    const reloaded = await loadRun(root, run.id);
    expect(reloaded.shipReportPath).toBe(artifact(run.id, 'ship-report.md'));
  });

  it('appends tool calls as valid JSON Lines and mirrors them into the record', async () => {
    const run = await startRun(root, 'federation subgraph');
    const first = { tool: 'read', args: { path: 'schema.graphql' } };
    const second = { tool: 'bash', args: { cmd: 'pnpm test' }, ok: true };

    await recordArtifact(root, run.id, 'toolcall', JSON.stringify(first));
    await recordArtifact(root, run.id, 'toolcall', JSON.stringify(second));

    const raw = await readFile(artifact(run.id, 'toolcalls.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([first, second]);

    const reloaded = await loadRun(root, run.id);
    expect(reloaded.toolCalls).toEqual([first, second]);
  });

  it('normalizes a tool call payload with embedded newlines onto one line', async () => {
    const run = await startRun(root, 'multiline payload');
    const payload = { tool: 'write', body: 'line1\nline2\nline3' };
    await recordArtifact(root, run.id, 'toolcall', JSON.stringify(payload));

    const raw = await readFile(artifact(run.id, 'toolcalls.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual(payload);
  });

  it('rejects a tool call that is not valid JSON', async () => {
    const run = await startRun(root, 'bad toolcall');
    await expect(recordArtifact(root, run.id, 'toolcall', 'not-json')).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
  });

  it('appends commands to commands.log and mirrors them into the record', async () => {
    const run = await startRun(root, 'command capture');
    await recordArtifact(root, run.id, 'command', 'pnpm install');
    await recordArtifact(root, run.id, 'command', 'pnpm --filter @devcortex/core test');

    const log = await readFile(artifact(run.id, 'commands.log'), 'utf8');
    expect(log).toBe('pnpm install\npnpm --filter @devcortex/core test\n');

    const reloaded = await loadRun(root, run.id);
    expect(reloaded.commands).toEqual(['pnpm install', 'pnpm --filter @devcortex/core test']);
  });

  it('rejects recording against a non-existent run', async () => {
    await expect(recordArtifact(root, 'run-does-not-exist', 'plan', 'x')).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
  });

  it('rejects non-string content from a JS caller', async () => {
    const run = await startRun(root, 'bad content type');
    await expect(
      recordArtifact(root, run.id, 'plan', 42 as unknown as string),
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('rejects an unknown artifact key from a JS caller (exhaustiveness guard)', async () => {
    const run = await startRun(root, 'unknown key');
    await expect(
      recordArtifact(root, run.id, 'screenshot' as never, 'x'),
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('refuses to write to a closed run', async () => {
    const run = await startRun(root, 'seal me');
    await finishRun(root, run.id);
    await expect(recordArtifact(root, run.id, 'command', 'echo hi')).rejects.toBeInstanceOf(
      PolicyViolationError,
    );
  });
});

// --- attachEvidence ----------------------------------------------------------

describe('attachEvidence', () => {
  it('adds evidence ids, deduplicates, and mirrors them into evidence.json', async () => {
    const run = await startRun(root, 'evidence run');
    await attachEvidence(root, run.id, 'ev-1');
    await attachEvidence(root, run.id, 'ev-2');
    await attachEvidence(root, run.id, 'ev-1'); // duplicate — no-op

    const onDisk = JSON.parse(await readFile(artifact(run.id, 'evidence.json'), 'utf8'));
    expect(onDisk).toEqual(['ev-1', 'ev-2']);

    const reloaded = await loadRun(root, run.id);
    expect(reloaded.evidenceIds).toEqual(['ev-1', 'ev-2']);
  });

  it('rejects an empty evidence id', async () => {
    const run = await startRun(root, 'bad evidence');
    await expect(attachEvidence(root, run.id, '')).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('refuses to attach evidence to a closed run', async () => {
    const run = await startRun(root, 'closed evidence');
    await finishRun(root, run.id);
    await expect(attachEvidence(root, run.id, 'ev-1')).rejects.toBeInstanceOf(PolicyViolationError);
  });
});

// --- finishRun ---------------------------------------------------------------

describe('finishRun', () => {
  it('seals the run and records an external ship report path', async () => {
    const run = await startRun(root, 'finish me');
    const shipPath = path.join(root, 'SHIP.md');
    const finished = await finishRun(root, run.id, shipPath);

    expect(finished.status).toBe('closed');
    expect(finished.shipReportPath).toBe(shipPath);
    expect((await loadRun(root, run.id)).status).toBe('closed');
  });

  it('is idempotent and can update the ship report path on a closed run', async () => {
    const run = await startRun(root, 'finish twice');
    await finishRun(root, run.id);
    const again = await finishRun(root, run.id, path.join(root, 'SHIP2.md'));
    expect(again.status).toBe('closed');
    expect(again.shipReportPath).toBe(path.join(root, 'SHIP2.md'));
  });

  it('rejects an empty ship report path when one is provided', async () => {
    const run = await startRun(root, 'bad ship path');
    await expect(finishRun(root, run.id, '')).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

// --- listRuns / loadRun ------------------------------------------------------

describe('listRuns', () => {
  it('returns an empty array when no runs directory exists', async () => {
    await expect(listRuns(root)).resolves.toEqual([]);
  });

  it('lists every run sorted by createdAt then id, ignoring foreign entries', async () => {
    const a = await startRun(root, 'first');
    const b = await startRun(root, 'second');
    const c = await startRun(root, 'third');

    // A stray non-run directory and a run-shaped dir without a record.json.
    const { runsDir } = workspacePaths(root);
    await mkdir(path.join(runsDir, 'not-a-run'), { recursive: true });
    await mkdir(path.join(runsDir, 'run-incomplete'), { recursive: true });
    await writeFile(path.join(runsDir, 'stray.txt'), 'ignore me', 'utf8');

    const runs = await listRuns(root);
    expect(runs.map((r) => r.id)).toEqual([a.id, b.id, c.id]);

    // Sorted non-decreasing by createdAt.
    const stamps = runs.map((r) => r.createdAt);
    expect([...stamps].sort()).toEqual(stamps);
  });
});

describe('loadRun', () => {
  it('throws for a missing run', async () => {
    await expect(loadRun(root, 'run-missing')).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('rejects an unsafe (path-traversing) run id', async () => {
    const err = await loadRun(root, '../escape').catch((e: unknown) => e);
    expect(isDevCortexError(err)).toBe(true);
    expect((err as SchemaValidationError).code).toBe('SCHEMA_VALIDATION');
  });

  it('rejects an empty run id', async () => {
    await expect(loadRun(root, '')).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('surfaces a syntactically corrupt record.json as a validation error', async () => {
    const run = await startRun(root, 'corrupt me');
    await writeFile(artifact(run.id, 'record.json'), '{ not valid json', 'utf8');
    await expect(loadRun(root, run.id)).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('surfaces valid JSON of the wrong shape as a schema validation error', async () => {
    const run = await startRun(root, 'wrong shape');
    await writeFile(artifact(run.id, 'record.json'), '{"id":"x","not":"a run"}', 'utf8');
    await expect(loadRun(root, run.id)).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('maps an unexpected read failure (record.json is a directory) to an INTERNAL error', async () => {
    const run = await startRun(root, 'eisdir');
    const recordPath = artifact(run.id, 'record.json');
    await rm(recordPath, { force: true });
    await mkdir(recordPath, { recursive: true }); // reading a directory yields EISDIR, not ENOENT
    const err = await loadRun(root, run.id).catch((e: unknown) => e);
    expect(isDevCortexError(err)).toBe(true);
    expect((err as SchemaValidationError).code).toBe('INTERNAL');
  });
});

// --- compareRuns -------------------------------------------------------------

describe('compareRuns', () => {
  it('reports same task and symmetric command/evidence deltas', async () => {
    const a = await startRun(root, 'same task');
    const b = await startRun(root, 'same task');

    await recordArtifact(root, a.id, 'command', 'pnpm build');
    await recordArtifact(root, a.id, 'command', 'pnpm test');
    await recordArtifact(root, b.id, 'command', 'pnpm build');
    await recordArtifact(root, b.id, 'command', 'pnpm lint');

    await attachEvidence(root, a.id, 'ev-shared');
    await attachEvidence(root, a.id, 'ev-only-a');
    await attachEvidence(root, b.id, 'ev-shared');

    const cmp = await compareRuns(root, a.id, b.id);
    expect(cmp.sameTask).toBe(true);
    // 'pnpm build' is shared and excluded; only the differing commands remain.
    expect(cmp.commandDelta).toEqual(['pnpm lint', 'pnpm test']);
    expect(cmp.evidenceDelta).toEqual(['ev-only-a']);
  });

  it('reports differing tasks and empty deltas for identical runs', async () => {
    const a = await startRun(root, 'task one');
    const b = await startRun(root, 'task two');
    await recordArtifact(root, a.id, 'command', 'pnpm test');
    await recordArtifact(root, b.id, 'command', 'pnpm test');

    const cmp = await compareRuns(root, a.id, b.id);
    expect(cmp.sameTask).toBe(false);
    expect(cmp.commandDelta).toEqual([]);
    expect(cmp.evidenceDelta).toEqual([]);
  });
});
