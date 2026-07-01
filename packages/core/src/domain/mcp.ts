// ============================================================================
// Sub-project #5 domain contract — Safe MCP Manager (§7.19).
//
// Describes an MCP server DevCortex can recommend, install, scope, and audit.
// Every field maps to a disclosure the Safe MCP Manager must surface before an
// agent is allowed to connect a tool: where the server comes from, how much it
// is trusted, which permissions/tools it exposes, whether any tool is
// destructive, what secrets it needs, and whether it runs sandboxed.
//
// An `McpServerSpec` is a PERSISTED artifact — one JSON document per server at
// `.cortex/mcp/<id>.json` (see workspacePaths().mcpDir) — so this file owns both
// the canonical interface and its runtime zod validator, wired together by the
// compile-time drift guard at the bottom (mirrors ./schemas and ./skills).
//
// Additive to the frozen contract in ./types + ./schemas; those files are
// untouched. Convention: relative imports omit extensions; unions are declared
// as `as const` string tuples; interfaces own object shapes.
// ============================================================================

import { z } from 'zod';

// --- enums ------------------------------------------------------------------

/**
 * How much a source is trusted, driving the Safe MCP Manager's default posture.
 * - `trusted`   — first-party / vetted publisher; may default to writeable tools.
 * - `community` — popular but unvetted; requires approval for write/destructive.
 * - `unknown`   — unrecognised source; read-only by default, sandbox strongly
 *   recommended, and every write requires explicit approval.
 */
export const MCP_TRUST = ['trusted', 'community', 'unknown'] as const;
export type McpTrust = (typeof MCP_TRUST)[number];

/** Whether a single MCP tool reads state or mutates it. */
export const MCP_ACCESS = ['read', 'write'] as const;
export type McpAccess = (typeof MCP_ACCESS)[number];

// --- interfaces -------------------------------------------------------------

/**
 * One tool an MCP server exposes. `destructive` is tracked independently of
 * `access` because not every write is destructive (e.g. `github.comment` is a
 * non-destructive write) and the firewall scores the two signals separately.
 */
export interface McpCapability {
  name: string;
  access: McpAccess;
  /** true when invoking the tool can irreversibly delete/overwrite/deploy */
  destructive: boolean;
}

/**
 * Persisted description of an MCP server under management. Mirrors the §7.19
 * disclosure checklist (source, trust, permissions, tools, secrets, sandbox)
 * plus the install/rollback affordances the manager needs.
 */
export interface McpServerSpec {
  /** stable slug used as the on-disk filename `<id>.json` and policy key prefix */
  id: string;
  name: string;
  /** provenance: registry ref, git URL, npm package, or `local` */
  source: string;
  trust: McpTrust;
  /** coarse permission scopes the server requests, e.g. `github.read` */
  permissions: string[];
  tools: McpCapability[];
  /** env var names the server needs; never their values */
  secretsRequired: string[];
  /** true when the server is launched inside a sandbox/boundary */
  sandbox: boolean;
  /** command that installs/launches the server, when applicable */
  installCommand?: string;
  /** human-readable audit note: rollback command, audit-log path, caveats */
  note: string;
}

// --- schemas (disk boundary) ------------------------------------------------

export const McpTrustSchema = z.enum(MCP_TRUST);
export const McpAccessSchema = z.enum(MCP_ACCESS);

export const McpCapabilitySchema = z.object({
  name: z.string(),
  access: McpAccessSchema,
  destructive: z.boolean(),
});

export const McpServerSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  trust: McpTrustSchema,
  permissions: z.array(z.string()),
  tools: z.array(McpCapabilitySchema),
  secretsRequired: z.array(z.string()),
  sandbox: z.boolean(),
  installCommand: z.string().optional(),
  note: z.string(),
});

// --- compile-time drift guard -----------------------------------------------
// Mutual assignability, not strict identity, so zod's optional representation
// does not produce pedantic false positives (mirrors ./schemas + ./skills).

type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : false) : false;

function assertMatch<_T extends true>(): void {
  /* compile-time only */
}

assertMatch<MutuallyAssignable<z.infer<typeof McpCapabilitySchema>, McpCapability>>();
assertMatch<MutuallyAssignable<z.infer<typeof McpServerSpecSchema>, McpServerSpec>>();
