// ============================================================================
// Safe MCP Manager (§7.19) — list / install / audit.
//
// The three surface operations over the curated catalog + a repo's installed
// MCP servers. All deterministic and tokenless.
//
//   listMcp(root)               — what is wired in `.mcp.json` vs what the
//                                 catalog would recommend next.
//   installMcpSafely(root, id)  — validate a catalog entry, write it to
//                                 `.mcp.json` with a DEFAULT-READ-ONLY posture,
//                                 record the McpServerSpec under `.cortex/mcp/`,
//                                 and confirm-before-overwrite; refuse unknown
//                                 ids outright.
//   auditMcp(root)              — cross-check every installed server against the
//                                 firewall policy and flag write/destructive/
//                                 secret-requiring/unsandboxed/ungoverned risks.
//
// Trust resolution: a server in `.mcp.json` is described by its RECORDED spec
// (`.cortex/mcp/<id>.json`) when present, else by the catalog entry, else — for
// a server the user wired up by hand that DevCortex has never governed — a
// synthesized `unknown`-trust spec. That last case is exactly what the audit is
// designed to surface.
// ============================================================================

import { PolicyViolationError, McpServerSpecSchema, SchemaValidationError } from '../domain';
import type { McpServerSpec } from '../domain';
import { evaluateToolCall, loadPolicy } from '../mcp-firewall';

import { CATALOG_BY_ID, TRUST_RANK, mcpCatalog } from './catalog';
import { buildServerEntry, mcpJsonPath, readMcpJson, writeMcpJson } from './host-config';
import type { McpServerEntry } from './host-config';
import { McpSpecStore, mcpSpecPath, mcpSpecRelPath } from './store';

// --- resolution -------------------------------------------------------------

/** How an installed server's spec was resolved. */
export type InstalledSource = 'recorded' | 'catalog' | 'unknown';

/** An installed server plus the provenance of the spec describing it. */
export interface InstalledServer {
  spec: McpServerSpec;
  /** whether a governed spec exists at `.cortex/mcp/<id>.json` */
  recorded: boolean;
  source: InstalledSource;
}

/**
 * Resolve every server declared in `.mcp.json` to a spec, preferring the
 * recorded governed spec, then the catalog, then a synthesized unknown spec.
 * Ordered by id for stable output.
 */
export async function resolveInstalled(root: string): Promise<InstalledServer[]> {
  const mcpJson = await readMcpJson(root);
  const store = new McpSpecStore(root);

  const ids = Object.keys(mcpJson.mcpServers).sort((a, b) => a.localeCompare(b));
  const installed: InstalledServer[] = [];
  for (const id of ids) {
    const entry = mcpJson.mcpServers[id];
    const recorded = await store.get(id);
    if (recorded !== undefined) {
      installed.push({ spec: recorded, recorded: true, source: 'recorded' });
      continue;
    }
    const catalogEntry = CATALOG_BY_ID.get(id);
    if (catalogEntry !== undefined) {
      installed.push({ spec: catalogEntry, recorded: false, source: 'catalog' });
      continue;
    }
    installed.push({
      spec: synthesizeUnknownSpec(id, entry),
      recorded: false,
      source: 'unknown',
    });
  }
  return installed;
}

/**
 * Describe a server present in `.mcp.json` but neither recorded nor cataloged:
 * an ungoverned, unknown-trust server whose surface DevCortex cannot vouch for.
 */
function synthesizeUnknownSpec(id: string, entry: McpServerEntry | undefined): McpServerSpec {
  const source = describeEntrySource(entry);
  const secretsRequired = entry?.env !== undefined ? Object.keys(entry.env) : [];
  return {
    id,
    name: id,
    source,
    trust: 'unknown',
    permissions: [],
    tools: [],
    secretsRequired,
    sandbox: false,
    note: 'Present in .mcp.json but not recorded or cataloged by DevCortex — treat as unknown-trust until vetted and governed.',
  };
}

/** Best-effort provenance string for an unmanaged host entry. */
function describeEntrySource(entry: McpServerEntry | undefined): string {
  if (entry === undefined) {
    return 'unknown';
  }
  if (typeof entry.url === 'string' && entry.url.length > 0) {
    return entry.url;
  }
  if (typeof entry.command === 'string' && entry.command.length > 0) {
    const args = Array.isArray(entry.args) ? entry.args.join(' ') : '';
    return `${entry.command} ${args}`.trim();
  }
  return 'unknown';
}

// --- list -------------------------------------------------------------------

/**
 * List the MCP servers wired into a repo alongside the catalog servers not yet
 * installed (recommended next), ordered trusted-first then by id.
 */
export async function listMcp(
  root: string,
): Promise<{ installed: McpServerSpec[]; recommended: McpServerSpec[] }> {
  const resolved = await resolveInstalled(root);
  const installed = resolved.map((item) => item.spec);
  const installedIds = new Set(installed.map((spec) => spec.id));

  const recommended = mcpCatalog
    .filter((spec) => !installedIds.has(spec.id))
    .slice()
    .sort(byTrustThenId);

  return { installed, recommended };
}

function byTrustThenId(a: McpServerSpec, b: McpServerSpec): number {
  const trustDelta = TRUST_RANK[a.trust] - TRUST_RANK[b.trust];
  if (trustDelta !== 0) {
    return trustDelta;
  }
  return a.id.localeCompare(b.id);
}

// --- install ----------------------------------------------------------------

