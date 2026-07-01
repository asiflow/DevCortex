// ============================================================================
// MCP Security Firewall (§7.20) — implementation.
//
// The firewall is the allow/deny/approval decision layer between an agent and
// its MCP tools. Its configuration — an `McpPolicy` (domain/firewall.ts) — is a
// PERSISTED artifact at `.cortex/policies/mcp-firewall.json`; the per-call
// verdict — a `ToolCallEval` — is COMPUTED on demand and never persisted.
//
// Everything here is deterministic and tokenless (the OSS layer): no LLM calls,
// no network. `evaluateToolCall` combines three signals into one verdict:
//   1. rule matching   — deny > allow > require-approval (deny is absolute);
//   2. a 0-100 risk score derived from destructive/secret/network heuristics;
//   3. prompt-injection scanning + secret redaction over the stringified args.
// An `allow` verdict is escalated to `require-approval` when the call carries a
// prompt-injection signal or an elevated risk score — fail toward asking a
// human, never away from it.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DevCortexError, McpPolicySchema, SchemaValidationError } from '../domain';
import type { FirewallDecision, McpPolicy, ToolCallEval } from '../domain';
import { redactText } from '../redaction';
import { workspacePaths } from '../workspace';

// --- public types -----------------------------------------------------------

/** A tool invocation submitted to the firewall for a verdict. */
export interface ToolCall {
  /** the MCP server id, e.g. `github` */
  server: string;
  /** the tool name on that server, e.g. `delete_branch` */
  tool: string;
  /** the arguments the agent wants to pass; any JSON-serialisable value */
  args?: unknown;
}

// --- risk heuristics --------------------------------------------------------

/** Verbs whose presence in a tool name signals an irreversible mutation. */
const DESTRUCTIVE_VERBS: readonly string[] = [
  'delete', 'del', 'rm', 'remove', 'drop', 'destroy', 'truncate', 'wipe',
  'purge', 'erase', 'reset', 'revoke', 'deploy', 'push', 'force', 'overwrite',
  'kill', 'terminate', 'shutdown', 'format', 'prune',
];

/** Verbs signalling a (possibly non-destructive) state mutation. */
const WRITE_VERBS: readonly string[] = [
  'write', 'update', 'create', 'insert', 'modify', 'edit', 'set', 'put',
  'patch', 'upload', 'send', 'post', 'merge', 'rename', 'move', 'add',
];

/** Substrings that indicate the tool touches secrets / credentials. */
const SECRET_MARKERS: readonly string[] = [
  'secret', 'credential', 'token', 'password', 'passwd', 'apikey', 'api_key',
  'api-key', 'private', 'read_all', 'readall', 'ssh', 'keychain', 'vault', 'env',
];

/** Substrings that indicate a network / exfiltration surface. */
const NETWORK_MARKERS: readonly string[] = [
  'http://', 'https://', 'ftp://', 'ws://', 'wss://', 'fetch', 'curl', 'wget',
  'xmlhttprequest', 'webhook', 'exfil', 'upload', 'request(',
];

/** Risk weights (points added to a 0-100 score, clamped). */
const RISK = {
  destructive: 45,
  write: 25,
  secretAccess: 30,
  network: 15,
  perInjection: 20,
  secretsInArgs: 20,
} as const;

/** At or above this score, an otherwise-allowed call escalates to approval. */
const RISK_ESCALATION_THRESHOLD = 70;

// --- prompt-injection heuristics --------------------------------------------

