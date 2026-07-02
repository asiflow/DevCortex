/**
 * Tests for `composeSessionBrief` — the 2 KB session-start project brief.
 *
 * Fixture idiom mirrors `packages/core/src/ledgers/ledgers.test.ts`:
 * a fresh `mkdtemp` root per test, cleaned up via `afterEach`. No mocks;
 * real JSON files on disk, real ledger validation on every read and write.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectGraph } from '../domain/index';
import { DecisionLedger, FeatureLedger, MemoryLedger } from '../ledgers/index';
import type { DecisionInput, FeatureInput, MemoryInput } from '../ledgers/index';
import { defaultConfig, saveConfig, workspacePaths } from '../workspace/index';

import { composeSessionBrief } from './brief';

// --- fixture -----------------------------------------------------------------

const HEADER = 'CORTEX BRIEF — evidence-backed project state (devcortex)';

const UNINITIALIZED_TEXT =
  'DevCortex: no .cortex workspace found. Run `devcortex init` to enable project memory, gates, and ship reports.';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-brief-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a minimal valid workspace (config only — ledger dirs are self-initializing). */
async function seedWorkspace(): Promise<void> {
  await saveConfig(root, defaultConfig());
}

/**
 * Hand-craft `.cortex/graph.json` (typed as ProjectGraph so the fixture is
 * compile-time-bound to the shape the brief's plain-JSON reader expects).
 * Written directly — composeSessionBrief must never trigger a scan itself.
 */
async function seedGraph(): Promise<void> {
  const graph: ProjectGraph = {
    schemaVersion: 1,
    root,
    generatedAt: '2026-07-01T00:00:00.000Z',
    stack: {
      framework: 'nextjs',
      language: 'typescript',
      packageManager: 'pnpm',
      monorepo: false,
      deploymentTargets: [],
    },
    files: [],
    routes: [],
    envVars: [],
    scripts: {},
    riskyFiles: [],
    stats: { fileCount: 42, routeCount: 3, apiCount: 2, testCount: 5, riskyCount: 1 },
  };
  const paths = workspacePaths(root);
  await mkdir(paths.cortexDir, { recursive: true });
  await writeFile(paths.graph, JSON.stringify(graph), 'utf8');
}

