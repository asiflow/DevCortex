/**
 * Tests for `parseTranscript` and `distillTranscript` — the session transcript
 * distiller (§WS-1). TDD: parser tests come first (pure, no I/O), then the
 * async distill tests which need a fresh mkdtemp workspace.
 *
 * Fixture idiom mirrors `ledgers.test.ts` and `brief.test.ts`:
 *   mkdtemp root per test (beforeEach / afterEach).
 *   __fixtures__/transcript-basic.jsonl is authored verbatim per the task
 *   brief and read from disk so the distillTranscript test exercises the full
 *   readFile path.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryLedger } from '../ledgers/index';
import { listRuns } from './index';
import { distillTranscript, parseTranscript } from './distill';

// --- fixture path ------------------------------------------------------------

const FIXTURE_JSONL = fileURLToPath(
  new URL('./__fixtures__/transcript-basic.jsonl', import.meta.url),
);

// --- workspace for distillTranscript tests -----------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-distill-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// =============================================================================
// parseTranscript — pure function, no I/O
// =============================================================================

describe('parseTranscript', () => {
  it('returns all-empty digest for empty string', () => {
    const d = parseTranscript('');
    expect(d.commands).toEqual([]);
    expect(d.filesEdited).toEqual([]);
    expect(d.errors).toEqual([]);
    expect(d.recoveredCommands).toEqual([]);
  });

  it('returns all-empty digest for whitespace-only string', () => {
    const d = parseTranscript('   \n\n   ');
    expect(d.commands).toEqual([]);
    expect(d.filesEdited).toEqual([]);
    expect(d.errors).toEqual([]);
    expect(d.recoveredCommands).toEqual([]);
  });

  describe('transcript-basic.jsonl fixture', () => {
    let jsonl: string;

    beforeEach(async () => {
      jsonl = await readFile(FIXTURE_JSONL, 'utf8');
    });

    it('collects both npm test invocations in order', () => {
      const d = parseTranscript(jsonl);
      expect(d.commands).toEqual([
        'npm test -- date.test.ts',
        'npm test -- date.test.ts',
      ]);
    });

    it('collects the unique edited file path', () => {
      const d = parseTranscript(jsonl);
      expect(d.filesEdited).toEqual(['/repo/src/date.ts']);
    });

    it('collects one error excerpt containing "FAIL date.test.ts", paired to the command', () => {
      const d = parseTranscript(jsonl);
      expect(d.errors).toHaveLength(1);
      expect(d.errors[0]?.excerpt).toContain('FAIL date.test.ts');
      expect(d.errors[0]?.command).toBe('npm test -- date.test.ts');
    });

    it('identifies the recovered command', () => {
      const d = parseTranscript(jsonl);
      expect(d.recoveredCommands).toEqual(['npm test -- date.test.ts']);
    });

    it('silently ignores the garbage line (no extra commands or files)', () => {
      const d = parseTranscript(jsonl);
      // 2 Bash tool_use + 1 Edit tool_use + 1 tool_result-error + 1 text item
      // Garbage line must not inflate any of these.
      expect(d.commands).toHaveLength(2);
      expect(d.filesEdited).toHaveLength(1);
      expect(d.errors).toHaveLength(1);
    });
  });

  it('skips lines with invalid JSON silently', () => {
    const broken = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"echo hi"}}]}}',
      'NOT JSON AT ALL',
      '{"garbage":true}',
    ].join('\n');
    const d = parseTranscript(broken);
    expect(d.commands).toEqual(['echo hi']);
    expect(d.errors).toEqual([]);
  });

  it('deduplicates edited file paths', () => {
    const twoEdits = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"/a.ts","old_string":"x","new_string":"y"}}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"e2","name":"Write","input":{"file_path":"/a.ts","content":"z"}}]}}',
    ].join('\n');
    const d = parseTranscript(twoEdits);
    expect(d.filesEdited).toEqual(['/a.ts']); // deduplicated
  });

  it('truncates error excerpts to 200 chars', () => {
    const longMsg = 'X'.repeat(300);
    const withLongErr = [
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"run"}}]}}`,
      `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"${longMsg}","is_error":true}]}}`,
    ].join('\n');
    const d = parseTranscript(withLongErr);
    expect(d.errors[0]?.excerpt).toHaveLength(200);
  });
});

// =============================================================================
// distillTranscript — async, real filesystem
// =============================================================================

describe('distillTranscript', () => {
  it('resolves {runId: null, memoryCandidates: 0} for a missing transcript path — never throws', async () => {
    await expect(
      distillTranscript(root, '/nonexistent/__no_such_transcript__.jsonl'),
    ).resolves.toEqual({ runId: null, memoryCandidates: 0 });
  });

  it('resolves {runId: null, memoryCandidates: 0} for empty/whitespace-only content', async () => {
    // Write an empty file into the tmp workspace to exercise the empty-digest branch.
    const { writeFile } = await import('node:fs/promises');
    const emptyPath = path.join(root, 'empty.jsonl');
    await writeFile(emptyPath, '  \n  ', 'utf8');
    await expect(distillTranscript(root, emptyPath)).resolves.toEqual({
      runId: null,
      memoryCandidates: 0,
    });
  });

  it('creates a run record and one memory item on first call', async () => {
    const outcome = await distillTranscript(root, FIXTURE_JSONL);

    // Run was created.
    expect(outcome.runId).not.toBeNull();
    expect(outcome.memoryCandidates).toBe(1);

    // listRuns includes the run.
    const runs = await listRuns(root);
    const match = runs.find((r) => r.id === outcome.runId);
    expect(match).toBeDefined();
    expect(match!.task).toMatch(/^agent session/);
    expect(match!.status).toBe('closed');
  });

  it('writes a memory item with correct observed:transcript fields', async () => {
    await distillTranscript(root, FIXTURE_JSONL);

    const ledger = new MemoryLedger(root);
    const items = await ledger.list((m) => m.source === 'observed:transcript');
    expect(items).toHaveLength(1);

    const mem = items[0]!;
    expect(mem.type).toBe('risk');
    expect(mem.riskLevel).toBe('medium');
    expect(mem.confidence).toBe(0.9);
    expect(mem.title).toContain('npm test -- date.test.ts');
    expect(mem.title).toMatch(/^Command failed during session then passed:/);
    expect(mem.summary).toContain('FAIL date.test.ts');
  });

  it('deduplicates on second call — memoryCandidates: 0, runId still created', async () => {
    // First call writes the memory item.
    const first = await distillTranscript(root, FIXTURE_JSONL);
    expect(first.memoryCandidates).toBe(1);

    // Second call sees same titles → skips writing.
    const second = await distillTranscript(root, FIXTURE_JSONL);
    expect(second.memoryCandidates).toBe(0);
    // But the run was still created (transcript has observable activity).
    expect(second.runId).not.toBeNull();

    // Exactly 1 memory item total across both calls.
    const ledger = new MemoryLedger(root);
    const all = await ledger.list((m) => m.source === 'observed:transcript');
    expect(all).toHaveLength(1);
  });
});
