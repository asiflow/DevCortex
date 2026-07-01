// ============================================================================
// Safe MCP Manager (§7.19) — public API.
//
//   mcpCatalog: McpServerSpec[]                 — curated, honestly-scoped catalog
//   recommendMcp(task, graph): McpServerSpec[]  — ranked task/stack match
//   listMcp(root)                               — installed vs recommended
//   installMcpSafely(root, id, opts)            — read-only-by-default install,
//                                                 confirm-before-overwrite,
//                                                 refuses unknown ids
//   auditMcp(root)                              — flag write/destructive/secret/
//                                                 ungoverned servers vs policy
//
// The `McpServerSpec` / `McpCapability` / `McpTrust` / `McpAccess` types live in
// the domain contract (domain/mcp.ts) and are re-exported from `@devcortex/core`
// via the domain barrel.
// ============================================================================

export { mcpCatalog, CATALOG_BY_ID, TRUST_RANK, getCatalogEntry } from './catalog';

export { recommendMcp } from './recommend';

export {
  listMcp,
  installMcpSafely,
  auditMcp,
  resolveInstalled,
} from './manager';
export type { InstalledServer, InstalledSource, InstallPlan, InstallStatus } from './manager';

export {
  mcpJsonPath,
  readMcpJson,
  writeMcpJson,
  buildServerEntry,
  parseInstallCommand,
} from './host-config';
export type { McpJson, McpServerEntry, DevcortexAnnotation } from './host-config';

export { McpSpecStore, mcpDir, mcpSpecPath, mcpSpecRelPath } from './store';
