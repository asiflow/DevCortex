// ============================================================================
// CLI integration tests.
//
// These build the REAL binary with tsup and run it as a child process against a
// throwaway copy of fixtures/sample-next-app. No mocks: init scans the real
// repo, the gate runs real `npm run …` commands, ledgers hit the real disk.
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(here, '..');
const repoRoot = path.resolve(cliDir, '..', '..');
const cliEntry = path.join(cliDir, 'dist', 'cli.js');
const fixtureDir = path.join(repoRoot, 'fixtures', 'sample-next-app');

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], input?: string): CliRun {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Flip the operating mode in an initialized workspace's config.yaml. */
function setMode(dir: string, mode: 'passive' | 'guarded' | 'autopilot'): void {
  const configPath = path.join(dir, '.cortex', 'config.yaml');
  const next = readFileSync(configPath, 'utf8').replace(/mode:\s*\w+/, `mode: ${mode}`);
  writeFileSync(configPath, next, 'utf8');
}

/** A Claude Code PreToolUse / PostToolUse hook payload (stdin JSON). */
function hookPayload(event: string, toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ hook_event_name: event, tool_name: toolName, tool_input: toolInput });
}

const tempDirs: string[] = [];

async function freshTempDir(withFixture: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'devcortex-cli-'));
  tempDirs.push(dir);
  if (withFixture) {
    await cp(fixtureDir, dir, { recursive: true });
  }
  return dir;
}

/** A workspace that has already been `init`-ed, shared by read-side tests. */
let workspace: string;

beforeAll(async () => {
  // Build the real CLI binary (tsup) so tests exercise current source. The
  // `.bin/tsup` entry is an executable shim (shell/symlink), so run it directly
  // and let the OS resolve its interpreter — do NOT prefix it with `node`.
  const tsupBin = path.join(repoRoot, 'node_modules', '.bin', 'tsup');
  execFileSync(tsupBin, [], { cwd: cliDir, stdio: 'pipe' });
  expect(existsSync(cliEntry)).toBe(true);

  workspace = await freshTempDir(true);
  const init = runCli(['--cwd', workspace, 'init']);
  expect(init.status).toBe(0);
}, 180_000);

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('init', () => {
  it('scans the repo and writes the full .cortex/ workspace', async () => {
    const dir = await freshTempDir(true);
    const r = runCli(['--cwd', dir, 'init']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX INIT');
    expect(r.stdout).toContain('nextjs');

    for (const rel of [
      '.cortex/config.yaml',
      '.cortex/graph.json',
      '.cortex/project.md',
      '.cortex/architecture.md',
      '.cortex/quality-constitution.md',
      '.cortex/memory',
      '.cortex/features',
      '.cortex/decisions',
      '.cortex/evidence',
      '.cortex/ship-reports',
    ]) {
      expect(existsSync(path.join(dir, rel)), rel).toBe(true);
    }

    // The constitution is the real core-generated contract, not a placeholder.
    const constitution = readFileSync(path.join(dir, '.cortex/quality-constitution.md'), 'utf8');
    expect(constitution).toContain('Required gates');
    expect(constitution.length).toBeGreaterThan(200);
  });

  it('refuses to clobber an existing workspace without --force, then allows it', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);

    const second = runCli(['--cwd', dir, 'init']);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already initialized');
    expect(second.stderr).not.toMatch(/\n\s+at\s/); // no stack dump

    expect(runCli(['--cwd', dir, 'init', '--force']).status).toBe(0);
  });
});

describe('scan', () => {
  it('detects the Next.js stack and caches a graph', () => {
    const r = runCli(['--cwd', workspace, 'scan', '--json']);
    expect(r.status).toBe(0);

    const graph = JSON.parse(r.stdout) as {
      stack: { framework: string; language: string };
      stats: { fileCount: number; routeCount: number; apiCount: number };
      routes: unknown[];
    };
    expect(graph.stack.framework).toBe('nextjs');
    expect(graph.stack.language).toBe('typescript');
    expect(graph.stats.fileCount).toBeGreaterThan(0);
    expect(graph.stats.routeCount).toBeGreaterThan(0);
    expect(graph.stats.apiCount).toBeGreaterThan(0);
  });
});

