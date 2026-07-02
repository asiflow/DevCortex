/**
 * `composeSessionBrief` — assemble the ≤ 2 KB project brief injected at every
 * Claude Code SessionStart hook.
 *
 * Design constraints (spec WS-1, pt 1):
 *   - FAST and READ-ONLY: reads `.cortex/` files that already exist.
 *     NEVER triggers a repo scan or graph rebuild.
 *   - NEVER throws for content reasons: an unreadable ledger degrades to an
 *     omitted section. Only a missing workspace config returns the init hint.
 *   - Byte budget: the rendered text is guaranteed ≤ `maxBytes` (UTF-8).
 *     Sections are dropped from the bottom up until the budget is met; lines
 *     are never partially truncated.
 */
import { readFile } from 'node:fs/promises';

import type { CortexConfig, ProjectGraph, RiskLevel } from '../domain/index';
import { isDevCortexError } from '../domain/index';
import { DecisionLedger } from '../ledgers/decision-ledger';
import { FeatureLedger } from '../ledgers/feature-ledger';
import { MemoryLedger } from '../ledgers/memory-ledger';
import { loadConfig } from '../workspace/config';
import { workspacePaths } from '../workspace/paths';

// ---------------------------------------------------------------------------

/** Numeric rank used to sort risks highest-first. */
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const HEADER = 'CORTEX BRIEF — evidence-backed project state (devcortex)';

const UNINITIALIZED_TEXT =
  'DevCortex: no .cortex workspace found. Run `devcortex init` to enable project memory, gates, and ship reports.';

// ---------------------------------------------------------------------------

export interface SessionBrief {
  /** Rendered text block, guaranteed ≤ maxBytes when UTF-8 encoded. */
  text: string;
  /** Byte length of `text` (UTF-8). */
  bytes: number;
  /** True when the workspace is missing/uninitialized and the brief is the init hint. */
  uninitialized: boolean;
}

/**
 * Compose a ≤ `maxBytes` (default 2048) project brief from `.cortex/` state.
 *
 * Returns the init hint (with `uninitialized: true`) when the workspace config
 * is absent. All other I/O failures degrade to omitted sections — the function
 * never throws for content reasons.
 */
export async function composeSessionBrief(
  root: string,
  options?: { maxBytes?: number },
): Promise<SessionBrief> {
  const maxBytes = options?.maxBytes ?? 2048;

  // Detect uninitialized workspace via config load.
  let config: CortexConfig;
  try {
    config = await loadConfig(root);
  } catch (err) {
    if (isDevCortexError(err) && err.code === 'CONFIG_NOT_FOUND') {
      const text = UNINITIALIZED_TEXT;
      return { text, bytes: Buffer.byteLength(text, 'utf8'), uninitialized: true };
    }
    // Other errors (e.g. corrupt YAML) bubble up — not a content failure.
    throw err;
  }

  const paths = workspacePaths(root);

  // Each "block" is a section rendered as an array of lines (including a
  // trailing blank line used as a separator). Blocks are popped from the end
  // under budget pressure, so section order is the truncation priority order.
  const blocks: string[][] = [[HEADER, '']];

  // --- Section 1: ## Project ------------------------------------------------
  // Plain readFile + JSON.parse — never calls the graph scanner.
  try {
    const raw = await readFile(paths.graph, 'utf8');
    const graph = JSON.parse(raw) as ProjectGraph;
    const { stack, stats } = graph;
    const frameworkPart = stack.framework !== 'unknown' ? ` / ${stack.framework}` : '';
    const pmPart = stack.packageManager !== 'unknown' ? ` (${stack.packageManager})` : '';
    const summary = `${stack.language}${frameworkPart}${pmPart} · ${stats.fileCount} files`;
    blocks.push(['## Project', summary, '']);
  } catch {
    // graph.json absent or malformed — omit section, not an error.
  }

  // --- Section 2: ## Top risks ----------------------------------------------
  try {
    const memory = new MemoryLedger(root);
    const risks = await memory.list((m) => m.type === 'risk');
    risks.sort((a, b) => {
      const d = RISK_RANK[b.riskLevel] - RISK_RANK[a.riskLevel];
      return d !== 0 ? d : b.confidence - a.confidence;
    });
    const top = risks.slice(0, 3);
    if (top.length > 0) {
      blocks.push(['## Top risks', ...top.map((r) => `- [${r.riskLevel}] ${r.title}`), '']);
    }
  } catch {
    // Ledger unreadable — omit section.
  }

  // --- Section 3: ## In-flight features -------------------------------------
  try {
    const feature = new FeatureLedger(root);
    const building = await feature.list((f) => f.status === 'building');
    // list() surfaces readdir order, which is filesystem-dependent; sort so the
    // brief is deterministic for identical workspace state: newest first, with
    // the id as a total-order tiebreak.
    building.sort((a, b) => {
      const d = b.updatedAt.localeCompare(a.updatedAt);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });
    const top = building.slice(0, 3);
    if (top.length > 0) {
      blocks.push(['## In-flight features', ...top.map((f) => `- ${f.feature} (${f.id})`), '']);
    }
  } catch {
    // Ledger unreadable — omit section.
  }

  // --- Section 4: ## Recent decisions ---------------------------------------
  try {
    const decision = new DecisionLedger(root);
    const decisions = await decision.list();
    // Sort newest-first by ISO date string (lexicographic sort is correct for ISO 8601).
    decisions.sort((a, b) => b.date.localeCompare(a.date));
    const top = decisions.slice(0, 2);
    if (top.length > 0) {
      blocks.push(['## Recent decisions', ...top.map((d) => `- ${d.decision}`), '']);
    }
  } catch {
    // Ledger unreadable — omit section.
  }

  // --- Section 5: ## Protected paths ----------------------------------------
  const protectedPaths = config.risk.protectedPaths.slice(0, 5);
  if (protectedPaths.length > 0) {
    blocks.push(['## Protected paths', ...protectedPaths, '']);
  }

  // --- Byte-budget enforcement ----------------------------------------------
  // Drop whole sections from the bottom up until the rendered text fits within
  // maxBytes. Never emits a partially-cut line.
  let text = render(blocks);

  while (Buffer.byteLength(text, 'utf8') > maxBytes && blocks.length > 1) {
    blocks.pop();
    text = render(blocks);
  }

  const bytes = Buffer.byteLength(text, 'utf8');
  return { text, bytes, uninitialized: false };
}

// ---------------------------------------------------------------------------

/**
 * Join all blocks into a single string, stripping any trailing blank lines so
 * the output doesn't end with an empty line.
 */
function render(blocks: string[][]): string {
  const lines = blocks.flat();
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}
