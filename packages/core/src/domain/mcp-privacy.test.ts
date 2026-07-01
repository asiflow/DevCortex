/**
 * Sub-project #5 domain-contract test — MCP governance & privacy (§7.19-7.20 + §7.22).
 *
 * The two persisted artifacts (McpServerSpec at `.cortex/mcp/<id>.json`,
 * McpPolicy at `.cortex/policies/mcp-firewall.json`) are read back from disk as
 * untrusted input, so their zod schemas are the trust boundary: this suite
 * proves they ACCEPT well-formed documents and REJECT malformed ones. The
 * const-tuple enums are load-bearing (they key firewall dispatch, trust posture,
 * and the redaction detector set), so their membership + order are asserted. The
 * computed (non-persisted) artifacts — ToolCallEval, RedactionResult,
 * OutboundManifest — are exercised at the interface level via representative
 * fixtures, mirroring the gates-ext / council contract tests.
 */
import { describe, expect, it } from 'vitest';

import {
  FIREWALL_DECISIONS,
  MCP_ACCESS,
  MCP_TRUST,
  McpPolicySchema,
  McpServerSpecSchema,
  REDACTION_KINDS,
} from './index';
import type {
  FirewallDecision,
  McpAccess,
  McpPolicy,
  McpServerSpec,
  McpTrust,
  OutboundManifest,
  RedactionKind,
  RedactionResult,
  ToolCallEval,
} from './index';

// --- const tuples -----------------------------------------------------------

describe('MCP + privacy enums', () => {
  it('exposes the trust tiers in deterministic order', () => {
    expect(MCP_TRUST).toEqual(['trusted', 'community', 'unknown']);
    expect(new Set(MCP_TRUST).size).toBe(MCP_TRUST.length);
  });

  it('exposes read/write access', () => {
    expect(MCP_ACCESS).toEqual(['read', 'write']);
    expect(new Set(MCP_ACCESS).size).toBe(MCP_ACCESS.length);
  });

  it('exposes the three firewall decisions in deterministic order', () => {
    expect(FIREWALL_DECISIONS).toEqual(['allow', 'deny', 'require-approval']);
    expect(new Set(FIREWALL_DECISIONS).size).toBe(FIREWALL_DECISIONS.length);
  });

  it('exposes every redaction kind from §7.22 with no duplicates', () => {
    expect(REDACTION_KINDS).toEqual([
      'api-key',
      'secret',
      'token',
      'private-key',
      'password',
      'env',
      'db-url',
      'pii-email',
      'pii-phone',
    ]);
    expect(new Set(REDACTION_KINDS).size).toBe(REDACTION_KINDS.length);
  });

  it('narrows every member to its branded type', () => {
    for (const trust of MCP_TRUST) {
      const narrowed: McpTrust = trust;
      expect(typeof narrowed).toBe('string');
    }
    for (const access of MCP_ACCESS) {
      const narrowed: McpAccess = access;
      expect(typeof narrowed).toBe('string');
    }
    for (const decision of FIREWALL_DECISIONS) {
      const narrowed: FirewallDecision = decision;
      expect(typeof narrowed).toBe('string');
    }
    for (const kind of REDACTION_KINDS) {
      const narrowed: RedactionKind = kind;
      expect(typeof narrowed).toBe('string');
    }
  });
});

// --- McpServerSpecSchema (persisted, §7.19) ---------------------------------

const validSpec: McpServerSpec = {
  id: 'github',
  name: 'GitHub MCP',
  source: 'npm:@modelcontextprotocol/server-github',
  trust: 'community',
  permissions: ['github.read', 'github.write'],
  tools: [
    { name: 'search_issues', access: 'read', destructive: false },
    { name: 'delete_branch', access: 'write', destructive: true },
  ],
  secretsRequired: ['GITHUB_TOKEN'],
  sandbox: true,
  installCommand: 'npx -y @modelcontextprotocol/server-github',
  note: 'Rollback: remove from .mcp.json; audit log at .cortex/mcp/github.audit.jsonl',
};

