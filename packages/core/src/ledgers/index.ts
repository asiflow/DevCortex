/**
 * Ledgers — file-backed, schema-validated CRUD for the project brain. Each
 * ledger is constructed with the repo root and persists one `<id>.json` file
 * per entry under the matching `.cortex/` subdirectory.
 *
 * Public API (Wave 1):
 *   class MemoryLedger   — add/get/list/update/all over MemoryItem
 *   class FeatureLedger  — add/get/list/update/all over FeatureRecord
 *   class DecisionLedger — add/get/list/update/all over DecisionRecord
 *   class EvidenceLedger — add/get/list/all over EvidenceItem (append-only)
 *
 * Invariant: memory items carry confidence + evidence; unverified memory is
 * never silently promoted to permanent truth. Every read is re-validated with
 * the owning zod schema; corruption surfaces as a LedgerError.
 */
export { JsonLedger } from './json-ledger';

export { MemoryLedger } from './memory-ledger';
export type { MemoryInput, MemoryPatch } from './memory-ledger';

export { FeatureLedger } from './feature-ledger';
export type { FeatureInput, FeaturePatch } from './feature-ledger';

export { DecisionLedger } from './decision-ledger';
export type { DecisionInput, DecisionPatch } from './decision-ledger';

export { EvidenceLedger } from './evidence-ledger';
export type { EvidenceInput } from './evidence-ledger';