describe('preflight', () => {
  it('classifies "add subscription billing" as high risk with blast radius + DoD', () => {
    const r = runCli(['--cwd', workspace, 'preflight', 'add subscription billing']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX PREFLIGHT');
    expect(r.stdout).toContain('HIGH');
    expect(r.stdout).toContain('Blast radius');
    expect(r.stdout).toContain('Definition of done');
  });

  it('emits structured JSON for hooks', () => {
    const r = runCli(['--cwd', workspace, 'preflight', 'add subscription billing', '--json']);
    expect(r.status).toBe(0);

    const payload = JSON.parse(r.stdout) as {
      risk: { riskLevel: string; taskType: string };
      blastRadius: { severity: string; requiredChecks: string[] };
      intent: { definitionOfDone: string[]; acceptanceCriteria: string[] };
      context: { markdown: string; tokenEstimate: number };
    };
    expect(payload.risk.riskLevel).toBe('high');
    expect(payload.risk.taskType).toBe('billing');
    expect(payload.intent.definitionOfDone.length).toBeGreaterThan(0);
    expect(payload.intent.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(typeof payload.context.markdown).toBe('string');
    expect(payload.context.markdown.length).toBeGreaterThan(0);
  });
});

describe('context', () => {
  it('honours a forced --level', () => {
    const r = runCli(['--cwd', workspace, 'context', '--level', 'tiny', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { context: { depth: string } };
    expect(payload.context.depth).toBe('tiny');
  });

  it('rejects an invalid --level cleanly', () => {
    const r = runCli(['--cwd', workspace, 'context', '--level', 'enormous']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid value');
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });
});

describe('verify', () => {
  it('runs the quality gate and reports a real result', () => {
    const r = runCli(['--cwd', workspace, 'verify', '--json']);
    // 0 when every required check passes, 2 when the gate fails (no node_modules
    // in the fixture copy → the configured npm scripts fail). Never 1 (internal).
    expect([0, 2]).toContain(r.status);
    const payload = JSON.parse(r.stdout) as { result: { gate: string; checks: unknown[] } };
    expect(payload.result.gate).toBe('quality');
    expect(Array.isArray(payload.result.checks)).toBe(true);
  });
});

describe('gate', () => {
  it('runs the UI gate against the detected stack and reports per-check results', () => {
    const r = runCli(['--cwd', workspace, 'gate', 'ui', '--json']);
    // Deterministic heuristics over the fixture: 0 when every required check
    // passes, 2 when a required check fails. Never 1 (internal error).
    expect([0, 2]).toContain(r.status);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      families: string[];
      results: { kind: string; family: string; gate: string; passed: boolean; checks: unknown[] }[];
    };
    expect(payload.families).toEqual(['ui']);
    expect(payload.results).toHaveLength(1);
    const ui = payload.results[0]!;
    expect(ui.kind).toBe('checks');
    expect(ui.family).toBe('ui');
    expect(ui.gate).toBe('ui');
    expect(Array.isArray(ui.checks)).toBe(true);
    expect(ui.checks.length).toBeGreaterThan(0);
    // The overall verdict mirrors the single gate's own pass/fail.
    expect(payload.ok).toBe(ui.passed);
    // exit code tracks the verdict exactly.
    expect(r.status).toBe(ui.passed ? 0 : 2);
  });

  it('renders a human CORTEX GATE report for the security gate', () => {
    const r = runCli(['--cwd', workspace, 'gate', 'security']);
    expect([0, 2]).toContain(r.status);
    expect(r.stdout).toContain('CORTEX GATE');
    expect(r.stdout).toContain('security');
    expect(r.stdout).toMatch(/PASS|FAIL/);
  });

  it('runs the security gate (JSON) and never crashes internally', () => {
    const r = runCli(['--cwd', workspace, 'gate', 'security', '--json']);
    expect([0, 2]).toContain(r.status);
    const payload = JSON.parse(r.stdout) as {
      families: string[];
      results: { family: string; gate: string; checks: { name: string }[] }[];
    };
    expect(payload.families).toEqual(['security']);
    const sec = payload.results[0]!;
    expect(sec.gate).toBe('security');
    expect(Array.isArray(sec.checks)).toBe(true);
    expect(sec.checks.length).toBeGreaterThan(0);
  });

  it('scores the premium-ui gate (dimensions + overall + topFixes) and exits 0', () => {
    // premium-ui is a score gate with no required checks → always exit 0.
    const r = runCli(['--cwd', workspace, 'gate', 'premium-ui', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      families: string[];
      results: {
        kind: string;
        family: string;
        score: {
          visualHierarchy: number;
          mobileResponsiveness: number;
          spacingConsistency: number;
          accessibility: number;
          premiumFeel: number;
          overall: number;
          topFixes: string[];
        };
      }[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.families).toEqual(['premium-ui']);
    const score = payload.results[0]!.score;
    expect(payload.results[0]!.kind).toBe('score');
    for (const dim of [
      score.visualHierarchy,
      score.mobileResponsiveness,
      score.spacingConsistency,
      score.accessibility,
      score.premiumFeel,
      score.overall,
    ]) {
      expect(typeof dim).toBe('number');
      expect(dim).toBeGreaterThanOrEqual(0);
      expect(dim).toBeLessThanOrEqual(100);
    }
    expect(Array.isArray(score.topFixes)).toBe(true);
  });

  it('renders the premium-ui score block in human output', () => {
    const r = runCli(['--cwd', workspace, 'gate', 'premium-ui']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX GATE');
    expect(r.stdout).toContain('premium-ui');
    expect(r.stdout).toContain('score');
    expect(r.stdout).toContain('visual hierarchy');
    expect(r.stdout).toContain('Top fixes');
  });

  it(
    'with no family, runs every family applicable to the detected stack',
    () => {
      // The fixture is a Next.js app with no infra artifacts: ui / security /
      // product / premium-ui apply; code applies (init resolved gate commands);
      // devops does not (no Docker / CI / k8s / Vercel / deployment target). The
      // `code` family shells out to the fixture's npm scripts (no node_modules →
      // it fails), hence the generous timeout.
      const r = runCli(['--cwd', workspace, 'gate', '--json']);
      expect([0, 2]).toContain(r.status);
      const payload = JSON.parse(r.stdout) as { families: string[]; results: { family: string }[] };
      expect(payload.families).toContain('code');
      expect(payload.families).toContain('ui');
      expect(payload.families).toContain('security');
      expect(payload.families).toContain('product');
      expect(payload.families).toContain('premium-ui');
      expect(payload.families).not.toContain('devops');
      // Families run in canonical GATE_FAMILIES order.
      expect(payload.results.map((x) => x.family)).toEqual(payload.families);
    },
    60_000,
  );

  it('rejects an unknown gate family cleanly', () => {
    const r = runCli(['--cwd', workspace, 'gate', 'nonsense']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid value');
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });
});

describe('ship', () => {
  it('produces a SHIP STATUS and writes a ship report', () => {
    const r = runCli(['--cwd', workspace, 'ship']);
    expect([0, 2]).toContain(r.status);
    expect(r.stdout).toContain('CORTEX SHIP STATUS');

    const reports = readdirSync(path.join(workspace, '.cortex', 'ship-reports'));
    expect(reports.some((f) => f.endsWith('.md'))).toBe(true);
  });

  it('emits a structured ship report under --json', () => {
    const r = runCli(['--cwd', workspace, 'ship', '--json']);
    const payload = JSON.parse(r.stdout) as {
      report: { status: string; passed: unknown[]; blocked: unknown[] };
      reportPath: string;
    };
    expect(['READY', 'READY_WITH_WARNINGS', 'NOT_READY']).toContain(payload.report.status);
    expect(payload.reportPath).toContain('ship-reports');
  });
});

describe('memory ledger', () => {
  it('adds, lists, and gets a memory item', () => {
    const add = runCli([
      '--cwd',
      workspace,
      'memory',
      'add',
      '--title',
      'Stripe runs server-side only',
      '--summary',
      'All Stripe SDK calls happen in server code; no secret key reaches the client.',
      '--type',
      'decision',
      '--risk',
      'high',
      '--json',
    ]);
    expect(add.status).toBe(0);
    const created = JSON.parse(add.stdout) as { item: { id: string; title: string; type: string } };
    expect(created.item.title).toBe('Stripe runs server-side only');
    expect(created.item.type).toBe('decision');

    const list = runCli(['--cwd', workspace, 'memory', 'list', '--json']);
    const listed = JSON.parse(list.stdout) as { count: number; items: { id: string }[] };
    expect(listed.count).toBeGreaterThanOrEqual(1);

    const get = runCli(['--cwd', workspace, 'memory', 'get', created.item.id, '--json']);
    expect(get.status).toBe(0);
    expect((JSON.parse(get.stdout) as { item: { id: string } }).item.id).toBe(created.item.id);
  });

  it('rejects an unknown memory type cleanly', () => {
    const r = runCli([
      '--cwd',
      workspace,
      'memory',
      'add',
      '--title',
      't',
      '--summary',
      's',
      '--type',
      'nonsense',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid value');
  });
});

describe('feature ledger', () => {
  it('adds and reads back a feature', () => {
    const add = runCli([
      '--cwd',
      workspace,
      'feature',
      'add',
      '--name',
      'Subscription billing',
      '--purpose',
      'Charge users on a recurring basis',
      '--user-value',
      'Access to paid tiers',
      '--status',
      'planned',
      '--route',
      '/billing',
      '--acceptance',
      'Webhook signature is verified',
      '--json',
    ]);
    expect(add.status).toBe(0);
    const created = JSON.parse(add.stdout) as { item: { id: string; feature: string; routes: string[] } };
    expect(created.item.feature).toBe('Subscription billing');
    expect(created.item.routes).toContain('/billing');

    const get = runCli(['--cwd', workspace, 'feature', 'get', created.item.id, '--json']);
    expect(get.status).toBe(0);
    expect((JSON.parse(get.stdout) as { item: { id: string } }).item.id).toBe(created.item.id);
  });
});

describe('install', () => {
  it('installs the Claude Code hooks + MCP registration into a fresh repo', async () => {
    const dir = await freshTempDir(true);
    const r = runCli(['--cwd', dir, 'install', 'claude', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { target: string; result: { status: string } };
    expect(payload.target).toBe('claude');
    expect(payload.result.status).toBe('applied');
    expect(existsSync(path.join(dir, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(true);
  });

  it('installs the Codex AGENTS.md + config.toml into a fresh repo', async () => {
    const dir = await freshTempDir(true);
    const r = runCli(['--cwd', dir, 'install', 'codex', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { target: string; result: { status: string } };
    expect(payload.target).toBe('codex');
    expect(payload.result.status).toBe('applied');
    expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(path.join(dir, '.codex', 'config.toml'))).toBe(true);
  });

  it('installs the Cursor rule (.mdc) + MCP registration into a fresh repo', async () => {
    const dir = await freshTempDir(true);
    const r = runCli(['--cwd', dir, 'install', 'cursor', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { target: string; result: { status: string } };
    expect(payload.target).toBe('cursor');
    expect(payload.result.status).toBe('applied');
    expect(existsSync(path.join(dir, '.cursor', 'rules', 'devcortex.mdc'))).toBe(true);
    expect(existsSync(path.join(dir, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('installs the VS Code tasks + MCP + settings into a fresh repo', async () => {
    const dir = await freshTempDir(true);
    const r = runCli(['--cwd', dir, 'install', 'vscode', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { target: string; result: { status: string } };
    expect(payload.target).toBe('vscode');
    expect(payload.result.status).toBe('applied');
    expect(existsSync(path.join(dir, '.vscode', 'tasks.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.vscode', 'mcp.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.vscode', 'settings.json'))).toBe(true);
  });

  it('installs the GitHub Actions workflow + ship-check action into a fresh repo', async () => {
    const dir = await freshTempDir(true);
    const r = runCli(['--cwd', dir, 'install', 'github', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { target: string; result: { status: string } };
    expect(payload.target).toBe('github');
    expect(payload.result.status).toBe('applied');
    expect(existsSync(path.join(dir, '.github', 'workflows', 'devcortex.yml'))).toBe(true);
    expect(
      existsSync(path.join(dir, '.github', 'actions', 'devcortex-ship-check', 'action.yml')),
    ).toBe(true);
  });

  it('install --all installs every host integration in one pass', async () => {
    const dir = await freshTempDir(true);
    const r = runCli(['--cwd', dir, 'install', '--all', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      count: number;
      applied: number;
      planned: number;
      results: { target: string; result: { status: string } }[];
    };
    expect(payload.count).toBe(5);
    expect(payload.applied).toBe(5);
    expect(payload.planned).toBe(0);
    expect(payload.results.map((x) => x.target).sort()).toEqual(
      ['claude', 'codex', 'cursor', 'github', 'vscode'].sort(),
    );

    // Every host's signature files exist after a single --all run.
    expect(existsSync(path.join(dir, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(path.join(dir, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(path.join(dir, '.cursor', 'rules', 'devcortex.mdc'))).toBe(true);
    expect(existsSync(path.join(dir, '.vscode', 'tasks.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.github', 'workflows', 'devcortex.yml'))).toBe(true);
  });

  it('install --all is idempotent (re-run reports every file unchanged)', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'install', '--all', '--json']).status).toBe(0);

    const second = runCli(['--cwd', dir, 'install', '--all', '--json']);
    expect(second.status).toBe(0);
    const payload = JSON.parse(second.stdout) as {
      applied: number;
      planned: number;
      results: { result: { status: string; files?: { action: string }[] } }[];
    };
    // Every host owns its files, so a re-run re-applies cleanly with no changes
    // (merge/wholesale outputs are byte-stable) — never a plan.
    expect(payload.planned).toBe(0);
    expect(payload.applied).toBe(5);
    for (const { result } of payload.results) {
      expect(result.status).toBe('applied');
      expect(result.files?.every((f) => f.action === 'unchanged')).toBe(true);
    }
  });

  it('rejects an unknown install target cleanly', () => {
    const r = runCli(['--cwd', workspace, 'install', 'emacs']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown install target');
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });
});

describe('doctor', () => {
  it('reports an initialized, healthy workspace', () => {
    const r = runCli(['--cwd', workspace, 'doctor', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { checks: { name: string; status: string }[] };
    expect(payload.checks.some((c) => c.name === 'workspace' && c.status === 'ok')).toBe(true);
    expect(payload.checks.some((c) => c.name === 'stack-packs')).toBe(true);
  });
});

describe('plan', () => {
  it('selects the billing workflow and emits an ordered plan (JSON)', () => {
    const r = runCli(['--cwd', workspace, 'plan', 'add subscription billing', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      risk: { riskLevel: string; taskType: string };
      workflow: { id: string; name: string };
      workflowStages: { stage: string; state: string }[];
      implementationStages: string[];
      definitionOfDone: string[];
    };
    expect(payload.risk.taskType).toBe('billing');
    expect(payload.risk.riskLevel).toBe('high');
    expect(payload.workflow.id).toBe('billing.add');
    expect(payload.implementationStages.length).toBeGreaterThan(0);
    expect(payload.definitionOfDone.length).toBeGreaterThan(0);
    // `execute` is always a handoff; at high risk the deep stages actually run.
    expect(payload.workflowStages.some((s) => s.stage === 'execute' && s.state === 'handoff')).toBe(true);
    expect(payload.workflowStages.some((s) => s.state === 'run')).toBe(true);
  });

  it('renders a human plan with the CORTEX-style sections', () => {
    const r = runCli(['--cwd', workspace, 'plan', 'add subscription billing']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX PLAN');
    expect(r.stdout).toContain('Workflow stages');
    expect(r.stdout).toContain('Implementation plan');
    expect(r.stdout).toContain('Definition of done');
  });
});

describe('skill', () => {
  it('lists built-in skills (JSON) including the Stripe hardening skill', () => {
    const r = runCli(['--cwd', workspace, 'skill', 'list', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      count: number;
      skills: { id: string; status: string; installed: boolean }[];
    };
    expect(payload.count).toBeGreaterThanOrEqual(8);
    expect(payload.skills.some((s) => s.id === 'stripe-webhook-hardening')).toBe(true);
  });

  it('recommends the Stripe skill first for a billing webhook task', () => {
    const r = runCli([
      '--cwd',
      workspace,
      'skill',
      'recommend',
      'add a stripe subscription webhook',
      '--json',
    ]);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      count: number;
      recommendations: { id: string; score: number; matched: string[] }[];
    };
    expect(payload.count).toBeGreaterThan(0);
    const top = payload.recommendations[0]!;
    expect(top.id).toBe('stripe-webhook-hardening');
    expect(top.score).toBeGreaterThan(0);
    expect(top.matched).toContain('stripe');
  });

  it('installs a built-in skill into the project and marks it installed', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);

    const install = runCli(['--cwd', dir, 'skill', 'install', 'stripe-webhook-hardening', '--json']);
    expect(install.status).toBe(0);
    const payload = JSON.parse(install.stdout) as { skill: { id: string }; path: string };
    expect(payload.skill.id).toBe('stripe-webhook-hardening');
    expect(payload.path).toContain('.cortex/skills');
    expect(existsSync(path.join(dir, '.cortex', 'skills', 'stripe-webhook-hardening.json'))).toBe(true);

    const list = runCli(['--cwd', dir, 'skill', 'list', '--json']);
    const listed = JSON.parse(list.stdout) as { skills: { id: string; installed: boolean }[] };
    expect(listed.skills.find((s) => s.id === 'stripe-webhook-hardening')?.installed).toBe(true);
  });

  it('rejects an unknown skill id cleanly', () => {
    const r = runCli(['--cwd', workspace, 'skill', 'install', 'not-a-skill']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown skill');
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });
});

describe('workflow', () => {
  it('lists all 15 named workflows (JSON)', () => {
    const r = runCli(['--cwd', workspace, 'workflow', 'list', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { count: number; workflows: { id: string }[] };
    expect(payload.count).toBe(15);
    expect(payload.workflows.some((w) => w.id === 'billing.add')).toBe(true);
  });

  it(
    'runs a workflow, persists a WorkflowRun, and gates on the outcome',
    async () => {
      const dir = await freshTempDir(true);
      expect(runCli(['--cwd', dir, 'init']).status).toBe(0);

      const r = runCli([
        '--cwd',
        dir,
        'workflow',
        'run',
        'bug.fix',
        'fix a null deref in the header',
        '--json',
      ]);
      // The fixture copy has no node_modules, so the quality gate fails → the run
      // is blocked → exit 2. A clean run would exit 0. Never 1 (internal error).
      expect([0, 2]).toContain(r.status);
      const payload = JSON.parse(r.stdout) as {
        run: { id: string; workflowId: string; status: string; stages: unknown[] };
      };
      expect(payload.run.workflowId).toBe('bug.fix');
      expect(['completed', 'blocked', 'failed']).toContain(payload.run.status);
      expect(payload.run.stages.length).toBeGreaterThan(0);

      // A run file was persisted under .cortex/workflows/.
      const runs = readdirSync(path.join(dir, '.cortex', 'workflows')).filter((f) => f.endsWith('.json'));
      expect(runs.length).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  it('rejects an unknown workflow id cleanly', () => {
    const r = runCli(['--cwd', workspace, 'workflow', 'run', 'not-a-workflow', 'do a thing']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid value');
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });
});

describe('learn', () => {
  it('reports zero and creates nothing on a workspace with no recurring failures', async () => {
    // A fresh, isolated workspace: no gate has run, so the evidence ledger and
    // flight recorder are empty → nothing to learn. (The shared `workspace` may
    // carry gate evidence from earlier ship/verify tests, so use a clean dir.)
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);

    const r = runCli(['--cwd', dir, 'learn', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { analyzed: number; created: string[] };
    expect(payload.analyzed).toBe(0);
    expect(payload.created).toEqual([]);
  });
});

describe('mcp (Safe MCP Manager)', () => {
  it('lists installed (none) + catalog recommendations on a fresh workspace (JSON)', () => {
    // The shared workspace has no `.mcp.json`, so nothing is installed and the
    // whole vetted catalog is recommended, ordered trusted-first.
    const r = runCli(['--cwd', workspace, 'mcp', 'list', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      installed: { id: string }[];
      recommended: { id: string; trust: string }[];
    };
    expect(payload.installed).toEqual([]);
    expect(payload.recommended.length).toBeGreaterThanOrEqual(8);
    expect(payload.recommended.some((s) => s.id === 'filesystem')).toBe(true);
  });

  it('renders a human CORTEX MCP report', () => {
    const r = runCli(['--cwd', workspace, 'mcp', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX MCP');
    expect(r.stdout).toContain('Recommended');
  });

  it('recommends the Stripe docs server for a stripe webhook task (JSON)', () => {
    const r = runCli([
      '--cwd',
      workspace,
      'mcp',
      'recommend',
      'add a stripe subscription webhook',
      '--json',
    ]);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { count: number; recommended: { id: string }[] };
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.recommended.some((s) => s.id === 'stripe-docs')).toBe(true);
  });

  it('installs a catalog server read-only, is idempotent-guarded, then --force updates', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);

    const first = runCli(['--cwd', dir, 'mcp', 'install', 'filesystem', '--json']);
    expect(first.status).toBe(0);
    const installed = JSON.parse(first.stdout) as { status: string; plan: { posture: string } };
    expect(installed.status).toBe('installed');
    expect(installed.plan.posture).toBe('read-only');
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.cortex', 'mcp', 'filesystem.json'))).toBe(true);

    // Re-install without --force writes NOTHING (confirm-before-overwrite).
    const second = runCli(['--cwd', dir, 'mcp', 'install', 'filesystem', '--json']);
    expect(second.status).toBe(0);
    expect((JSON.parse(second.stdout) as { status: string }).status).toBe('exists');

    // --force overwrites and reports `updated`.
    const forced = runCli(['--cwd', dir, 'mcp', 'install', 'filesystem', '--force', '--json']);
    expect(forced.status).toBe(0);
    expect((JSON.parse(forced.stdout) as { status: string }).status).toBe('updated');

    // The installed server now appears in `mcp list`.
    const list = runCli(['--cwd', dir, 'mcp', 'list', '--json']);
    const listed = JSON.parse(list.stdout) as { installed: { id: string }[] };
    expect(listed.installed.some((s) => s.id === 'filesystem')).toBe(true);
  });

  it('refuses to install an unknown MCP server cleanly (exit 1, no stack)', () => {
    const r = runCli(['--cwd', workspace, 'mcp', 'install', 'not-a-real-server']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown MCP server|vetted catalog/i);
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });

  it('audits a clean workspace (no servers) as risk-free', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);

    const r = runCli(['--cwd', dir, 'mcp', 'audit', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; count: number; findings: string[] };
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(0);
    expect(payload.findings).toEqual([]);
  });

  it('flags a write/secret-requiring server after it is installed', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);
    expect(runCli(['--cwd', dir, 'mcp', 'install', 'github', '--json']).status).toBe(0);

    const r = runCli(['--cwd', dir, 'mcp', 'audit', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; count: number; findings: string[] };
    // github exposes destructive/write tools + requires a secret → non-empty audit.
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.ok).toBe(false);
    expect(payload.findings.join('\n')).toContain('github');
  });
});

describe('firewall (MCP Security Firewall)', () => {
  it('shows the effective policy (built-in defaults) as JSON', () => {
    const r = runCli(['--cwd', workspace, 'firewall', 'show', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      source: string;
      policy: { allow: string[]; deny: string[]; requireApproval: string[]; dryRun: boolean };
    };
    // No policy file has been written → the safe defaults are surfaced.
    expect(payload.source).toBe('default');
    expect(payload.policy.allow).toContain('*.read');
    expect(payload.policy.deny).toContain('shell.rm');
    expect(payload.policy.dryRun).toBe(false);
  });

  it('renders a human CORTEX FIREWALL POLICY report', () => {
    const r = runCli(['--cwd', workspace, 'firewall', 'show']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX FIREWALL POLICY');
    expect(r.stdout).toContain('Allow');
    expect(r.stdout).toContain('Deny');
  });

  it('allows a read tool, denies shell.rm, and requires approval for a delete', () => {
    const allow = runCli(['--cwd', workspace, 'firewall', 'check', 'github', 'get_file_contents', '--json']);
    expect(allow.status).toBe(0);
    expect((JSON.parse(allow.stdout) as { evaluation: { decision: string } }).evaluation.decision).toBe('allow');

    const deny = runCli(['--cwd', workspace, 'firewall', 'check', 'shell', 'rm', '--json']);
    expect(deny.status).toBe(0);
    const denyEval = (JSON.parse(deny.stdout) as { evaluation: { decision: string; riskScore: number } }).evaluation;
    expect(denyEval.decision).toBe('deny');
    expect(denyEval.riskScore).toBeGreaterThan(0);

    const approval = runCli(['--cwd', workspace, 'firewall', 'check', 'github', 'delete_branch', '--json']);
    expect(approval.status).toBe(0);
    expect(
      (JSON.parse(approval.stdout) as { evaluation: { decision: string } }).evaluation.decision,
    ).toBe('require-approval');
  });

  it('renders a human CORTEX FIREWALL CHECK report', () => {
    const r = runCli(['--cwd', workspace, 'firewall', 'check', 'shell', 'rm']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX FIREWALL CHECK');
    expect(r.stdout).toContain('shell.rm');
    expect(r.stdout).toContain('DENY');
  });
});

describe('privacy (Privacy & Redaction Engine)', () => {
  it('reports the active privacy mode + what all three modes permit (JSON)', () => {
    const r = runCli(['--cwd', workspace, 'privacy', 'status', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      mode: string;
      modes: { mode: string; active: boolean; leavesMachine: boolean }[];
    };
    // init defaults to the safest mode.
    expect(payload.mode).toBe('local-only');
    expect(payload.modes.map((m) => m.mode)).toEqual(['local-only', 'metadata-cloud', 'deep-cloud']);
    expect(payload.modes.find((m) => m.mode === 'local-only')?.active).toBe(true);
    expect(payload.modes.find((m) => m.mode === 'local-only')?.leavesMachine).toBe(false);
    expect(payload.modes.find((m) => m.mode === 'deep-cloud')?.leavesMachine).toBe(true);
  });

  it('renders a human CORTEX PRIVACY report listing every mode', () => {
    const r = runCli(['--cwd', workspace, 'privacy', 'status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX PRIVACY');
    expect(r.stdout).toContain('local-only');
    expect(r.stdout).toContain('metadata-cloud');
    expect(r.stdout).toContain('deep-cloud');
  });

  it('summarizes the secrets + PII a file would leak, by kind (JSON)', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);

    // A file carrying a provider-prefixed API key + an email address.
    writeFileSync(
      path.join(dir, 'leak.env'),
      'API_KEY=sk-' + 'ant-abcdefghijklmnopqrstuvwxyz012345\nCONTACT=admin@example.com\n',
      'utf8',
    );

    const r = runCli(['--cwd', dir, 'privacy', 'redact', 'leak.env', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      file: string;
      totalMasked: number;
      findings: { kind: string; count: number }[];
    };
    expect(payload.file).toBe('leak.env');
    expect(payload.totalMasked).toBeGreaterThanOrEqual(2);
    const kinds = payload.findings.map((f) => f.kind);
    expect(kinds).toContain('api-key');
    expect(kinds).toContain('pii-email');
  });

  it('renders a clean human summary for a file with no secrets', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);
    writeFileSync(path.join(dir, 'clean.txt'), 'the quick brown fox jumps over the lazy dog\n', 'utf8');

    const r = runCli(['--cwd', dir, 'privacy', 'redact', 'clean.txt']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CORTEX PRIVACY REDACT');
    expect(r.stdout).toContain('No secrets or PII detected');
  });

  it('fails cleanly (exit 1, no stack) when the file does not exist', () => {
    const r = runCli(['--cwd', workspace, 'privacy', 'redact', 'does-not-exist.txt']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no such file/i);
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });
});

describe('error handling', () => {
  it('fails cleanly (exit 1, no stack) when the workspace is not initialized', async () => {
    const dir = await freshTempDir(false);
    const r = runCli(['--cwd', dir, 'preflight', 'do something']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/init/i);
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });
});

describe('guard (PreToolUse hook)', () => {
  it('BLOCKS an edit to a protected path in guarded mode (exit 2 + explanation)', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);
    setMode(dir, 'guarded');

    // middleware.ts is a protected path in the fixture (auth middleware).
    const payload = hookPayload('PreToolUse', 'Edit', { file_path: path.join(dir, 'middleware.ts') });
    const r = runCli(['--cwd', dir, 'guard', '--json'], payload);

    // Exit code 2 is the deliberate-block signal the hook shim propagates.
    expect(r.status).toBe(2);
    // The explanation reaches the agent via stderr and explains risk + override.
    expect(r.stderr).toContain('GUARD');
    expect(r.stderr).toContain('middleware.ts');
    expect(r.stderr).toMatch(/protected/i);
    expect(r.stderr).toMatch(/passive/i); // how-to-override hint
    expect(r.stderr).not.toMatch(/\n\s+at\s/); // no raw stack

    const payloadJson = JSON.parse(r.stdout) as { blocked: boolean; risk: string };
    expect(payloadJson.blocked).toBe(true);
    expect(payloadJson.risk).toBe('high');
  });

  it('ALLOWS a normal (unprotected) edit in guarded mode (exit 0)', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);
    setMode(dir, 'guarded');

    const payload = hookPayload('PreToolUse', 'Edit', { file_path: path.join(dir, 'app', 'page.tsx') });
    const r = runCli(['--cwd', dir, 'guard', '--json'], payload);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; blocked: boolean };
    expect(out.blocked).toBe(false);
  });

  it('never blocks in passive mode, even on a protected path (exit 0)', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);
    // init defaults to passive mode; assert the protected path is NOT blocked.

    const payload = hookPayload('PreToolUse', 'Write', { file_path: path.join(dir, 'lib', 'auth.ts') });
    const r = runCli(['--cwd', dir, 'guard', '--json'], payload);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { blocked: boolean; reason: string };
    expect(out.blocked).toBe(false);
    expect(out.reason).toBe('passive-mode');
  });

  it('fails open (exit 0) when the workspace is not initialized', async () => {
    const dir = await freshTempDir(true); // fixture copy, but NO `devcortex init`
    const payload = hookPayload('PreToolUse', 'Edit', { file_path: path.join(dir, 'middleware.ts') });
    const r = runCli(['--cwd', dir, 'guard', '--json'], payload);
    expect(r.status).toBe(0);
  });
});

describe('record-evidence (PostToolUse hook)', () => {
  it('records an evidence entry for a tool action and exits 0', async () => {
    const dir = await freshTempDir(true);
    expect(runCli(['--cwd', dir, 'init']).status).toBe(0);

    const evidenceDir = path.join(dir, '.cortex', 'evidence');
    expect(readdirSync(evidenceDir).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    const payload = hookPayload('PostToolUse', 'Edit', { file_path: path.join(dir, 'app', 'page.tsx') });
    const r = runCli(['--cwd', dir, 'record-evidence', '--json'], payload);
    expect(r.status).toBe(0);

    const out = JSON.parse(r.stdout) as { recorded: boolean; evidenceId: string; kind: string };
    expect(out.recorded).toBe(true);
    expect(out.kind).toBe('file');
    expect(out.evidenceId.length).toBeGreaterThan(0);

    // A real `<id>.json` evidence file was written to the ledger.
    const files = readdirSync(evidenceDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const recorded = JSON.parse(readFileSync(path.join(evidenceDir, files[0]!), 'utf8')) as {
      id: string;
      claim: string;
      kind: string;
    };
    expect(recorded.id).toBe(out.evidenceId);
    expect(recorded.kind).toBe('file');
    expect(recorded.claim).toContain('app/page.tsx');
  });

  it('fails open (exit 0) when the workspace is not initialized', async () => {
    const dir = await freshTempDir(true);
    const payload = hookPayload('PostToolUse', 'Edit', { file_path: path.join(dir, 'app', 'page.tsx') });
    const r = runCli(['--cwd', dir, 'record-evidence', '--json'], payload);
    expect(r.status).toBe(0);
  });
});
