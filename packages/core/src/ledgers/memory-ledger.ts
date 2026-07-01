/**
 * MemoryLedger — durable store of facts, decisions, risks, assumptions,
 * constraints and patterns the project has learned. Memory items carry a
 * `confidence` and `evidence` refs so unverified memory is never silently
 * promoted to permanent truth (see `domain/types.ts`).
 */
import { randomUUID } from 'node:crypto';

import type { MemoryItem } from '../domain/index';
import { MemoryItemSchema } from '../domain/index';
// The workspace barrel re-export is still being assembled by the workspace
// agent; import the stable `paths` subfile directly for `workspacePaths`.
import { workspacePaths } from '../workspace/paths';

import { JsonLedger } from './json-ledger';

/** Fields a caller supplies to {@link MemoryLedger.add}; ids/timestamps are generated. */
export type MemoryInput = Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>;

/** Mutable fields accepted by {@link MemoryLedger.update}. */
export type MemoryPatch = Partial<MemoryInput>;

export class MemoryLedger extends JsonLedger<MemoryItem> {
  constructor(root: string) {
    super(root, workspacePaths(root).memoryDir, MemoryItemSchema, 'memory');
  }

  async add(input: MemoryInput): Promise<MemoryItem> {
    const now = new Date().toISOString();
    const record: MemoryItem = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    return this.persist(record);
  }

  async update(id: string, patch: MemoryPatch): Promise<MemoryItem> {
    const existing = await this.loadRequired(id);
    const updated: MemoryItem = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    return this.persist(updated);
  }
}
