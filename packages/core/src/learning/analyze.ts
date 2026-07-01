// ============================================================================
// analyzeFailures (§7.17) — observe repeated failures across the evidence ledger
// and the flight recorder, cluster them by signature, and count occurrences.
//
// Two evidence-grounded sources feed the analysis:
//   1. the EvidenceLedger — every recorded *refuted* check (a real, observed
//      failure). Recurring refuted evidence is the primary signal.
//   2. the flight recorder (../runs) — how many *distinct runs* each signature
//      failed in, so a failure that spans multiple sessions surfaces even if the
//      ledger only holds a couple of entries.
//
// A signature is considered a learned failure when it recurs at least
// `minOccurrences` times in the ledger OR spans that many distinct runs. Nothing
// is ever invented: only refuted evidence produces a signature, and the count is
// the observed count. Deterministic and tokenless (the OSS layer).
// ============================================================================

import { SchemaValidationError } from '../domain/index';
import type { LearnedFailure } from '../domain/index';
import { EvidenceLedger } from '../ledgers/index';
import { listRuns } from '../runs/index';

import { diagnoseSignature, remedyForCategory } from './diagnose';
import { evidenceSignature, failureId } from './signature';

/** Options for {@link analyzeFailures}. */
export interface AnalyzeOptions {
  /**
   * Minimum recurrence for a signature to count as a learned failure — the
   * number of refuted-evidence observations OR the number of distinct runs it
   * failed in. Must be a positive integer. Defaults to 2 ("repeated").
   */
  minOccurrences?: number;
}

const DEFAULT_MIN_OCCURRENCES = 2;

/** One signature's accumulated observations. */
interface Cluster {
  /** count of refuted evidence items carrying this signature. */
  evidenceCount: number;
  /** ids of the refuted evidence items, used to compute run spread. */
  evidenceIds: Set<string>;
  /** distinct run ids that referenced any of this signature's evidence. */
  runIds: Set<string>;
}

/**
 * Scan the evidence ledger and flight recorder for repeated failure signatures.
 * Returns one {@link LearnedFailure} per recurring signature (unpersisted
 * candidates), sorted most-recurring first.
 */
export async function analyzeFailures(
  root: string,
  options: AnalyzeOptions = {},
): Promise<LearnedFailure[]> {
  const min = normalizeThreshold(options.minOccurrences);

  const [items, runs] = await Promise.all([new EvidenceLedger(root).all(), listRuns(root)]);

  // Only refuted evidence is a real, observed failure — never invent one.
  const clusters = new Map<string, Cluster>();
  const signatureByEvidenceId = new Map<string, string>();
  for (const item of items) {
    if (item.status !== 'refuted') {
      continue;
    }
    const signature = evidenceSignature(item);
    const cluster = clusters.get(signature) ?? {
      evidenceCount: 0,
      evidenceIds: new Set<string>(),
      runIds: new Set<string>(),
    };
    cluster.evidenceCount += 1;
    cluster.evidenceIds.add(item.id);
    clusters.set(signature, cluster);
    signatureByEvidenceId.set(item.id, signature);
  }

  // Attribute run spread: how many distinct runs referenced each signature.
  for (const run of runs) {
    for (const evidenceId of run.evidenceIds) {
      const signature = signatureByEvidenceId.get(evidenceId);
      if (signature === undefined) {
        continue;
      }
      // Guaranteed present: the signature came from a cluster we just built.
      clusters.get(signature)?.runIds.add(run.id);
    }
  }

  const now = new Date().toISOString();
  const learned: LearnedFailure[] = [];
  for (const [signature, cluster] of clusters) {
    const runSpread = cluster.runIds.size;
    if (cluster.evidenceCount < min && runSpread < min) {
      continue;
    }
    const diagnosis = diagnoseSignature(signature);
    learned.push({
      id: failureId(signature),
      signature,
      occurrences: Math.max(cluster.evidenceCount, runSpread),
      diagnosis,
      remedyKind: remedyForCategory(diagnosis.category),
      createdAt: now,
      updatedAt: now,
    });
  }

  learned.sort(byOccurrencesThenSignature);
  return learned;
}

function byOccurrencesThenSignature(a: LearnedFailure, b: LearnedFailure): number {
  if (a.occurrences !== b.occurrences) {
    return b.occurrences - a.occurrences;
  }
  if (a.signature === b.signature) {
    return 0;
  }
  return a.signature < b.signature ? -1 : 1;
}

function normalizeThreshold(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MIN_OCCURRENCES;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new SchemaValidationError('analyzeFailures minOccurrences must be a positive integer.', {
      details: { minOccurrences: value },
    });
  }
  return value;
}
