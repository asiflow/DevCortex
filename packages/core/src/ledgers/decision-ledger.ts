/**
 * DecisionLedger — lightweight Architecture Decision Records: the decision, its
 * context, the options weighed, what was chosen and why, tradeoffs accepted and
 * the files it governs. `date` records when the decision was taken (defaulting
 * to now) and is immutable thereafter; `status` tracks proposed/accepted/superseded.
 */
import { randomUUID } from 'node:crypto';

import type { DecisionRecord } from '../domain/index';
import { DecisionRecordSchema } from '../domain/index';
// The workspace barrel re-export is still being assembled by the workspace
// agent; import the stable `paths` subfile directly for `workspacePaths`.
import { workspacePaths } from '../workspace/paths';

import { JsonLedger } from './json-ledger';

/**
 * Fields a caller supplies to {@link DecisionLedger.add}; `id` is generated and
 * `date` defaults to the current ISO timestamp when omitted.
 */
export type DecisionInput = Omit<DecisionRecord, 'id' | 'date'> & { date?: string };

/** Mutable fields accepted by {@link DecisionLedger.update}; `date` is immutable. */
export type DecisionPatch = Partial<Omit<DecisionRecord, 'id' | 'date'>>;

export class DecisionLedger extends JsonLedger<DecisionRecord> {
  constructor(root: string) {
    super(root, workspacePaths(root).decisionsDir, DecisionRecordSchema, 'decision');
  }

  async add(input: DecisionInput): Promise<DecisionRecord> {
    const { date, ...rest } = input;
    const record: DecisionRecord = {
      ...rest,
      id: randomUUID(),
      date: date ?? new Date().toISOString(),
    };
    return this.persist(record);
  }

  async update(id: string, patch: DecisionPatch): Promise<DecisionRecord> {
    const existing = await this.loadRequired(id);
    const updated: DecisionRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      date: existing.date,
    };
    return this.persist(updated);
  }
}