/** Ordered heuristic patterns; each hit contributes one stable reason string. */
const INJECTION_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  {
    re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|the)\b[^.\n]{0,30}\b(?:instruction|instructions|prompt|prompts|context|rule|rules|message|messages)\b/i,
    reason: 'prompt-injection: instruction-override phrase',
  },
  {
    re: /(?:you are now|new instructions\s*:|system prompt|reveal (?:your )?(?:system )?(?:prompt|instructions)|print (?:your )?instructions|act as (?:an? )?(?:dan|jailbreak|unrestricted)|<\|?im_start\|?>|\[system\])/i,
    reason: 'prompt-injection: system-role hijack',
  },
  {
    re: /(?:<tool|<function|do not (?:tell|inform|mention|reveal)[^.\n]{0,20}(?:the )?user|without (?:telling|informing)[^.\n]{0,20}(?:the )?user|hidden instruction|when (?:you )?(?:call|use|invoke) this tool)/i,
    reason: 'prompt-injection: tool-poisoning directive',
  },
  {
    re: /(?:exfiltrat|send (?:the )?(?:secret|secrets|token|api[_-]?key|password|credential|\.env)|read[_\s]?all[_\s]?secrets|cat\s+[^\n]*\.env|read\s+~?\/?\.ssh|environment variables?[^.\n]{0,20}(?:to|http)|post[^.\n]{0,20}https?:\/\/|curl[^.\n]{0,20}https?:\/\/)/i,
    reason: 'prompt-injection: data-exfiltration attempt',
  },
  {
    re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
    reason: 'prompt-injection: suspicious base64 blob',
  },
  {
    // zero-width (200B-200F), bidi embedding/override (202A-202E),
    // word-joiner / invisible-operator / bidi-isolate (2060-206F) and
    // BOM / ZWNBSP (FEFF) — invisible control characters used to smuggle text.
    re: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/,
    reason: 'prompt-injection: hidden unicode control characters',
  },
];

/**
 * Scan `text` for known prompt-injection / tool-poisoning signals. Returns one
 * stable reason string per distinct pattern that fires, in declaration order;
 * an empty array means no signal. Deterministic and heuristic (no LLM).
 */
export function scanPromptInjection(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }
  const hits: string[] = [];
  for (const { re, reason } of INJECTION_PATTERNS) {
    if (re.test(text)) {
      hits.push(reason);
    }
  }
  return hits;
}

// --- default policy ---------------------------------------------------------

/**
 * The canonical, safe-by-default firewall policy: read-family scopes run
 * unattended, mutating/deploying/deleting scopes pause for approval, and the
 * three catastrophic scopes are denied outright. Callers may broaden or tighten
 * it and persist the result with {@link savePolicy}.
 */
export function defaultPolicy(): McpPolicy {
  return {
    allow: [
      '*.read',
      '*.read_*',
      '*.readonly',
      '*.list',
      '*.list_*',
      '*.get',
      '*.get_*',
      '*.search',
      '*.search_*',
      '*.describe',
      '*.status',
    ],
    requireApproval: [
      '*.write',
      '*.write_*',
      '*.update',
      '*.update_*',
      '*.create',
      '*.create_*',
      '*.delete',
      '*.delete_*',
      '*.remove',
      '*.deploy',
      '*.deploy_*',
      '*.push',
      '*.publish',
      '*.merge',
    ],
    deny: ['shell.rm', 'repo.delete', 'secrets.read_all'],
    budgets: {},
    dryRun: false,
  };
}

// --- policy persistence ------------------------------------------------------

/**
 * Load and validate the firewall policy from
 * `.cortex/policies/mcp-firewall.json`. Returns {@link defaultPolicy} when no
 * policy file exists yet (a fresh workspace is governed by the safe defaults).
 *
 * @throws SchemaValidationError when the file exists but is not valid JSON or
 *   fails {@link McpPolicySchema}.
 * @throws DevCortexError `INTERNAL` on unexpected I/O failure.
 */
