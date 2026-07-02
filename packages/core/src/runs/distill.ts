// ============================================================================
// Transcript distiller (§WS-1) — deterministic parser + memory extractor.
//
// parseTranscript:   pure function; line-by-line, silently skips any line
//                    that fails JSON.parse or has an unknown shape (transcript
//                    formats drift across host versions).  Builds a
//                    TranscriptDigest of commands, edited files, error excerpts,
//                    and recovered commands via a single pass + a second pass
//                    for recovery detection.
//
// distillTranscript: async wrapper that persists a run record and writes up
//                    to 3 "observed:transcript" MemoryItems per session.
//
//   Fail-open contract (called from a Claude Code Stop hook):
//     Any read error, missing file, or empty digest resolves
//     { runId: null, memoryCandidates: 0 } — this function NEVER throws.
// ============================================================================

import { readFile } from 'node:fs/promises';

import type { MemoryInput } from '../ledgers/index';
import { MemoryLedger } from '../ledgers/index';
import { finishRun, recordArtifact, startRun } from './runs';

// --- exported types ----------------------------------------------------------

/**
 * Structured summary of an agent session transcript.
 * Produced by {@link parseTranscript}; consumed by {@link distillTranscript}
 * and Task 5's Stop hook.
 */
export interface TranscriptDigest {
  /** every Bash command observed, in order */
  commands: string[];
  /** unique absolute paths touched by Edit / Write / MultiEdit / NotebookEdit */
  filesEdited: string[];
  /** error excerpts (≤ 200 chars each) from is_error tool results, paired to a command where known */
  errors: Array<{ excerpt: string; command?: string }>;
  /** commands that failed at least once and later succeeded verbatim */
  recoveredCommands: string[];
}

/**
 * Result of a single {@link distillTranscript} pass.
 * Task 5 depends on these exact field names.
 */
export interface DistillOutcome {
  /** null when the transcript had no observable activity */
  runId: string | null;
  /** items actually written this pass (post-dedup, ≤ 3) */
  memoryCandidates: number;
}

// --- constants ---------------------------------------------------------------

/** Tool names that carry `input.file_path` and represent edits. */
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Maximum byte length of an error excerpt written to memory. */
const MAX_EXCERPT = 200;

/** Maximum recovered-command entries written per transcript (spec WS-1 §memory). */
const MAX_MEMORY_CANDIDATES = 3;

/** Prefix length of the command string included in the memory item title. */
const TITLE_CMD_MAX = 80;

/** Provenance tag for all memory items this module writes. */
const MEMORY_SOURCE = 'observed:transcript' as const;

// --- type guards (narrow unknown values safely) ------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

// --- parseTranscript ---------------------------------------------------------

/**
 * Parse a Claude Code JSONL session transcript into a {@link TranscriptDigest}.
 *
 * Version-tolerant: lines that fail `JSON.parse` or have an unknown shape are
 * silently skipped.  Uses a single pass with a `tool_use_id → command` Map for
 * error pairing, followed by a second pass over the execution log for recovery
 * detection.
 *
 * @param jsonl - Raw content of a Claude Code `.jsonl` session transcript.
 */
