// ============================================================================
// Sub-project #5 domain contract — MCP Security Firewall (§7.20).
//
// The firewall is the allow/deny/approval decision layer that sits between an
// agent and its MCP tools. Its configuration — an `McpPolicy` — is a PERSISTED
// artifact at `.cortex/policies/mcp-firewall.json` (see workspacePaths()
// .mcpFirewallPolicy), so this file owns both the canonical interface and its
// runtime zod validator, wired by the compile-time drift guard at the bottom.
//
// The per-call verdict — `ToolCallEval` — is a COMPUTED artifact: the firewall
// derives it on demand from the policy + the tool call and never persists it,
// so — like RiskClassification / BlastRadius in ./types and CouncilReport in
// ./council — it is types-only with no zod validator.
//
// Additive to the frozen contract in ./types + ./schemas; those files are
// untouched. Convention: relative imports omit extensions; unions are declared
// as `as const` string tuples; interfaces own object shapes.
// ============================================================================

import { z } from 'zod';

// --- enums ------------------------------------------------------------------

/**
 * The three verdicts the firewall can return for a tool call.
 * - `allow`            — the call proceeds.
 * - `deny`             — the call is blocked outright.
 * - `require-approval` — the call is paused pending explicit human approval.
 */
export const FIREWALL_DECISIONS = ['allow', 'deny', 'require-approval'] as const;
export type FirewallDecision = (typeof FIREWALL_DECISIONS)[number];

// --- interfaces -------------------------------------------------------------

/**
 * Persisted firewall configuration. `allow` / `requireApproval` / `deny` hold
 * tool identifiers or scope patterns (e.g. `github.read`, `database.write`);
 * `budgets` caps how many times a given tool/scope may run per session;
 * `dryRun` short-circuits every allowed call into a no-op for safe rehearsal.
 */
export interface McpPolicy {
  /** scopes/tools permitted without prompting */
  allow: string[];
  /** scopes/tools that pause for explicit human approval before running */
  requireApproval: string[];
  /** scopes/tools blocked outright */
  deny: string[];
  /** per-tool/scope invocation caps (identifier -> max calls) */
  budgets: Record<string, number>;
  /** when true, allowed calls are rehearsed without side effects */
  dryRun: boolean;
}

/**
 * Computed per-call verdict. `reasons` explains the decision (matched rule,
 * exceeded budget, destructive-tool escalation, etc.); `riskScore` is a
 * deterministic 0-100 heuristic; `redactedArgs` is the tool arguments after the
 * redaction engine has masked secrets, present only when arguments were given.
 */
export interface ToolCallEval {
  decision: FirewallDecision;
  reasons: string[];
  /** deterministic command-risk score, 0 (safe) .. 100 (dangerous) */
  riskScore: number;
  /** tool arguments with secrets masked; omitted when there were no arguments */
  redactedArgs?: string;
}

// --- schemas (disk boundary) ------------------------------------------------

export const FirewallDecisionSchema = z.enum(FIREWALL_DECISIONS);

export const McpPolicySchema = z.object({
  allow: z.array(z.string()),
  requireApproval: z.array(z.string()),
  deny: z.array(z.string()),
  budgets: z.record(z.string(), z.number()),
  dryRun: z.boolean(),
});

// --- compile-time drift guard -----------------------------------------------
// Mutual assignability, not strict identity, so zod's optional representation
// does not produce pedantic false positives (mirrors ./schemas + ./skills).
// Only McpPolicy is persisted; ToolCallEval is computed and intentionally has
// no schema.

type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : false) : false;

function assertMatch<_T extends true>(): void {
  /* compile-time only */
}

assertMatch<MutuallyAssignable<z.infer<typeof McpPolicySchema>, McpPolicy>>();
