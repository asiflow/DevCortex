// ============================================================================
// Agent Flight Recorder (§7.16) — implementation.
//
// Records an agent session as a directory under `.cortex/runs/`:
//
//   .cortex/runs/run-<ISO-ish>-<uuid8>/
//     record.json        <- the persisted RunRecord index (source of truth)
//     prompt.md          <- initial prompt
//     intent.md          <- compiled intent
//     context.md         <- context pack
//     plan.md            <- agent plan
//     toolcalls.jsonl    <- one JSON object per line (append-only)
//     commands.log       <- one command per line (append-only)
//     evidence.json      <- JSON array of attached evidence ids
//     ship-report.md     <- final ship report
//     learning.md        <- captured learning
//
// A run is `open` while it accepts artifacts and `closed` once sealed by
// `finishRun`; a sealed run rejects further writes (PolicyViolationError) so the
// on-disk record of what actually happened is immutable and replayable.
//
// Everything here is deterministic and tokenless (the OSS layer): no LLM calls,
// no network, real filesystem I/O only.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Dirent } from 'node:fs';

import {
  DevCortexError,
  PolicyViolationError,
  RunRecordSchema,
  SchemaValidationError,
} from '../domain';
import type { RunRecord } from '../domain';
import { workspacePaths } from '../workspace';

// --- on-disk layout ---------------------------------------------------------

/** Name of the persisted index file inside every run directory. */
const RECORD_FILE = 'record.json';

/** Prefix every run directory carries; used to filter foreign entries. */
const RUN_DIR_PREFIX = 'run-';

/** Fixed artifact file names inside a run directory. */
const FILES = {
  prompt: 'prompt.md',
  intent: 'intent.md',
  context: 'context.md',
  plan: 'plan.md',
  toolcalls: 'toolcalls.jsonl',
  commands: 'commands.log',
  evidence: 'evidence.json',
  shipReport: 'ship-report.md',
  learning: 'learning.md',
} as const;

// --- public types -----------------------------------------------------------

/**
 * The kind of artifact being recorded, keyed to the file it lands in:
 *  - `prompt` | `intent` | `context` | `plan` | `learning` | `ship-report`
 *    overwrite their markdown file (last write wins).
 *  - `toolcall` appends one JSON object to `toolcalls.jsonl`.
 *  - `command` appends one line to `commands.log`.
 */
export type ArtifactKey =
  | 'prompt'
  | 'intent'
  | 'context'
  | 'plan'
  | 'toolcall'
  | 'command'
  | 'ship-report'
  | 'learning';

/** Result of {@link compareRuns}. Deltas are order-independent symmetric diffs. */
export interface RunComparison {
  /** true when both runs recorded the same task string. */
  sameTask: boolean;
  /** commands present in exactly one of the two runs, sorted. */
  commandDelta: string[];
  /** evidence ids present in exactly one of the two runs, sorted. */
  evidenceDelta: string[];
}

// --- public API -------------------------------------------------------------

/**
 * Begin recording a run. Creates `.cortex/runs/<id>/` with a fresh `record.json`
 * and empty artifact files, and returns the open {@link RunRecord}.
 */
export async function startRun(root: string, task: string): Promise<RunRecord> {
  if (typeof task !== 'string' || task.trim().length === 0) {
    throw new SchemaValidationError('A run task description must be a non-empty string.');
  }

  const { runsDir } = workspacePaths(root);
  const createdAt = new Date().toISOString();
  const id = buildRunId(createdAt);
  const dir = path.join(runsDir, id);

  try {
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(path.join(dir, FILES.prompt), '', 'utf8'),
      writeFile(path.join(dir, FILES.intent), '', 'utf8'),
      writeFile(path.join(dir, FILES.context), '', 'utf8'),
      writeFile(path.join(dir, FILES.plan), '', 'utf8'),
      writeFile(path.join(dir, FILES.toolcalls), '', 'utf8'),
      writeFile(path.join(dir, FILES.commands), '', 'utf8'),
      // evidence.json is a real JSON document from the first byte, so a reader
      // never sees an empty (invalid) `.json` file.
      writeFile(path.join(dir, FILES.evidence), '[]\n', 'utf8'),
      writeFile(path.join(dir, FILES.shipReport), '', 'utf8'),
      writeFile(path.join(dir, FILES.learning), '', 'utf8'),
    ]);
  } catch (err) {
    throw new DevCortexError('INTERNAL', `Unable to create run directory at ${dir}.`, {
      cause: err,
    });
  }

  const record: RunRecord = {
    id,
    dir,
    task,
    createdAt,
    toolCalls: [],
    commands: [],
    evidenceIds: [],
    intentPresent: false,
    contextPresent: false,
    planPresent: false,
    status: 'open',
  };

  return persistRecord(record);
}

