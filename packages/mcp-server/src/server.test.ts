/**
 * Contract test for the DevCortex stdio MCP server.
 *
 * Strategy (design spec §9 — "Contract: MCP tool I/O shapes"): stand up the
 * real server bound to a freshly-created temp Next.js workspace, connect a real
 * MCP `Client` over the SDK's in-memory linked transport (no process spawn, no
 * mocking), then assert:
 *   1. `tools/list` returns exactly the expected `cortex.*` tool set.
 *   2. `cortex.get_project_brief` round-trips the generated brief through the
 *      MCP boundary verbatim (deterministic file read).
 *   3. `cortex.classify_task_risk` returns a valid RiskClassification computed
 *      against the scanned graph (real engine output, not a fixture).
 *   4. `cortex.update_memory` persists a real ledger entry under `.cortex/`.
 *   5. `resolveRoot` honors --root / DEVCORTEX_ROOT / cwd precedence.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  FIREWALL_DECISIONS,
  MCP_TRUST,
  REDACTION_KINDS,
  RISK_LEVELS,
  TASK_TYPES,
  WORKFLOW_IDS,
} from '@devcortex/core';

import { CORTEX_TOOL_NAMES, createServer, resolveRoot } from './server';

const PROJECT_BRIEF = '# Sample Next App\n\nA tiny Next.js App Router project used for the MCP contract test.\n';

let root: string;
let server: ReturnType<typeof createServer>;
let client: Client;

/** Materialize a minimal-but-real Next.js App Router repo + a generated brief. */
async function createFixtureWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'devcortex-mcp-'));

  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'sample-next-app',
        version: '0.0.0',
        private: true,
        scripts: { build: 'next build', test: 'echo ok' },
        dependencies: { next: '^15.1.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await mkdir(path.join(dir, 'app', 'api', 'health'), { recursive: true });
  await writeFile(
    path.join(dir, 'app', 'page.tsx'),
    'export default function Page() {\n  return <main>Home</main>;\n}\n',
    'utf8',
  );
  await writeFile(
    path.join(dir, 'app', 'api', 'health', 'route.ts'),
    "export function GET() {\n  return Response.json({ ok: true });\n}\n",
    'utf8',
  );

  await writeFile(
    path.join(dir, 'middleware.ts'),
    "import { NextResponse } from 'next/server';\n\nexport function middleware() {\n  // auth gate\n  return NextResponse.next();\n}\n",
    'utf8',
  );

  await mkdir(path.join(dir, 'lib'), { recursive: true });
  await writeFile(
    path.join(dir, 'lib', 'auth.ts'),
    'export function getSession() {\n  return null;\n}\n',
    'utf8',
  );

  await writeFile(path.join(dir, '.env.example'), 'NEXT_PUBLIC_APP_URL=\nDATABASE_URL=\n', 'utf8');

  // A generated project brief so get_project_brief has something to return.
  await mkdir(path.join(dir, '.cortex'), { recursive: true });
  await writeFile(path.join(dir, '.cortex', 'project.md'), PROJECT_BRIEF, 'utf8');

  return dir;
}

/** Parse the JSON text content from a tool result, asserting it is not an error. */
function readToolJson(result: unknown): unknown {
  const r = result as { content?: unknown; isError?: boolean };
  expect(r.isError ?? false).toBe(false);
  const content = r.content as Array<{ type: string; text?: string }> | undefined;
  const first = content?.[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected a single text content block');
  }
  return JSON.parse(first.text);
}

