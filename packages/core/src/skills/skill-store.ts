// ============================================================================
// SkillStore — file-backed persistence for project skills under
// `.cortex/skills/<id>.json`.
//
// Reuses the shared JsonLedger base (from ../ledgers) so project skills get the
// exact same durability guarantees as every other `.cortex/` artifact: writes
// are atomic (temp file + rename in the same directory), every read is
// re-validated against the domain SkillManifestSchema (a corrupt or hand-edited
// file surfaces as a LedgerError instead of silently poisoning recommendations),
// and unsafe ids are rejected before they become file names.
//
// `paths.ts` owns the canonical `.cortex/` layout but predates the skill engine
// and has no `skillsDir`, so the directory is derived from the exposed
// `cortexDir` — one join, no duplication of the layout knowledge.
// ============================================================================

import path from 'node:path';

import { SkillManifestSchema } from '../domain/index';
import type { SkillManifest } from '../domain/index';
import { JsonLedger } from '../ledgers/index';
import { workspacePaths } from '../workspace/index';

/** Absolute path of the `.cortex/skills` directory for a repo root. */
export function skillsDir(root: string): string {
  return path.join(workspacePaths(root).cortexDir, 'skills');
}

/**
 * Project-scoped skill store. Skills are keyed by their `id` and stored one
 * JSON document per file; the store self-initializes its backing directory on
 * the first write, so it works on a repo that has not yet run `devcortex init`.
 */
export class SkillStore extends JsonLedger<SkillManifest> {
  constructor(root: string) {
    super(root, skillsDir(root), SkillManifestSchema, 'skill');
  }

  /**
   * Validate `skill` against the disk contract and persist it atomically,
   * overwriting any existing skill with the same id. Returns the schema-parsed
   * value actually written.
   */
  async save(skill: SkillManifest): Promise<SkillManifest> {
    return this.persist(skill);
  }
}