/**
 * Record one artifact into an open run. Overwrites the markdown files, appends
 * to the JSONL/log files, and keeps `record.json` in sync. Throws
 * {@link PolicyViolationError} if the run is already closed.
 */
export async function recordArtifact(
  root: string,
  runId: string,
  key: ArtifactKey,
  content: string,
): Promise<void> {
  if (typeof content !== 'string') {
    throw new SchemaValidationError('Artifact content must be a string.');
  }

  const record = await readRecord(root, runId);
  assertOpen(record, 'accept new artifacts');
  const dir = runDir(root, runId);

  switch (key) {
    case 'prompt':
      await writeFile(path.join(dir, FILES.prompt), content, 'utf8');
      record.prompt = content;
      break;
    case 'intent':
      await writeFile(path.join(dir, FILES.intent), content, 'utf8');
      record.intentPresent = true;
      break;
    case 'context':
      await writeFile(path.join(dir, FILES.context), content, 'utf8');
      record.contextPresent = true;
      break;
    case 'plan':
      await writeFile(path.join(dir, FILES.plan), content, 'utf8');
      record.planPresent = true;
      break;
    case 'toolcall': {
      const parsed = parseToolCall(content);
      // Re-serialize compactly so a payload with embedded newlines can never
      // split one tool call across multiple JSONL lines.
      await appendFile(path.join(dir, FILES.toolcalls), `${JSON.stringify(parsed)}\n`, 'utf8');
      record.toolCalls = [...record.toolCalls, parsed];
      break;
    }
    case 'command':
      await appendFile(path.join(dir, FILES.commands), `${content}\n`, 'utf8');
      record.commands = [...record.commands, content];
      break;
    case 'ship-report':
      await writeFile(path.join(dir, FILES.shipReport), content, 'utf8');
      record.shipReportPath = path.join(dir, FILES.shipReport);
      break;
    case 'learning':
      await writeFile(path.join(dir, FILES.learning), content, 'utf8');
      record.learning = content;
      break;
    default: {
      // Exhaustiveness guard: unreachable for valid ArtifactKey, but a JS caller
      // could still pass junk, so fail loud rather than silently drop it.
      const exhaustive: never = key;
      throw new SchemaValidationError(`Unknown run artifact key "${String(exhaustive)}".`);
    }
  }

  await persistRecord(record);
}

/**
 * Attach an evidence id to an open run. Deduplicates, rewrites `evidence.json`,
 * and keeps `record.json` authoritative. Throws {@link PolicyViolationError} if
 * the run is already closed.
 */
export async function attachEvidence(root: string, runId: string, evidenceId: string): Promise<void> {
  if (typeof evidenceId !== 'string' || evidenceId.length === 0) {
    throw new SchemaValidationError('An evidence id must be a non-empty string.');
  }

  const record = await readRecord(root, runId);
  assertOpen(record, 'accept new evidence');

  if (!record.evidenceIds.includes(evidenceId)) {
    record.evidenceIds = [...record.evidenceIds, evidenceId];
  }

  const dir = runDir(root, runId);
  await writeFile(
    path.join(dir, FILES.evidence),
    `${JSON.stringify(record.evidenceIds, null, 2)}\n`,
    'utf8',
  );
  await persistRecord(record);
}

/**
 * Seal a run: set status to `closed` and optionally record where the final ship
 * report lives. Idempotent — re-finishing a closed run is allowed and can update
 * `shipReportPath`.
 */
export async function finishRun(
  root: string,
  runId: string,
  shipReportPath?: string,
): Promise<RunRecord> {
  const record = await readRecord(root, runId);
  record.status = 'closed';
  if (shipReportPath !== undefined) {
    if (typeof shipReportPath !== 'string' || shipReportPath.length === 0) {
      throw new SchemaValidationError('shipReportPath must be a non-empty string when provided.');
    }
    record.shipReportPath = shipReportPath;
  }
  return persistRecord(record);
}

/** All recorded runs, sorted by `createdAt` (then id) ascending. */
export async function listRuns(root: string): Promise<RunRecord[]> {
  const { runsDir } = workspacePaths(root);

  let entries: Dirent[];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      // No runs directory yet => no runs. Not an error condition.
      return [];
    }
    throw new DevCortexError('INTERNAL', `Unable to list runs in ${runsDir}.`, { cause: err });
  }

  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_DIR_PREFIX)) {
      continue;
    }
    const file = path.join(runsDir, entry.name, RECORD_FILE);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // A run directory without a record.json is incomplete/foreign; skip it
        // rather than failing the whole listing.
        continue;
      }
      throw new DevCortexError('INTERNAL', `Unable to read run record at ${file}.`, { cause: err });
    }
    records.push(parseRecord(raw, file));
  }

  records.sort(compareByCreatedThenId);
  return records;
}

