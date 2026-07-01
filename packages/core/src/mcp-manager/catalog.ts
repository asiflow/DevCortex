// ============================================================================
// Safe MCP Manager (§7.19) — curated server catalog.
//
// A hand-vetted, deterministic catalog of well-known MCP servers. Every entry
// is a full `McpServerSpec` (domain/mcp.ts): its trust level, requested
// permission scopes, per-tool read/write + destructive breakdown, required
// secrets, and sandbox posture are set HONESTLY from each server's documented
// surface — not aspirationally. The manager uses this catalog to recommend,
// install (read-only by default), and audit MCP servers.
//
// Curation rules encoded here:
//  - `trust` reflects the publisher: `trusted` = first-party / official
//    reference server; `community` = popular but unvetted publisher. An
//    uncatalogued server discovered in a repo's `.mcp.json` is surfaced as
//    `unknown` at runtime (see manager.ts) — it never appears in this catalog.
//  - `access` is `read` or `write`; `destructive` is tracked SEPARATELY because
//    not every write is destructive (a GitHub comment is a non-destructive
//    write; a force-push is destructive). The firewall scores the two signals
//    independently.
//  - `secretsRequired` lists ENV VAR NAMES only, never values.
// ============================================================================

import type { McpServerSpec, McpTrust } from '../domain';

/**
 * The curated catalog. Ordered roughly by how universally useful each server is
 * so a stable, readable default order is available before any ranking.
 */
