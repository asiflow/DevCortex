/**
 * `blockUnprovenDone` — the gate that stops "done" from being claimed without
 * proof. A ship report is blocked when its status is NOT_READY, when it carries
 * failed required checks, or when it has no recorded evidence at all (an
 * unproven "done"). Every block carries human-readable reasons so a host hook
 * can explain *why* it blocked, per the "never block without explanation" rule.
 */

import { EvidenceError } from '../domain/index';
import type { ShipReport } from '../domain/index';

export interface BlockDecision {
  blocked: boolean;
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Decide whether work may be marked done given a `ShipReport`. Returns the
 * decision plus the reasons; throws `EvidenceError` only when the report itself
 * is structurally invalid (an internal failure, not a negative result).
 */
export function blockUnprovenDone(report: ShipReport): BlockDecision {
  if (!isRecord(report)) {
    throw new EvidenceError('blockUnprovenDone requires a ShipReport object');
  }

  const status = report.status;
  if (status !== 'READY' && status !== 'READY_WITH_WARNINGS' && status !== 'NOT_READY') {
    throw new EvidenceError(`ShipReport.status is invalid: ${String(status)}`);
  }

  const blockedChecks = Array.isArray(report.blocked) ? report.blocked : [];
  const evidenceIds = Array.isArray(report.evidenceIds) ? report.evidenceIds : [];
  const reasons: string[] = [];

  if (status === 'NOT_READY') {
    reasons.push(
      'Ship status is NOT_READY — required checks have not all passed, so work cannot be marked done.',
    );
  }

  for (const check of blockedChecks) {
    const name = isRecord(check) && typeof check.name === 'string' ? check.name : 'unknown check';
    const detail =
      isRecord(check) && typeof check.detail === 'string' && check.detail.length > 0
        ? ` — ${check.detail}`
        : '';
    reasons.push(`Required check failed: ${name}${detail}`);
  }

  if (evidenceIds.length === 0) {
    reasons.push(
      'No evidence was recorded — "done" cannot be proven without at least one verified evidence item.',
    );
  }

  return { blocked: reasons.length > 0, reasons };
}