/** Load a single run by id. Throws {@link SchemaValidationError} if absent. */
export async function loadRun(root: string, runId: string): Promise<RunRecord> {
  return readRecord(root, runId);
}

/**
 * Compare two runs. `sameTask` reflects the task string; the deltas are the
 * order-independent symmetric differences of the two runs' commands and
 * evidence ids (i.e. entries present in exactly one of the runs), sorted.
 */
export async function compareRuns(root: string, a: string, b: string): Promise<RunComparison> {
  const [runA, runB] = await Promise.all([readRecord(root, a), readRecord(root, b)]);
  return {
    sameTask: runA.task === runB.task,
    commandDelta: symmetricDifference(runA.commands, runB.commands),
    evidenceDelta: symmetricDifference(runA.evidenceIds, runB.evidenceIds),
  };
}

// --- internals --------------------------------------------------------------

/** Build a sortable, filesystem-safe run id from an ISO timestamp. */
function buildRunId(iso: string): string {
  // 2026-07-01T09:04:05.123Z -> 2026-07-01-09-04-05-123
  const stamp = iso.replace(/[:.]/g, '-').replace('T', '-').replace(/Z$/, '');
  return `${RUN_DIR_PREFIX}${stamp}-${randomUUID().slice(0, 8)}`;
}

/** Resolve a run's directory, rejecting ids that could escape `runsDir`. */
function runDir(root: string, runId: string): string {
  assertSafeRunId(runId);
  return path.join(workspacePaths(root).runsDir, runId);
}

/** Reject empty or path-traversing run ids before they become path segments. */
function assertSafeRunId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new SchemaValidationError('A run id must be a non-empty string.');
  }
  if (id !== path.basename(id) || id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new SchemaValidationError(`The run id "${id}" is not a safe run id.`);
  }
}

/** Guard: a sealed run must not mutate. */
function assertOpen(record: RunRecord, action: string): void {
  if (record.status === 'closed') {
    throw new PolicyViolationError(`Run "${record.id}" is closed and cannot ${action}.`);
  }
}

/** Parse a toolcall payload, enforcing the JSON Lines invariant. */
function parseToolCall(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (err) {
    throw new SchemaValidationError(
      'A toolcall artifact must be a JSON-encoded string so toolcalls.jsonl stays valid JSON Lines.',
      { cause: err },
    );
  }
}

/**
 * Validate a fully-formed record and persist it atomically (temp file + rename
 * within the run directory), returning the schema-parsed value. `rename` is
 * atomic within a filesystem, so a concurrent reader or a crash mid-write never
 * observes a truncated `record.json`.
 */
async function persistRecord(record: RunRecord): Promise<RunRecord> {
  const result = RunRecordSchema.safeParse(record);
  if (!result.success) {
    throw new SchemaValidationError('Refusing to write an invalid run record.', {
      details: result.error.issues,
      cause: result.error,
    });
  }
  const validated = result.data;
  const file = path.join(validated.dir, RECORD_FILE);
  const tmp = path.join(validated.dir, `.${RECORD_FILE}.${randomUUID()}.tmp`);
  try {
    await mkdir(validated.dir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new DevCortexError('INTERNAL', `Unable to write run record to ${file}.`, { cause: err });
  }
  return validated;
}

/** Read + validate a run's `record.json`; throws when it does not exist. */
async function readRecord(root: string, runId: string): Promise<RunRecord> {
  const dir = runDir(root, runId);
  const file = path.join(dir, RECORD_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      throw new SchemaValidationError(`No recorded run exists with id "${runId}".`);
    }
    throw new DevCortexError('INTERNAL', `Unable to read run record at ${file}.`, { cause: err });
  }
  return parseRecord(raw, file);
}

/** Parse + schema-validate raw record JSON, mapping failure to a clear error. */
function parseRecord(raw: string, file: string): RunRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SchemaValidationError(`The run record at ${file} is not valid JSON.`, { cause: err });
  }
  const result = RunRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new SchemaValidationError(`The run record at ${file} failed schema validation.`, {
      details: result.error.issues,
      cause: result.error,
    });
  }
  return result.data;
}

/** Stable ordering for listRuns: by createdAt, then id, ascending. */
function compareByCreatedThenId(a: RunRecord, b: RunRecord): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/** Entries present in exactly one of the two arrays, deduped and sorted. */
function symmetricDifference(a: readonly string[], b: readonly string[]): string[] {
  const setA = new Set(a);
  const setB = new Set(b);
  const out = new Set<string>();
  for (const value of setA) {
    if (!setB.has(value)) {
      out.add(value);
    }
  }
  for (const value of setB) {
    if (!setA.has(value)) {
      out.add(value);
    }
  }
  return [...out].sort();
}

/** Narrow an unknown thrown value to a Node `errno` exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