export const mcpCatalog: readonly McpServerSpec[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    source: 'npm:@modelcontextprotocol/server-filesystem',
    trust: 'trusted',
    permissions: ['filesystem.read', 'filesystem.write'],
    tools: [
      { name: 'read_file', access: 'read', destructive: false },
      { name: 'read_multiple_files', access: 'read', destructive: false },
      { name: 'list_directory', access: 'read', destructive: false },
      { name: 'directory_tree', access: 'read', destructive: false },
      { name: 'search_files', access: 'read', destructive: false },
      { name: 'get_file_info', access: 'read', destructive: false },
      { name: 'create_directory', access: 'write', destructive: false },
      { name: 'write_file', access: 'write', destructive: true },
      { name: 'edit_file', access: 'write', destructive: true },
      { name: 'move_file', access: 'write', destructive: true },
    ],
    secretsRequired: [],
    sandbox: true,
    installCommand: 'npx -y @modelcontextprotocol/server-filesystem <ALLOWED_DIR>',
    note: 'Scope with explicit allowed directories. write_file/edit_file/move_file overwrite in place — roll back via version control. No secrets; sandboxed to the allow-listed paths.',
  },
  {
    id: 'git',
    name: 'Git',
    source: 'pypi:mcp-server-git',
    trust: 'trusted',
    permissions: ['git.read', 'git.write'],
    tools: [
      { name: 'git_status', access: 'read', destructive: false },
      { name: 'git_diff', access: 'read', destructive: false },
      { name: 'git_log', access: 'read', destructive: false },
      { name: 'git_show', access: 'read', destructive: false },
      { name: 'git_add', access: 'write', destructive: false },
      { name: 'git_commit', access: 'write', destructive: false },
      { name: 'git_create_branch', access: 'write', destructive: false },
      { name: 'git_checkout', access: 'write', destructive: true },
      { name: 'git_reset', access: 'write', destructive: true },
    ],
    secretsRequired: [],
    sandbox: false,
    installCommand: 'uvx mcp-server-git --repository <REPO_PATH>',
    note: 'Local git operations. git_checkout and git_reset can discard uncommitted work (destructive). Read/diff/log tools are safe. No secrets.',
  },
  {
    id: 'github',
    name: 'GitHub',
    source: 'ghcr.io/github/github-mcp-server',
    trust: 'trusted',
    permissions: ['github.read', 'github.write', 'github.workflow'],
    tools: [
      { name: 'get_file_contents', access: 'read', destructive: false },
      { name: 'search_repositories', access: 'read', destructive: false },
      { name: 'search_code', access: 'read', destructive: false },
      { name: 'list_commits', access: 'read', destructive: false },
      { name: 'list_issues', access: 'read', destructive: false },
      { name: 'add_issue_comment', access: 'write', destructive: false },
      { name: 'create_issue', access: 'write', destructive: false },
      { name: 'create_branch', access: 'write', destructive: false },
      { name: 'create_pull_request', access: 'write', destructive: false },
      { name: 'create_or_update_file', access: 'write', destructive: true },
      { name: 'push_files', access: 'write', destructive: true },
      { name: 'merge_pull_request', access: 'write', destructive: true },
    ],
    secretsRequired: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    sandbox: false,
    installCommand: 'docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server',
    note: 'Requires a personal access token — scope it to least privilege (avoid repo/admin/delete). create_or_update_file and push_files overwrite; merge_pull_request is effectively irreversible on protected branches.',
  },
  {
    id: 'playwright',
    name: 'Playwright (Browser)',
    source: 'npm:@playwright/mcp',
    trust: 'trusted',
    permissions: ['browser.read', 'browser.interact'],
    tools: [
      { name: 'browser_snapshot', access: 'read', destructive: false },
      { name: 'browser_take_screenshot', access: 'read', destructive: false },
      { name: 'browser_console_messages', access: 'read', destructive: false },
      { name: 'browser_network_requests', access: 'read', destructive: false },
      { name: 'browser_navigate', access: 'write', destructive: false },
      { name: 'browser_click', access: 'write', destructive: false },
      { name: 'browser_type', access: 'write', destructive: false },
      { name: 'browser_file_upload', access: 'write', destructive: false },
      { name: 'browser_evaluate', access: 'write', destructive: true },
    ],
    secretsRequired: [],
    sandbox: true,
    installCommand: 'npx -y @playwright/mcp@latest',
    note: 'Drives an isolated browser context. browser_evaluate runs arbitrary page JavaScript (treat as destructive). Interactions submit real forms / issue real requests — point it at test targets, not production.',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL (read-only)',
    source: 'npm:@modelcontextprotocol/server-postgres',
    trust: 'trusted',
    permissions: ['database.read'],
    tools: [
      { name: 'query', access: 'read', destructive: false },
      { name: 'list_schemas', access: 'read', destructive: false },
      { name: 'list_tables', access: 'read', destructive: false },
      { name: 'describe_table', access: 'read', destructive: false },
    ],
    secretsRequired: ['DATABASE_URL'],
    sandbox: false,
    installCommand: 'npx -y @modelcontextprotocol/server-postgres <CONNECTION_URL>',
    note: 'Official reference server is read-only (executes SELECT only). The connection string carries database credentials — inject via env, never commit. For writes, adopt a vetted read-write server behind explicit approval.',
  },
  {
    id: 'stripe-docs',
    name: 'Stripe Docs',
    source: 'npm:@stripe/mcp',
    trust: 'trusted',
    permissions: ['stripe.docs.read'],
    tools: [
      { name: 'search_documentation', access: 'read', destructive: false },
      { name: 'fetch_documentation_page', access: 'read', destructive: false },
      { name: 'search_stripe_resources', access: 'read', destructive: false },
    ],
    secretsRequired: [],
    sandbox: false,
    installCommand: 'npx -y @stripe/mcp --tools=documentation',
    note: 'Documentation-only surface — public content, no API key. The full @stripe/mcp toolkit (--tools=all) adds write/payment tools (create charges/refunds/customers) and REQUIRES STRIPE_SECRET_KEY; those must stay behind approval and never run unattended against live keys.',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    source: 'https://mcp.vercel.com',
    trust: 'trusted',
    permissions: ['vercel.read', 'vercel.deploy'],
    tools: [
      { name: 'list_projects', access: 'read', destructive: false },
      { name: 'get_project', access: 'read', destructive: false },
      { name: 'list_deployments', access: 'read', destructive: false },
      { name: 'get_deployment', access: 'read', destructive: false },
      { name: 'get_deployment_build_logs', access: 'read', destructive: false },
      { name: 'search_vercel_documentation', access: 'read', destructive: false },
      { name: 'deploy_to_vercel', access: 'write', destructive: true },
    ],
    secretsRequired: ['VERCEL_TOKEN'],
    sandbox: false,
    installCommand: 'npx -y mcp-remote https://mcp.vercel.com',
    note: 'Hosted MCP bridged via mcp-remote. deploy_to_vercel triggers a real (possibly production) deployment — keep behind approval. Prefer the OAuth transport; a VERCEL_TOKEN must be least-privilege and team-scoped.',
  },
  {
    id: 'docker',
    name: 'Docker',
    source: 'pypi:mcp-server-docker',
    trust: 'community',
    permissions: ['docker.read', 'docker.write'],
    tools: [
      { name: 'list_containers', access: 'read', destructive: false },
      { name: 'list_images', access: 'read', destructive: false },
      { name: 'inspect_container', access: 'read', destructive: false },
      { name: 'fetch_container_logs', access: 'read', destructive: false },
      { name: 'start_container', access: 'write', destructive: false },
      { name: 'create_container', access: 'write', destructive: true },
      { name: 'run_container', access: 'write', destructive: true },
      { name: 'stop_container', access: 'write', destructive: true },
      { name: 'remove_container', access: 'write', destructive: true },
      { name: 'remove_image', access: 'write', destructive: true },
    ],
    secretsRequired: [],
    sandbox: false,
    installCommand: 'uvx mcp-server-docker',
    note: 'Community server with full control of the local Docker daemon — create_container/run_container is host-level code execution (effectively root-equivalent via the socket). Require approval on every write and prefer running DevCortex itself sandboxed.',
  },
  {
    id: 'cloud-logs',
    name: 'Cloud Logs & Observability (Grafana)',
    source: 'ghcr.io/grafana/mcp-grafana',
    trust: 'community',
    permissions: ['observability.read', 'observability.annotate'],
    tools: [
      { name: 'query_loki_logs', access: 'read', destructive: false },
      { name: 'query_prometheus', access: 'read', destructive: false },
      { name: 'list_datasources', access: 'read', destructive: false },
      { name: 'search_dashboards', access: 'read', destructive: false },
      { name: 'get_dashboard', access: 'read', destructive: false },
      { name: 'list_incidents', access: 'read', destructive: false },
      { name: 'search_documentation', access: 'read', destructive: false },
      { name: 'create_annotation', access: 'write', destructive: false },
    ],
    secretsRequired: ['GRAFANA_URL', 'GRAFANA_API_KEY'],
    sandbox: false,
    installCommand: 'docker run -i --rm -e GRAFANA_URL -e GRAFANA_API_KEY ghcr.io/grafana/mcp-grafana -t stdio',
    note: 'Observability + docs: query logs (Loki), metrics (Prometheus), dashboards, incidents, and product docs. Read-first; create_annotation is a low-risk write. The API key scopes access — use a Viewer / least-privilege key.',
  },
];

/** Fast id -> spec lookup over {@link mcpCatalog}. */
export const CATALOG_BY_ID: ReadonlyMap<string, McpServerSpec> = new Map(
  mcpCatalog.map((spec) => [spec.id, spec]),
);

/** Ranking weight for trust levels — lower sorts first (most trusted first). */
export const TRUST_RANK: Readonly<Record<McpTrust, number>> = {
  trusted: 0,
  community: 1,
  unknown: 2,
};

/** Resolve a catalog entry by id, or `undefined` when it is not curated. */
export function getCatalogEntry(id: string): McpServerSpec | undefined {
  return CATALOG_BY_ID.get(id);
}
