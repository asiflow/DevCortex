// ============================================================================
// Failure signatures (§7.17) — the deterministic keys the learning engine
// clusters on.
//
// A *signature* is a stable, matchable string derived purely from an observed,
// refuted `EvidenceItem`: the check kind plus the failing command + exit code
// (preferred) or the normalized claim. Identical failures — the same command
// failing with the same exit code across many runs — collapse to one key, which
// is what makes "this happened N times" countable without ever inventing a
// failure. Everything here is pure and tokenless (the OSS layer).
// ============================================================================

import { createHash } from 'node:crypto';

import type { EvidenceItem } from '../domain/index';

/** Collapse internal whitespace runs to a single space and trim the ends. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic, stable, matchable signature for one refuted evidence item.
 *
 * Format (chosen so the raw failing command stays human-readable in the key):
 *  - with a command: `<kind>:cmd=<normalized command>#exit=<code|NA>`
 *  - otherwise:      `<kind>:claim=<normalized claim>`
 */
export function evidenceSignature(item: EvidenceItem): string {
  const command = typeof item.command === 'string' ? normalizeText(item.command) : '';
  if (command.length > 0) {
    const exit = typeof item.exitCode === 'number' ? String(item.exitCode) : 'NA';
    return `${item.kind}:cmd=${command}#exit=${exit}`;
  }
  return `${item.kind}:claim=${normalizeText(item.claim)}`;
}

/**
 * Stable content-addressed id for a signature — a single safe path segment, so
 * the learned failure lands at `.cortex/known-failures/<id>.json` and re-learning
 * the same signature overwrites rather than duplicates.
 */
export function failureId(signature: string): string {
  const digest = createHash('sha256').update(signature).digest('hex').slice(0, 12);
  return `failure-${digest}`;
}

/**
 * Lowercased alphanumeric keyword tokens (runs of length >= `min`) drawn from a
 * signature, deduped and order-preserving. Used to seed skill triggers and drive
 * the deterministic diagnosis keyword rules.
 */
export function signatureTokens(signature: string, min = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of signature.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= min && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}