/** The concrete change `installMcpSafely` would make (or made). */
export interface InstallPlan {
  id: string;
  /** the `.mcp.json` entry written (or that would be written) */
  entry: McpServerEntry;
  /** absolute path of the recorded spec */
  specPath: string;
  /** absolute path of the host config */
  mcpJsonPath: string;
  posture: 'read-only';
  /** true when an entry for this id already exists in `.mcp.json` */
  wouldOverwrite: boolean;
}

/** Outcome of an install attempt. */
export type InstallStatus = 'installed' | 'updated' | 'exists';

/**
 * Safely install a catalog server by id.
 *
 * Refuses unknown ids ({@link PolicyViolationError}). Validates the catalog
 * entry against {@link McpServerSpecSchema}. When the id already exists in
 * `.mcp.json` and `force` is not set, returns `{ status: 'exists', plan }`
 * WITHOUT writing anything — the caller must confirm before an overwrite.
 * Otherwise writes the read-only-posture entry to `.mcp.json` and records the
 * McpServerSpec under `.cortex/mcp/`, returning `installed` (new) or `updated`
 * (forced overwrite).
 */
export async function installMcpSafely(
  root: string,
  id: string,
  opts: { force?: boolean } = {},
): Promise<{ status: InstallStatus; plan: InstallPlan }> {
  const catalogEntry = CATALOG_BY_ID.get(id);
  if (catalogEntry === undefined) {
    throw new PolicyViolationError(
      `Refusing to install unknown MCP server "${id}": it is not in the vetted catalog. Recommend one with recommendMcp() or list the catalog first.`,
    );
  }

  // Defense in depth: the catalog is code, but a spec must still satisfy the
  // persisted-artifact contract before it can be written or recorded.
  const parsed = McpServerSpecSchema.safeParse(catalogEntry);
  if (!parsed.success) {
    throw new SchemaValidationError(
      `Catalog entry "${id}" failed McpServerSpecSchema and cannot be installed.`,
      { details: parsed.error.issues, cause: parsed.error },
    );
  }
  const spec = parsed.data;

  const entry = buildServerEntry(spec, mcpSpecRelPath(id));
  const mcpJson = await readMcpJson(root);
  const wouldOverwrite = Object.prototype.hasOwnProperty.call(mcpJson.mcpServers, id);

  const plan: InstallPlan = {
    id,
    entry,
    specPath: mcpSpecPath(root, id),
    mcpJsonPath: mcpJsonPath(root),
    posture: 'read-only',
    wouldOverwrite,
  };

  if (wouldOverwrite && opts.force !== true) {
    // Confirm-before-overwrite: nothing is written.
    return { status: 'exists', plan };
  }

  mcpJson.mcpServers[id] = entry;
  await writeMcpJson(root, mcpJson);

  const store = new McpSpecStore(root);
  await store.save(spec);

  return { status: wouldOverwrite ? 'updated' : 'installed', plan };
}

// --- audit ------------------------------------------------------------------

/**
 * Audit every installed MCP server against the persisted firewall policy (safe
 * defaults when none is configured) and its own disclosed surface. Returns a
 * flat list of human-readable findings; an empty list means nothing risky was
 * detected.
 *
 * Findings are tagged for grep-ability:
 *   [unknown-trust] [community] [ungoverned] [secrets] [unsandboxed]
 *   [destructive] [write] [policy-gap]
 */
export async function auditMcp(root: string): Promise<{ findings: string[] }> {
  const installed = await resolveInstalled(root);
  const policy = await loadPolicy(root);
  const findings: string[] = [];

  for (const item of installed) {
    const { spec } = item;

    if (spec.trust === 'unknown') {
      findings.push(
        `[unknown-trust] "${spec.id}" is not in the vetted catalog and has no recorded spec — vet its source (${spec.source}) before use.`,
      );
    } else if (spec.trust === 'community') {
      findings.push(
        `[community] "${spec.id}" is a community (unvetted-publisher) server — keep it read-only and require approval on every write.`,
      );
    }

    if (item.source !== 'unknown' && !item.recorded) {
      findings.push(
        `[ungoverned] "${spec.id}" is wired into .mcp.json but has no recorded spec under .cortex/mcp/ — run installMcpSafely to bring it under governance.`,
      );
    }

    if (spec.secretsRequired.length > 0) {
      findings.push(
        `[secrets] "${spec.id}" requires secrets (${spec.secretsRequired.join(', ')}) — inject via env, never commit, and scope to least privilege.`,
      );
    }

    if (!spec.sandbox && spec.tools.some((tool) => tool.destructive)) {
      findings.push(
        `[unsandboxed] "${spec.id}" exposes destructive tools and is not sandboxed — run DevCortex sandboxed or gate every destructive call.`,
      );
    }

    for (const tool of spec.tools) {
      const isWrite = tool.access === 'write';
      if (!isWrite && !tool.destructive) {
        continue;
      }
      const identifier = `${spec.id}.${tool.name}`;
      const verdict = evaluateToolCall(policy, { server: spec.id, tool: tool.name });
      const kind = tool.destructive ? 'destructive' : 'write';

      if (verdict.decision === 'allow') {
        findings.push(
          `[policy-gap] ${kind} tool "${identifier}" would be ALLOWED without approval by the current firewall policy — add it to requireApproval or deny.`,
        );
      } else if (tool.destructive) {
        findings.push(
          `[destructive] "${identifier}" can irreversibly delete/overwrite/deploy — firewall verdict: ${verdict.decision}.`,
        );
      } else {
        findings.push(
          `[write] "${identifier}" mutates state — firewall verdict: ${verdict.decision}.`,
        );
      }
    }
  }

  return { findings };
}
