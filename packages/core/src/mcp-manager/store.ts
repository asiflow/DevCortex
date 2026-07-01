// ============================================================================
// Safe MCP Manager (§7.19) — persisted McpServerSpec store.
//
// Each managed server is recorded as one `<id>.json` McpServerSpec under
// `.cortex/mcp/` (workspacePaths().mcpDir). Reusing the shared JsonLedger base
// buys the same durability guarantees as every other `.cortex/` artifact: writes
// are atomic and schema-validated, every read is re-validated against
// McpServerSpecSchema (a corrupt/hand-edited spec surfaces as a LedgerError
// instead of silently poisoning an audit), and unsafe ids are rejected before
// they become file names.
// ============================================================================

import path from 'node:path';

import { McpServerSpecSchema } from '../domain';
import type { McpServerSpec } from '../domain';
import { JsonLedger } from '../ledgers';
import { workspacePaths } from '../workspace';

/** Absolute path of the `.cortex/mcp` directory for a repo root. */
export function mcpDir(root: string): string {
  return workspacePaths(root).mcpDir;
}

/** Absolute path of the recorded spec file for `id`. */
export function mcpSpecPath(root: string, id: string): string {
  return path.join(mcpDir(root), `${id}.json`);
}

/** Repo-relative (POSIX) path of the recorded spec file for `id`. */
export function mcpSpecRelPath(id: string): string {
  return `.cortex/mcp/${id}.json`;
}

/**
 * Project-scoped store of managed MCP server specs, keyed by `id`, one JSON
 * document per file. Self-initializes its backing directory on first write, so
 * it works on a repo that has not yet run `devcortex init`.
 */
export class McpSpecStore extends JsonLedger<McpServerSpec> {
  constructor(root: string) {
    super(root, mcpDir(root), McpServerSpecSchema, 'mcp server');
  }

  /**
   * Validate `spec` against the disk contract and persist it atomically,
   * overwriting any existing spec with the same id. Returns the schema-parsed
   * value actually written.
   */
  async save(spec: McpServerSpec): Promise<McpServerSpec> {
    return this.persist(spec);
  }
}