beforeAll(async () => {
  root = await createFixtureWorkspace();
  server = createServer(root);
  client = new Client({ name: 'devcortex-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('resolveRoot', () => {
  it('prefers --root <dir> over env and cwd', () => {
    const resolved = resolveRoot(['--root', '/tmp/explicit'], { DEVCORTEX_ROOT: '/tmp/env' }, '/tmp/cwd');
    expect(resolved).toBe(path.resolve('/tmp/explicit'));
  });

  it('supports --root=<dir>', () => {
    expect(resolveRoot(['--root=/tmp/eq'], {}, '/tmp/cwd')).toBe(path.resolve('/tmp/eq'));
  });

  it('falls back to DEVCORTEX_ROOT then cwd', () => {
    expect(resolveRoot([], { DEVCORTEX_ROOT: '/tmp/env' }, '/tmp/cwd')).toBe(path.resolve('/tmp/env'));
    expect(resolveRoot([], {}, '/tmp/cwd')).toBe(path.resolve('/tmp/cwd'));
  });

  it('throws when --root has no value', () => {
    expect(() => resolveRoot(['--root'], {}, '/tmp/cwd')).toThrow(/--root requires/);
  });
});

describe('MCP server contract', () => {
  it('tools/list returns exactly the cortex.* tool set', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...CORTEX_TOOL_NAMES].sort());
    expect(names).toHaveLength(36);
    // The sub-project #2 intelligence tools are advertised.
    for (const name of [
      'cortex.recommend_skill',
      'cortex.install_skill',
      'cortex.list_workflows',
      'cortex.run_workflow',
      'cortex.explain_failure',
      'cortex.create_regression_check',
      'cortex.generate_next_prompt',
      'cortex.check_best_practices',
    ]) {
      expect(names).toContain(name);
    }
    // The sub-project #4 deep quality gate tools are advertised.
    for (const name of [
      'cortex.run_ui_gate',
      'cortex.run_security_gate',
      'cortex.run_devops_gate',
      'cortex.run_product_gate',
      'cortex.run_premium_ui_gate',
    ]) {
      expect(names).toContain(name);
    }
    // The sub-project #5 MCP governance + privacy tools are advertised.
    for (const name of [
      'cortex.recommend_mcp',
      'cortex.install_mcp_safely',
      'cortex.evaluate_tool_call',
      'cortex.redact_text',
    ]) {
      expect(names).toContain(name);
    }
    // Every tool advertises an object input schema.
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('cortex.get_project_brief round-trips the generated brief', async () => {
    const result = await client.callTool({ name: 'cortex.get_project_brief', arguments: {} });
    const brief = readToolJson(result) as { exists: boolean; markdown: string | null; path: string };
    expect(brief.exists).toBe(true);
    expect(brief.markdown).toBe(PROJECT_BRIEF);
    expect(brief.path).toBe(path.join(root, '.cortex', 'project.md'));
  });

  it('cortex.classify_task_risk returns a valid RiskClassification', async () => {
    const result = await client.callTool({
      name: 'cortex.classify_task_risk',
      arguments: { task: 'add subscription billing' },
    });
    const risk = readToolJson(result) as {
      riskLevel: string;
      taskType: string;
      signals: unknown;
      rationale: unknown;
    };
    expect(RISK_LEVELS).toContain(risk.riskLevel);
    expect(TASK_TYPES).toContain(risk.taskType);
    expect(Array.isArray(risk.signals)).toBe(true);
    expect(typeof risk.rationale).toBe('string');
    // Billing carries a high risk floor in the default policy.
    expect(risk.taskType).toBe('billing');
    expect(['high', 'critical']).toContain(risk.riskLevel);
  });

  it('cortex.update_memory persists a real ledger entry', async () => {
    const result = await client.callTool({
      name: 'cortex.update_memory',
      arguments: {
        type: 'decision',
        title: 'Use Stripe for billing',
        summary: 'Subscriptions handled server-side via Stripe Billing.',
        source: 'contract-test',
        confidence: 0.9,
        riskLevel: 'high',
      },
    });
    const payload = readToolJson(result) as { action: string; memory: { id: string; type: string } };
    expect(payload.action).toBe('added');
    expect(payload.memory.type).toBe('decision');
    expect(payload.memory.id).toMatch(/[0-9a-f-]{36}/);

    const files = await readdir(path.join(root, '.cortex', 'memory'));
    expect(files).toContain(`${payload.memory.id}.json`);
  });

  it('cortex.list_workflows returns the full, correctly-shaped workflow set', async () => {
    const result = await client.callTool({ name: 'cortex.list_workflows', arguments: {} });
    const payload = readToolJson(result) as {
      count: number;
      workflows: Array<{ id: string; name: string; stages: unknown }>;
      selected?: unknown;
    };
    expect(payload.count).toBe(WORKFLOW_IDS.length);
    expect(payload.workflows).toHaveLength(WORKFLOW_IDS.length);
    for (const workflow of payload.workflows) {
      expect(WORKFLOW_IDS).toContain(workflow.id);
      expect(typeof workflow.name).toBe('string');
      expect(Array.isArray(workflow.stages)).toBe(true);
    }
    // No selection without both taskType + risk.
    expect(payload.selected).toBeUndefined();
  });

  it('cortex.list_workflows selects a workflow when given taskType + risk', async () => {
    const result = await client.callTool({
      name: 'cortex.list_workflows',
      arguments: { taskType: 'billing', risk: 'high' },
    });
    const payload = readToolJson(result) as { selected?: { id: string } };
    expect(payload.selected).toBeDefined();
    expect(WORKFLOW_IDS).toContain(payload.selected?.id);
  });

  it('cortex.check_best_practices returns stack-derived rules for the fixture', async () => {
    const result = await client.callTool({
      name: 'cortex.check_best_practices',
      arguments: { task: 'add subscription billing' },
    });
    const payload = readToolJson(result) as {
      stack: unknown;
      matchedPackIds: string[];
      packs: Array<{ id: string; bestPractices: unknown[]; antiPatterns: unknown[] }>;
      relevantRuleIds?: string[];
    };
    expect(payload.stack).toBeTruthy();
    expect(Array.isArray(payload.matchedPackIds)).toBe(true);
    // The Next.js App Router fixture matches at least the Next.js pack.
    expect(payload.matchedPackIds).toContain('nextjs-typescript');
    const nextjs = payload.packs.find((pack) => pack.id === 'nextjs-typescript');
    expect(nextjs?.bestPractices.length ?? 0).toBeGreaterThan(0);
    // A task was supplied, so relevance flagging is present (an array).
    expect(Array.isArray(payload.relevantRuleIds)).toBe(true);
  });

  it('cortex.explain_failure returns an empty set on a repo with no recurring failures', async () => {
    const result = await client.callTool({ name: 'cortex.explain_failure', arguments: {} });
    const payload = readToolJson(result) as { count: number; failures: unknown[] };
    expect(payload.count).toBe(0);
    expect(payload.failures).toEqual([]);
  });

  it('cortex.run_ui_gate returns a GateResult + evidence for the fixture', async () => {
    const result = await client.callTool({ name: 'cortex.run_ui_gate', arguments: {} });
    const payload = readToolJson(result) as {
      result: { gate: string; passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> };
      evidence: Array<{ id: string; claim: string; status: string }>;
    };
    expect(payload.result.gate).toBe('ui');
    expect(typeof payload.result.passed).toBe('boolean');
    expect(Array.isArray(payload.result.checks)).toBe(true);
    expect(payload.result.checks.length).toBeGreaterThan(0);
    for (const check of payload.result.checks) {
      expect(typeof check.name).toBe('string');
      expect(typeof check.passed).toBe('boolean');
      expect(typeof check.detail).toBe('string');
    }
    expect(Array.isArray(payload.evidence)).toBe(true);
  });

  it('cortex.run_premium_ui_gate returns a scored UiQualityScore for the fixture', async () => {
    const result = await client.callTool({ name: 'cortex.run_premium_ui_gate', arguments: {} });
    const score = readToolJson(result) as {
      visualHierarchy: number;
      mobileResponsiveness: number;
      spacingConsistency: number;
      accessibility: number;
      premiumFeel: number;
      overall: number;
      topFixes: string[];
    };
    for (const dimension of [
      score.visualHierarchy,
      score.mobileResponsiveness,
      score.spacingConsistency,
      score.accessibility,
      score.premiumFeel,
      score.overall,
    ]) {
      expect(typeof dimension).toBe('number');
      expect(dimension).toBeGreaterThanOrEqual(0);
      expect(dimension).toBeLessThanOrEqual(100);
    }
    expect(Array.isArray(score.topFixes)).toBe(true);
  });

  it('cortex.run_security_gate accepts a per-call root override', async () => {
    const result = await client.callTool({
      name: 'cortex.run_security_gate',
      arguments: { root },
    });
    const payload = readToolJson(result) as { result: { gate: string; checks: unknown[] } };
    expect(payload.result.gate).toBe('security');
    expect(Array.isArray(payload.result.checks)).toBe(true);
  });

  it('cortex.recommend_mcp ranks catalog servers for a task + the scanned graph', async () => {
    const result = await client.callTool({
      name: 'cortex.recommend_mcp',
      arguments: { task: 'add stripe subscription billing with webhooks', limit: 5 },
    });
    const payload = readToolJson(result) as {
      task: string;
      count: number;
      recommendations: Array<{ id: string; trust: string; tools: unknown[]; sandbox: boolean }>;
    };
    expect(payload.task).toBe('add stripe subscription billing with webhooks');
    expect(payload.count).toBe(payload.recommendations.length);
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.count).toBeLessThanOrEqual(5);
    for (const spec of payload.recommendations) {
      expect(typeof spec.id).toBe('string');
      expect(MCP_TRUST).toContain(spec.trust);
      expect(Array.isArray(spec.tools)).toBe(true);
      expect(typeof spec.sandbox).toBe('boolean');
    }
    // A stripe-billing task should surface the vetted stripe server.
    expect(payload.recommendations.some((spec) => spec.id === 'stripe-docs')).toBe(true);
  });

  it('cortex.install_mcp_safely installs a catalog server read-only + records its spec', async () => {
    const result = await client.callTool({
      name: 'cortex.install_mcp_safely',
      arguments: { id: 'filesystem' },
    });
    const payload = readToolJson(result) as {
      status: string;
      plan: { id: string; posture: string; wouldOverwrite: boolean };
    };
    expect(payload.status).toBe('installed');
    expect(payload.plan.id).toBe('filesystem');
    expect(payload.plan.posture).toBe('read-only');
    expect(payload.plan.wouldOverwrite).toBe(false);

    // The read-only-posture entry is written to .mcp.json and the spec recorded.
    const mcpDirFiles = await readdir(path.join(root, '.cortex', 'mcp'));
    expect(mcpDirFiles).toContain('filesystem.json');
  });

  it('cortex.install_mcp_safely refuses an unknown (uncatalogued) server id', async () => {
    const result = await client.callTool({
      name: 'cortex.install_mcp_safely',
      arguments: { id: 'totally-made-up-server' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const body = JSON.parse(content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(body.error?.code).toBe('POLICY_VIOLATION');
  });

  it('cortex.evaluate_tool_call returns a firewall verdict against the default policy', async () => {
    const result = await client.callTool({
      name: 'cortex.evaluate_tool_call',
      arguments: { server: 'github', tool: 'delete_branch', args: { branch: 'main' } },
    });
    const payload = readToolJson(result) as {
      server: string;
      tool: string;
      decision: string;
      reasons: string[];
      riskScore: number;
      redactedArgs?: string;
    };
    expect(payload.server).toBe('github');
    expect(payload.tool).toBe('delete_branch');
    expect(FIREWALL_DECISIONS).toContain(payload.decision);
    // A destructive delete is never silently allowed by the safe-default policy.
    expect(payload.decision).not.toBe('allow');
    expect(Array.isArray(payload.reasons)).toBe(true);
    expect(payload.reasons.length).toBeGreaterThan(0);
    expect(payload.riskScore).toBeGreaterThanOrEqual(0);
    expect(payload.riskScore).toBeLessThanOrEqual(100);
  });

  it('cortex.redact_text masks secrets and tallies them by kind', async () => {
    const result = await client.callTool({
      name: 'cortex.redact_text',
      arguments: {
        text: 'export STRIPE_SECRET_KEY=sk_' + 'live_abc123DEF456ghi789JKL012mno345PQ and email dev@example.com',
      },
    });
    const payload = readToolJson(result) as {
      redacted: string;
      findings: Array<{ kind: string; count: number }>;
    };
    // The live secret value never survives redaction.
    expect(payload.redacted).not.toContain('sk_' + 'live_abc123DEF456ghi789JKL012mno345PQ');
    expect(Array.isArray(payload.findings)).toBe(true);
    expect(payload.findings.length).toBeGreaterThan(0);
    for (const finding of payload.findings) {
      expect(REDACTION_KINDS).toContain(finding.kind);
      expect(finding.count).toBeGreaterThan(0);
    }
  });

  it('reports tool failures as structured isError results, not transport crashes', async () => {
    const result = await client.callTool({
      name: 'cortex.update_memory',
      // Missing required add fields and no id => SchemaValidationError surfaced.
      arguments: { title: 'incomplete' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const body = JSON.parse(content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(body.error?.code).toBe('SCHEMA_VALIDATION');
  });
});
