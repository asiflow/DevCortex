/**
 * MCP Security Firewall (§7.20) — public API.
 *
 *   defaultPolicy(): McpPolicy
 *   loadPolicy(root): Promise<McpPolicy>            // safe defaults when absent
 *   savePolicy(root, policy): Promise<void>         // atomic, schema-validated
 *   evaluateToolCall(policy, call): ToolCallEval    // deny > allow > approval
 *   scanPromptInjection(text): string[]             // heuristic signals
 *
 * The `McpPolicy` / `ToolCallEval` / `FirewallDecision` types live in the domain
 * contract (domain/firewall.ts) and are re-exported from `@devcortex/core` via
 * the domain barrel.
 */
export {
  defaultPolicy,
  loadPolicy,
  savePolicy,
  evaluateToolCall,
  scanPromptInjection,
} from './firewall';
export type { ToolCall } from './firewall';
