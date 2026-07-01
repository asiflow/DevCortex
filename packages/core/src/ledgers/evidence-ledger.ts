/**
 * EvidenceLedger — append-only record of verification results (build/test/lint/
 * route/file/symbol/import/command/env checks). Evidence is the spine of the
 * "evidence over opinions" philosophy: once recorded it is immutable, so there
 * is deliberately no `update`. Corrections are expressed by appending a new,
 * fresher EvidenceItem rather than rewriting history.
 */
import { randomUUID } from 'node:crypto';

import type { EvidenceItem } from '../domain/index';
import { EvidenceItemSchema } from '../domain/index';
// The workspace barrel re-export is still being assembled by the workspace
// agent; import the stable `paths` subfile directly for `workspacePaths`.
import { workspacePaths } from '../workspace/paths';

import { JsonLedger } from './json-ledger';

/** Fields a caller supplies to {@link EvidenceLedger.add}; id/`createdAt` are generated. */
export type EvidenceInput = Omit<EvidenceItem, 'id' | 'createdAt'>;

export class EvidenceLedger extends JsonLedger<EvidenceItem> {
  constructor(root: string) {
    super(root, workspacePaths(root).evidenceDir, EvidenceItemSchema, 'evidence');
  }

  async add(input: EvidenceInput): Promise<EvidenceItem> {
    const record: EvidenceItem = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    return this.persist(record);
  }

  // Intentionally no `update`: the evidence ledger is append-only.
}
