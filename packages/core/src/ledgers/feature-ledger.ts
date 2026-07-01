/**
 * FeatureLedger — the catalogue of features the project has built or plans to:
 * their purpose, surfaces (routes/components/api/tables/env), protected
 * behaviors, acceptance criteria, evidence and regression checks. This is the
 * source of truth blast-radius and ship reports reason about.
 */
import { randomUUID } from 'node:crypto';

import type { FeatureRecord } from '../domain/index';
import { FeatureRecordSchema } from '../domain/index';
// The workspace barrel re-export is still being assembled by the workspace
// agent; import the stable `paths` subfile directly for `workspacePaths`.
import { workspacePaths } from '../workspace/paths';

import { JsonLedger } from './json-ledger';

/** Fields a caller supplies to {@link FeatureLedger.add}; id/`updatedAt` are generated. */
export type FeatureInput = Omit<FeatureRecord, 'id' | 'updatedAt'>;

/** Mutable fields accepted by {@link FeatureLedger.update}. */
export type FeaturePatch = Partial<FeatureInput>;

export class FeatureLedger extends JsonLedger<FeatureRecord> {
  constructor(root: string) {
    super(root, workspacePaths(root).featuresDir, FeatureRecordSchema, 'feature');
  }

  async add(input: FeatureInput): Promise<FeatureRecord> {
    const record: FeatureRecord = {
      ...input,
      id: randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    return this.persist(record);
  }

  async update(id: string, patch: FeaturePatch): Promise<FeatureRecord> {
    const existing = await this.loadRequired(id);
    const updated: FeatureRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };
    return this.persist(updated);
  }
}