export function parseTranscript(jsonl: string): TranscriptDigest {
  const empty: TranscriptDigest = {
    commands: [],
    filesEdited: [],
    errors: [],
    recoveredCommands: [],
  };

  if (!jsonl.trim()) return empty;

  /** All Bash commands in transcript order. */
  const commands: string[] = [];
  /** Unique file paths touched by edit-family tools. */
  const filesEditedSet = new Set<string>();
  /** tool_use_id → Bash command string (for error pairing). */
  const commandById = new Map<string, string>();
  /** Ordered list of every Bash invocation (needed for second-pass recovery). */
  const executionLog: Array<{ command: string; toolUseId: string }> = [];
  /** tool_use_ids whose result carried is_error: true. */
  const errorTuIds = new Set<string>();
  /** Raw error records — re-used in second pass. */
  const rawErrors: Array<{ excerpt: string; toolUseId: string }> = [];

  // ---- first pass -----------------------------------------------------------
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // spec: silently skip lines that fail JSON.parse
    }

    if (!isObject(parsed)) continue;

    const msg = parsed['message'];
    if (!isObject(msg)) continue;

    const content = msg['content'];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isObject(block)) continue;

      const btype = block['type'];

      if (btype === 'tool_use') {
        const id = block['id'];
        const name = block['name'];
        const input = block['input'];
        if (!isStr(id) || !isStr(name) || !isObject(input)) continue;

        if (name === 'Bash') {
          const cmd = input['command'];
          if (isStr(cmd)) {
            commands.push(cmd);
            commandById.set(id, cmd);
            executionLog.push({ command: cmd, toolUseId: id });
          }
        } else if (EDIT_TOOL_NAMES.has(name)) {
          const fp = input['file_path'];
          if (isStr(fp)) {
            filesEditedSet.add(fp);
          }
        }
      } else if (btype === 'tool_result') {
        if (block['is_error'] !== true) continue;

        const tuid = block['tool_use_id'];
        if (!isStr(tuid)) continue;

        const raw = block['content'];
        let excerpt = '';
        if (isStr(raw)) {
          excerpt = raw.slice(0, MAX_EXCERPT);
        } else if (Array.isArray(raw)) {
          const parts: string[] = [];
          for (const part of raw) {
            if (isObject(part) && part['type'] === 'text' && isStr(part['text'])) {
              parts.push(part['text'] as string);
            }
          }
          excerpt = parts.join('').slice(0, MAX_EXCERPT);
        }

        rawErrors.push({ excerpt, toolUseId: tuid });
        errorTuIds.add(tuid);
      }
    }
  }

  // Pair errors with commands using the id map.
  const errors: TranscriptDigest['errors'] = rawErrors.map((e) => {
    const command = commandById.get(e.toolUseId);
    return command !== undefined ? { excerpt: e.excerpt, command } : { excerpt: e.excerpt };
  });

  // ---- second pass: recovery detection -------------------------------------
  // A command is "recovered" when:
  //   1. It had ≥ 1 is_error result, AND
  //   2. The identical command string ran again after that failure without a
  //      subsequent is_error result on that later execution.
  const recoveredSet = new Set<string>();

  for (const rawErr of rawErrors) {
    const command = commandById.get(rawErr.toolUseId);
    if (command === undefined) continue;

    const failIdx = executionLog.findIndex((e) => e.toolUseId === rawErr.toolUseId);
    if (failIdx === -1) continue;

    for (let i = failIdx + 1; i < executionLog.length; i++) {
      const later = executionLog[i];
      if (later !== undefined && later.command === command && !errorTuIds.has(later.toolUseId)) {
        recoveredSet.add(command);
        break;
      }
    }
  }

  return {
    commands,
    filesEdited: [...filesEditedSet],
    errors,
    recoveredCommands: [...recoveredSet],
  };
}

// --- distillTranscript -------------------------------------------------------

/**
 * Read a Claude Code session transcript from `transcriptPath`, distill it into
 * a {@link TranscriptDigest}, persist a run record, and write up to
 * {@link MAX_MEMORY_CANDIDATES} `"observed:transcript"` MemoryItems for
 * recovered commands (deduped by title across all existing memory).
 *
 * Fail-open: any filesystem error, missing file, or empty digest resolves to
 * `{ runId: null, memoryCandidates: 0 }` — this function NEVER throws.
 *
 * @param root           - Repo root that owns the `.cortex/` workspace.
 * @param transcriptPath - Absolute path of the Claude Code JSONL transcript.
 */
export async function distillTranscript(
  root: string,
  transcriptPath: string,
): Promise<DistillOutcome> {
  // Fail-open: any read error → null outcome (Stop hooks must not crash).
  let jsonl: string;
  try {
    jsonl = await readFile(transcriptPath, 'utf8');
  } catch {
    return { runId: null, memoryCandidates: 0 };
  }

  const digest = parseTranscript(jsonl);

  // Empty digest (no observable tool activity) → null outcome.
  if (digest.commands.length === 0 && digest.filesEdited.length === 0) {
    return { runId: null, memoryCandidates: 0 };
  }

  // Persist a closed run record; store the digest as the session learning.
  const run = await startRun(root, 'agent session (distilled from transcript)');
  await recordArtifact(root, run.id, 'learning', JSON.stringify(digest, null, 2));
  await finishRun(root, run.id);

  // Apply the memory rule: for each recoveredCommand (≤ 3), write one risk item.
  const ledger = new MemoryLedger(root);
  const existing = await ledger.list();
  const knownTitles = new Set(existing.map((m) => m.title));

  let memoryCandidates = 0;
  const capped = digest.recoveredCommands.slice(0, MAX_MEMORY_CANDIDATES);

  for (const cmd of capped) {
    const title = `Command failed during session then passed: ${cmd.slice(0, TITLE_CMD_MAX)}`;

    // Dedup: skip when an existing item has the identical title.
    if (knownTitles.has(title)) continue;

    const errorEntry = digest.errors.find((e) => e.command === cmd);
    const summary = errorEntry?.excerpt
      ? `Command eventually succeeded after failing with: ${errorEntry.excerpt}`
      : 'Command eventually succeeded after failing.';

    const input: MemoryInput = {
      type: 'risk',
      title,
      summary,
      source: MEMORY_SOURCE,
      confidence: 0.9,
      evidence: [],
      relatedFiles: [],
      relatedFeatures: [],
      riskLevel: 'medium',
    };

    await ledger.add(input);
    knownTitles.add(title); // guard further iterations in the same pass
    memoryCandidates++;
  }

  return { runId: run.id, memoryCandidates };
}
