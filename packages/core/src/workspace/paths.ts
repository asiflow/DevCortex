/**
 * Path resolution for the `.cortex/` workspace.
 *
 * Every other workspace operation is expressed in terms of the absolute paths
 * computed here, so there is exactly one place that knows the on-disk layout
 * (mirrors §5 of the design spec).
 */
import path from 'node:path';

import type { DetectedStack, OperatingMode, ProjectGraph } from '../domain/index';

/** Absolute, resolved locations of every artifact DevCortex owns under a repo. */
export interface WorkspacePaths {
  /** absolute repo root */
  root: string;
  /** `<root>/.cortex` */
  cortexDir: string;
  /** `<cortexDir>/config.yaml` */
  config: string;
  /** `<cortexDir>/project.md` */
  projectMd: string;
  /** `<cortexDir>/architecture.md` */
  architectureMd: string;
  /** `<cortexDir>/quality-constitution.md` */
  qualityConstitution: string;
  /** `<cortexDir>/graph.json` */
  graph: string;
  /** `<cortexDir>/memory` */
  memoryDir: string;
  /** `<cortexDir>/features` */
  featuresDir: string;
  /** `<cortexDir>/decisions` */
  decisionsDir: string;
  /** `<cortexDir>/evidence` */
  evidenceDir: string;
  /** `<cortexDir>/ship-reports` */
  shipReportsDir: string;
  /** `<cortexDir>/runs` (reserved — flight recorder) */
  runsDir: string;
  /** `<cortexDir>/mcp` — one `<id>.json` McpServerSpec per managed server */
  mcpDir: string;
  /** `<cortexDir>/policies` — governance policies (MCP firewall, etc.) */
  policiesDir: string;
  /** `<policiesDir>/mcp-firewall.json` — the persisted McpPolicy */
  mcpFirewallPolicy: string;
  /** `<cortexDir>/cache` (gitignored) */
  cacheDir: string;
}

/** Options accepted by {@link initWorkspace}. */
export interface InitOptions {
  /** initial operating mode written to config */
  mode: OperatingMode;
  /** detected stack used to seed the generated docs + config */
  stack: DetectedStack;
  /** overwrite an already-initialized workspace instead of throwing */
  force?: boolean;
  /**
   * Pre-scanned project graph to cache at `graph.json` and seed the generated
   * docs. When omitted, {@link initWorkspace} scans `root` itself.
   */
  graph?: ProjectGraph;
}

/**
 * Resolve every `.cortex/` path for a given repo root. Pure — performs no I/O,
 * so it is safe to call before the workspace exists.
 */
export function workspacePaths(root: string): WorkspacePaths {
  const resolvedRoot = path.resolve(root);
  const cortexDir = path.join(resolvedRoot, '.cortex');
  return {
    root: resolvedRoot,
    cortexDir,
    config: path.join(cortexDir, 'config.yaml'),
    projectMd: path.join(cortexDir, 'project.md'),
    architectureMd: path.join(cortexDir, 'architecture.md'),
    qualityConstitution: path.join(cortexDir, 'quality-constitution.md'),
    graph: path.join(cortexDir, 'graph.json'),
    memoryDir: path.join(cortexDir, 'memory'),
    featuresDir: path.join(cortexDir, 'features'),
    decisionsDir: path.join(cortexDir, 'decisions'),
    evidenceDir: path.join(cortexDir, 'evidence'),
    shipReportsDir: path.join(cortexDir, 'ship-reports'),
    runsDir: path.join(cortexDir, 'runs'),
    mcpDir: path.join(cortexDir, 'mcp'),
    policiesDir: path.join(cortexDir, 'policies'),
    mcpFirewallPolicy: path.join(cortexDir, 'policies', 'mcp-firewall.json'),
    cacheDir: path.join(cortexDir, 'cache'),
  };
}