export async function loadPolicy(root: string): Promise<McpPolicy> {
  const { mcpFirewallPolicy } = workspacePaths(root);

  let raw: string;
  try {
    raw = await readFile(mcpFirewallPolicy, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return defaultPolicy();
    }
    throw new DevCortexError('INTERNAL', `Unable to read firewall policy at ${mcpFirewallPolicy}.`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SchemaValidationError(
      `The firewall policy at ${mcpFirewallPolicy} is not valid JSON.`,
      { cause: err },
    );
  }

  const result = McpPolicySchema.safeParse(parsed);
  if (!result.success) {
    throw new SchemaValidationError(
      `The firewall policy at ${mcpFirewallPolicy} failed schema validation.`,
      { details: result.error.issues, cause: result.error },
    );
  }
  return result.data;
}

/**
 * Validate and atomically persist `policy` to
 * `.cortex/policies/mcp-firewall.json`.
 *
 * The policy is validated against {@link McpPolicySchema} before any I/O, so a
 * malformed object never reaches disk; the bytes are then written to a uniquely
 * named temp file in the same directory and `rename`d over the target. Because
 * `rename` is atomic within a filesystem, a concurrent reader (or a crash
 * mid-write) always sees either the previous or the new complete policy.
 *
 * @throws SchemaValidationError when `policy` fails {@link McpPolicySchema}.
 * @throws DevCortexError `INTERNAL` when the file cannot be written.
 */
export async function savePolicy(root: string, policy: McpPolicy): Promise<void> {
  const { mcpFirewallPolicy, policiesDir } = workspacePaths(root);

  const result = McpPolicySchema.safeParse(policy);
  if (!result.success) {
    throw new SchemaValidationError('Refusing to write an invalid firewall policy.', {
      details: result.error.issues,
      cause: result.error,
    });
  }

  const tmp = path.join(policiesDir, `.mcp-firewall.${randomUUID()}.tmp`);
  try {
    await mkdir(policiesDir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(result.data, null, 2)}\n`, 'utf8');
    await rename(tmp, mcpFirewallPolicy);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new DevCortexError('INTERNAL', `Unable to write firewall policy to ${mcpFirewallPolicy}.`, {
      cause: err,
    });
  }
}

// --- evaluation --------------------------------------------------------------

/**
 * Produce a firewall verdict for a single tool call against `policy`.
 *
 * Decision order (deny is absolute): a `deny` match blocks; otherwise an
 * `allow` match permits; otherwise (an explicit `require-approval` match, or no
 * match at all) the call pauses for approval. An `allow` verdict is escalated to
 * `require-approval` when the args carry a prompt-injection signal or the
 * computed risk score is elevated.
 *
 * The stringified args are scanned for prompt-injection (raising the risk score
 * and adding reasons) and run through the redaction engine; the masked form is
 * returned as `redactedArgs` whenever arguments were supplied, so a caller can
 * log the verdict without leaking secrets.
 *
 * @throws SchemaValidationError when `policy` is malformed or the call is
 *   missing a server/tool identifier.
 */
export function evaluateToolCall(policy: McpPolicy, call: ToolCall): ToolCallEval {
  const validated = McpPolicySchema.safeParse(policy);
  if (!validated.success) {
    throw new SchemaValidationError('Cannot evaluate a tool call against an invalid policy.', {
      details: validated.error.issues,
      cause: validated.error,
    });
  }
  const effectivePolicy = validated.data;

  if (!call || typeof call.server !== 'string' || call.server.length === 0) {
    throw new SchemaValidationError('A tool call must carry a non-empty server id.');
  }
  if (typeof call.tool !== 'string' || call.tool.length === 0) {
    throw new SchemaValidationError('A tool call must carry a non-empty tool name.');
  }

  const identifier = `${call.server}.${call.tool}`;
  const toolLower = call.tool.toLowerCase();
  const idLower = identifier.toLowerCase();
  const reasons: string[] = [];

  // --- stringify + scan + redact the arguments ------------------------------
  const hasArgs = call.args !== undefined;
  const argsStr = hasArgs ? safeStringify(call.args) : '';
  const argsLower = argsStr.toLowerCase();

  const injectionHits = hasArgs ? scanPromptInjection(argsStr) : [];
  const redaction = hasArgs ? redactText(argsStr) : undefined;
  const secretsInArgs = (redaction?.findings.length ?? 0) > 0;

  // --- risk score -----------------------------------------------------------
  let risk = 0;
  const destructive = matchesVerb(toolLower, DESTRUCTIVE_VERBS);
  const write = matchesVerb(toolLower, WRITE_VERBS);
  const secretAccess = SECRET_MARKERS.some((m) => idLower.includes(m));
  const network =
    NETWORK_MARKERS.some((m) => idLower.includes(m)) ||
    NETWORK_MARKERS.some((m) => argsLower.includes(m));

  if (destructive) {
    risk += RISK.destructive;
    reasons.push(`destructive verb in tool "${call.tool}"`);
  }
  if (write && !destructive) {
    risk += RISK.write;
    reasons.push(`write/mutating operation "${call.tool}"`);
  }
  if (secretAccess) {
    risk += RISK.secretAccess;
    reasons.push('tool scope touches secrets/credentials');
  }
  if (network) {
    risk += RISK.network;
    reasons.push('network/exfiltration surface present');
  }
  for (const hit of injectionHits) {
    risk += RISK.perInjection;
    reasons.push(hit);
  }
  if (secretsInArgs) {
    risk += RISK.secretsInArgs;
    reasons.push('arguments contain secrets (masked in redactedArgs)');
  }
  const riskScore = clamp(risk, 0, 100);

  // --- rule matching (deny > allow > require-approval) ----------------------
  let decision: FirewallDecision;
  if (matchesAny(effectivePolicy.deny, identifier, call.tool)) {
    decision = 'deny';
    reasons.unshift(`blocked: matched a deny rule for "${identifier}"`);
  } else if (matchesAny(effectivePolicy.allow, identifier, call.tool)) {
    decision = 'allow';
    // Fail toward a human: an allowed call still pauses when it carries an
    // injection signal or scores as high-risk.
    if (injectionHits.length > 0) {
      decision = 'require-approval';
      reasons.unshift('escalated to approval: prompt-injection signal in arguments');
    } else if (riskScore >= RISK_ESCALATION_THRESHOLD) {
      decision = 'require-approval';
      reasons.unshift(`escalated to approval: elevated risk score (${riskScore})`);
    } else {
      reasons.unshift(`allowed: matched an allow rule for "${identifier}"`);
    }
  } else if (matchesAny(effectivePolicy.requireApproval, identifier, call.tool)) {
    decision = 'require-approval';
    reasons.unshift(`requires approval: matched a require-approval rule for "${identifier}"`);
  } else {
    decision = 'require-approval';
    reasons.unshift(`requires approval: no allow rule matched "${identifier}"`);
  }

  if (effectivePolicy.dryRun && decision === 'allow') {
    reasons.push('dry-run: allowed call is rehearsed without side effects');
  }

  const evaluation: ToolCallEval = {
    decision,
    reasons: dedupe(reasons),
    riskScore,
  };
  if (redaction !== undefined) {
    evaluation.redactedArgs = redaction.redacted;
  }
  return evaluation;
}

// --- internals --------------------------------------------------------------

/**
 * Does `value` match any glob pattern in `patterns`? A `*` in a pattern matches
 * any run of characters; every other character (including `.`) is literal.
 * Patterns are tested against both the full `server.tool` identifier and the
 * bare tool name, case-insensitively.
 */
function matchesAny(patterns: readonly string[], identifier: string, tool: string): boolean {
  return patterns.some((pattern) => globMatch(pattern, identifier) || globMatch(pattern, tool));
}

/** Compile a `*`-glob to an anchored, case-insensitive RegExp and test it. */
function globMatch(pattern: string, value: string): boolean {
  const source = pattern.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}

/** Escape every RegExp metacharacter so the fragment matches literally. */
function escapeRegExp(fragment: string): string {
  return fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word verb match. Treats any non-lowercase-letter (so `_`, `-`, `.`,
 * digits, boundaries) as a separator, so `rm` matches `shell_rm` / `rm_file`
 * but never `transform`, and `del` matches `del_branch` but never `model`.
 */
function matchesVerb(haystack: string, verbs: readonly string[]): boolean {
  return verbs.some((verb) => new RegExp(`(?:^|[^a-z])${verb}(?:[^a-z]|$)`).test(haystack));
}

/** Clamp `value` into `[min, max]` and round to an integer. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Order-preserving de-duplication of reason strings. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Best-effort stable stringification of arbitrary tool arguments. `JSON.stringify`
 * can throw (circular references) or drop values (`BigInt`); on any failure we
 * fall back to `String(value)` so scanning/redaction still runs over *some*
 * textual form rather than crashing the firewall.
 */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    const json = JSON.stringify(value, (_key: string, val: unknown) =>
      typeof val === 'bigint' ? val.toString() : val,
    );
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/** Narrow an unknown thrown value to a Node `errno` exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
