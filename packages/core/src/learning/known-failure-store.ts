// ============================================================================
// KnownFailureStore (§7.17) — file-backed persistence for learned failures under
// `.cortex/known-failures/<id>.json`.
//
// Reuses the shared JsonLedger base (from ../ledgers) so a learned failure gets
// the exact same durability guarantees as every other `.cortex/` artifact:
// writes are atomic (temp file + rename in the same directory), every read is
// re-validated against the domain LearnedFailureSchema (a corrupt or hand-edited
// file surfaces as a LedgerError instead of silently poisoning recommendations),
// and unsafe ids are rejected before they become file names.
//
// `paths.ts` owns the canonical `.cortex/` layout but predates the learning
// engine and has no `knownFailuresDir`, so the directory is derived from the
// exposed `cortexDir` — one join, no duplication of the layout knowledge
// (mirrors how the skill store derives `skillsDir`).
// ============================================================================

import path from 'node:path';

import { LearnedFailureSchema } from '../domain/index';
import type { LearnedFailure } from '../domain/index';
import { JsonLedger } from '../ledgers/index';
import { workspacePaths } from '../workspace/index';

/** Absolute path of the `.cortex/known-failures` directory for a repo root. */
export function knownFailuresDir(root: string): string {
  return path.join(workspacePaths(root).cortexDir, 'known-failures');
}

/** Absolute path of the persisted record file for one learned failure id. */
export function knownFailureFile(root: string, id: string): string {
  return path.join(knownFailuresDir(root), `${id}.json`);
}

/**
 * Project-scoped store of learned failures, keyed by their content-addressed id
 * (see `failureId`). Self-initializes its backing directory on the first write,
 * so it works on a repo that has not yet run `devcortex init`.
 */
export class KnownFailureStore extends JsonLedger<LearnedFailure> {
  constructor(root: string) {
    super(root, knownFailuresDir(root), LearnedFailureSchema, 'known-failure');
  }

  /**
   * Validate `failure` against the disk contract and persist it atomically,
   * overwriting any existing record with the same id. Returns the schema-parsed
   * value actually written.
   */
  async save(failure: LearnedFailure): Promise<LearnedFailure> {
    return this.persist(failure);
  }
}

/** All persisted learned failures, most-recurring first (then signature asc). */
export async function knownFailures(root: string): Promise<LearnedFailure[]> {
  const records = await new KnownFailureStore(root).all();
  records.sort(byOccurrencesThenSignature);
  return records;
}

/** Stable ordering: most occurrences first, ties broken by signature ascending. */
export function byOccurrencesThenSignature(a: LearnedFailure, b: LearnedFailure): number {
  if (a.occurrences !== b.occurrences) {
    return b.occurrences - a.occurrences;
  }
  if (a.signature === b.signature) {
    return 0;
  }
  return a.signature < b.signature ? -1 : 1;
}