/** Sleep long enough for ISO-ms timestamps to differ between ledger writes. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function memoryInput(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    type: 'risk',
    title: 'Auth tokens not rotated',
    summary: 'Service tokens use 30-day expiry without rotation.',
    source: 'security-audit',
    confidence: 0.9,
    evidence: [],
    relatedFiles: [],
    relatedFeatures: [],
    riskLevel: 'high',
    ...overrides,
  };
}

function featureInput(overrides: Partial<FeatureInput> = {}): FeatureInput {
  return {
    feature: 'Subscription billing',
    status: 'building',
    purpose: 'Let teams pay.',
    userValue: 'Self-serve upgrades.',
    routes: ['/billing'],
    components: ['BillingPanel'],
    apiEndpoints: ['/api/billing'],
    databaseTables: ['subscriptions'],
    envVars: ['STRIPE_SECRET_KEY'],
    dependencies: ['stripe'],
    protectedBehaviors: [],
    acceptanceCriteria: [],
    tests: [],
    evidence: [],
    knownRisks: [],
    relatedDecisions: [],
    regressionChecks: [],
    ...overrides,
  };
}

function decisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    decision: 'Adopt Apollo Federation v2',
    context: 'We need composable subgraphs.',
    optionsConsidered: ['Federation v1', 'Federation v2'],
    chosenOption: 'Federation v2',
    reason: '@link-based composition.',
    tradeoffs: ['migration effort'],
    affectedFiles: [],
    status: 'accepted',
    ...overrides,
  };
}

// --- tests -------------------------------------------------------------------

describe('composeSessionBrief', () => {
  it('returns the init hint for an uninitialized root', async () => {
    const brief = await composeSessionBrief('/tmp/definitely-not-a-workspace-xyz');
    expect(brief.uninitialized).toBe(true);
    expect(brief.text).toBe(UNINITIALIZED_TEXT);
    expect(brief.bytes).toBe(Buffer.byteLength(brief.text, 'utf8'));
  });

  it('renders all five sections with seeded ledgers within 2048 bytes', async () => {
    await seedWorkspace();
    await seedGraph();

    const memory = new MemoryLedger(root);
    const feature = new FeatureLedger(root);
    const decision = new DecisionLedger(root);

    // Seed: 5 risk memories (top 3 shown, sorted by riskLevel desc then confidence desc)
    await memory.add(memoryInput({ riskLevel: 'critical', confidence: 0.95, title: 'Critical auth flaw' }));
    await memory.add(memoryInput({ riskLevel: 'high', confidence: 0.9, title: 'High risk: token expiry' }));
    await memory.add(memoryInput({ riskLevel: 'high', confidence: 0.8, title: 'High risk: DB injection' }));
    await memory.add(memoryInput({ riskLevel: 'medium', confidence: 0.7, title: 'Medium risk: rate limit' }));
    await memory.add(memoryInput({ riskLevel: 'low', confidence: 0.5, title: 'Low risk: logging noise' }));

    // Seed: 4 building features with strictly increasing updatedAt (sleeps make
    // the ISO-ms timestamps distinct) — top 3 NEWEST shown, oldest dropped.
    await feature.add(featureInput({ feature: 'Billing' }));
    await sleep(5);
    const sso = await feature.add(featureInput({ feature: 'SSO' }));
    await sleep(5);
    const audit = await feature.add(featureInput({ feature: 'Audit log' }));
    await sleep(5);
    const dark = await feature.add(featureInput({ feature: 'Dark mode' }));

    // Seed: 3 decisions with explicit dates for predictable ordering (top 2 newest)
    await decision.add(decisionInput({ decision: 'Use RS256 JWT', date: '2026-06-01T00:00:00.000Z' }));
    await decision.add(decisionInput({ decision: 'Adopt pnpm monorepo', date: '2026-06-15T00:00:00.000Z' }));
    await decision.add(decisionInput({ decision: 'Ship via Vercel', date: '2026-07-01T00:00:00.000Z' }));

    const brief = await composeSessionBrief(root);

    expect(brief.uninitialized).toBe(false);
    expect(brief.bytes).toBe(Buffer.byteLength(brief.text, 'utf8'));
    expect(brief.bytes).toBeLessThanOrEqual(2048);

    // Header must be present
    expect(brief.text).toContain('CORTEX BRIEF');

    // Section 1: Project — stack summary + file count from the seeded graph.json
    expect(brief.text).toContain('## Project');
    expect(brief.text).toContain('typescript / nextjs (pnpm) · 42 files');

    // Section 2: Top risks — top 3 by severity
    expect(brief.text).toContain('## Top risks');
    expect(brief.text).toContain('[critical] Critical auth flaw');
    expect(brief.text).toContain('[high] High risk: token expiry');
    expect(brief.text).toContain('[high] High risk: DB injection');
    // 4th and 5th risk must NOT appear
    expect(brief.text).not.toContain('Medium risk: rate limit');
    expect(brief.text).not.toContain('Low risk: logging noise');

    // Section 3: In-flight features — the 3 newest by updatedAt, newest first
    expect(brief.text).toContain('## In-flight features');
    const darkLine = `- Dark mode (${dark.id})`;
    const auditLine = `- Audit log (${audit.id})`;
    const ssoLine = `- SSO (${sso.id})`;
    expect(brief.text).toContain(darkLine);
    expect(brief.text).toContain(auditLine);
    expect(brief.text).toContain(ssoLine);
    expect(brief.text.indexOf(darkLine)).toBeLessThan(brief.text.indexOf(auditLine));
    expect(brief.text.indexOf(auditLine)).toBeLessThan(brief.text.indexOf(ssoLine));
    // Oldest (4th) feature must NOT appear
    expect(brief.text).not.toContain('Billing');

    // Section 4: Recent decisions — 2 newest
    expect(brief.text).toContain('## Recent decisions');
    expect(brief.text).toContain('Ship via Vercel');
    expect(brief.text).toContain('Adopt pnpm monorepo');
    // Oldest decision must NOT appear
    expect(brief.text).not.toContain('Use RS256 JWT');

    // Section 5: Protected paths — from defaultConfig
    expect(brief.text).toContain('## Protected paths');
  });

  it('truncates whole sections bottom-up under byte pressure, never emitting a partial line', async () => {
    await seedWorkspace();

    const memory = new MemoryLedger(root);
    const titles: string[] = [];
    for (let i = 0; i < 50; i++) {
      const title = `Critical risk number ${i + 1} with a long descriptive title for byte stress`;
      titles.push(title);
      await memory.add(memoryInput({ riskLevel: 'critical', confidence: 0.9, title }));
    }

    // Baseline at the default budget: risks (capped at 3) + protected paths fit.
    const baseline = await composeSessionBrief(root);
    expect(baseline.uninitialized).toBe(false);
    expect(baseline.bytes).toBeLessThanOrEqual(2048);
    expect(baseline.text).toContain('## Top risks');
    expect(baseline.text).toContain('## Protected paths');

    // One byte less than the full render FORCES the truncation loop: the
    // bottom section (protected paths) must be dropped whole, risks kept.
    const budget = baseline.bytes - 1;
    const truncated = await composeSessionBrief(root, { maxBytes: budget });
    expect(truncated.bytes).toBeLessThanOrEqual(budget);
    expect(truncated.bytes).toBe(Buffer.byteLength(truncated.text, 'utf8'));
    expect(truncated.text).toContain(HEADER);
    expect(truncated.text).toContain('## Top risks');
    expect(truncated.text).not.toContain('## Protected paths');

    // No partially-cut line: every output line is exactly a line we seeded,
    // a section header, the brief header, or a blank separator.
    const allowed = new Set<string>([HEADER, '', '## Top risks', ...titles.map((t) => `- [critical] ${t}`)]);
    for (const line of truncated.text.split('\n')) {
      expect(allowed.has(line)).toBe(true);
    }

    // A budget below any single risk section (3 × ~82-byte lines) leaves only
    // the header — which must always survive, byte-exact and uncut.
    const minimal = await composeSessionBrief(root, { maxBytes: 200 });
    expect(minimal.text).toBe(HEADER);
    expect(minimal.bytes).toBe(Buffer.byteLength(HEADER, 'utf8'));
    expect(minimal.bytes).toBeLessThanOrEqual(200);
  });

  it('produces identical output on two consecutive calls (deterministic)', async () => {
    await seedWorkspace();

    const memory = new MemoryLedger(root);
    const feature = new FeatureLedger(root);
    const decision = new DecisionLedger(root);

    await memory.add(memoryInput({ title: 'Determinism check risk', riskLevel: 'high' }));
    // Multiple building features so the In-flight section exercises the
    // deterministic sort (updatedAt desc, id asc) rather than readdir order.
    await feature.add(featureInput({ feature: 'Alpha stream' }));
    await feature.add(featureInput({ feature: 'Beta stream' }));
    await feature.add(featureInput({ feature: 'Gamma stream' }));
    await decision.add(decisionInput({ decision: 'Determinism check decision', date: '2026-07-01T00:00:00.000Z' }));

    const first = await composeSessionBrief(root);
    const second = await composeSessionBrief(root);

    expect(first.text).toContain('## In-flight features');
    expect(first.text).toBe(second.text);
    expect(first.bytes).toBe(second.bytes);
    expect(first.uninitialized).toBe(second.uninitialized);
  });
});