describe('McpServerSpecSchema (persisted .cortex/mcp/<id>.json)', () => {
  it('accepts a well-formed spec and round-trips it byte-for-byte', () => {
    const parsed = McpServerSpecSchema.parse(validSpec);
    expect(parsed).toEqual(validSpec);
  });

  it('accepts a spec with the optional installCommand omitted', () => {
    const { installCommand: _omit, ...withoutInstall } = validSpec;
    const result = McpServerSpecSchema.safeParse(withoutInstall);
    expect(result.success).toBe(true);
  });

  it('rejects an unknown trust tier', () => {
    const result = McpServerSpecSchema.safeParse({ ...validSpec, trust: 'first-party' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown capability access value', () => {
    const result = McpServerSpecSchema.safeParse({
      ...validSpec,
      tools: [{ name: 'x', access: 'execute', destructive: false }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field (note)', () => {
    const { note: _drop, ...withoutNote } = validSpec;
    const result = McpServerSpecSchema.safeParse(withoutNote);
    expect(result.success).toBe(false);
  });

  it('rejects a mistyped permissions field', () => {
    const result = McpServerSpecSchema.safeParse({ ...validSpec, permissions: 'github.read' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean destructive flag on a tool', () => {
    const result = McpServerSpecSchema.safeParse({
      ...validSpec,
      tools: [{ name: 'x', access: 'write', destructive: 'yes' }],
    });
    expect(result.success).toBe(false);
  });
});

// --- McpPolicySchema (persisted, §7.20) -------------------------------------

const validPolicy: McpPolicy = {
  allow: ['github.read', 'browser.read'],
  requireApproval: ['github.write', 'vercel.deploy', 'database.write'],
  deny: ['shell.rm', 'repo.delete', 'secrets.read_all'],
  budgets: { 'github.write': 5, 'vercel.deploy': 1 },
  dryRun: false,
};

describe('McpPolicySchema (persisted .cortex/policies/mcp-firewall.json)', () => {
  it('accepts a well-formed policy and round-trips it', () => {
    const parsed = McpPolicySchema.parse(validPolicy);
    expect(parsed).toEqual(validPolicy);
  });

  it('accepts an empty policy (no rules, no budgets)', () => {
    const empty: McpPolicy = {
      allow: [],
      requireApproval: [],
      deny: [],
      budgets: {},
      dryRun: true,
    };
    expect(McpPolicySchema.safeParse(empty).success).toBe(true);
  });

  it('rejects a non-numeric budget value', () => {
    const result = McpPolicySchema.safeParse({
      ...validPolicy,
      budgets: { 'github.write': 'unlimited' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing dryRun flag', () => {
    const { dryRun: _drop, ...withoutDryRun } = validPolicy;
    const result = McpPolicySchema.safeParse(withoutDryRun);
    expect(result.success).toBe(false);
  });

  it('rejects a mistyped deny list', () => {
    const result = McpPolicySchema.safeParse({ ...validPolicy, deny: 'shell.rm' });
    expect(result.success).toBe(false);
  });
});

// --- computed artifacts (types-only, no persistence) ------------------------

describe('computed firewall + privacy artifacts', () => {
  it('models a ToolCallEval verdict with a 0-100 risk score', () => {
    const evalResult: ToolCallEval = {
      decision: 'require-approval',
      reasons: ['destructive tool delete_branch', 'trust tier is community'],
      riskScore: 72,
      redactedArgs: '{"branch":"main","token":"[REDACTED:token]"}',
    };
    expect(evalResult.riskScore).toBeGreaterThanOrEqual(0);
    expect(evalResult.riskScore).toBeLessThanOrEqual(100);
    expect(FIREWALL_DECISIONS).toContain(evalResult.decision);
  });

  it('models a RedactionResult tally', () => {
    const result: RedactionResult = {
      redacted: 'export KEY=[REDACTED:api-key]',
      findings: [{ kind: 'api-key', count: 1 }],
    };
    expect(result.findings.every((f) => REDACTION_KINDS.includes(f.kind))).toBe(true);
    expect(result.findings.every((f) => f.count >= 1)).toBe(true);
  });

  it('models an OutboundManifest whose totalBytes sums its files', () => {
    const manifest: OutboundManifest = {
      mode: 'deep-cloud',
      files: [
        { path: 'src/app/page.tsx', reason: 'error occurs here', sizeBytes: 1200, redacted: true },
        { path: 'src/lib/db.ts', reason: 'imported by the failing route', sizeBytes: 800, redacted: true },
      ],
      totalBytes: 2000,
      retention: 'ephemeral',
      optOut: false,
    };
    const summed = manifest.files.reduce((acc, f) => acc + f.sizeBytes, 0);
    expect(summed).toBe(manifest.totalBytes);
    expect(manifest.files.every((f) => f.redacted)).toBe(true);
  });

  it('models an empty local-only manifest (nothing leaves the machine)', () => {
    const manifest: OutboundManifest = {
      mode: 'local-only',
      files: [],
      totalBytes: 0,
      retention: 'none',
      optOut: true,
    };
    expect(manifest.files).toHaveLength(0);
    expect(manifest.totalBytes).toBe(0);
  });
});
