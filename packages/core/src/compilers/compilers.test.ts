/**
 * Compiler engine tests.
 *
 * Fixtures, per the design's testing strategy:
 *   1. An inline, hand-wired Next.js-shaped `ProjectGraph` (billing + auth +
 *      routes + a migration) so the contract derivation, risk classification,
 *      blast-radius projection, and depth-bound rendering are asserted exactly.
 *   2. Real ledgers (MemoryLedger / FeatureLedger / DecisionLedger) on a fresh
 *      `os.tmpdir()` root — never the repo's own `.cortex/` — proving
 *      compileContext reads real persisted records, not mocks.
 *
 * The matched stack pack is the real `nextjsPack` (compileContext resolves it
 * internally via matchPacks on the graph's stack). Tests import the modules
 * under test directly (`./intent`, `./context`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  ContextDepth,
  CortexConfig,
  EnvVar,
  FileKind,
  FileNode,
  ProjectGraph,
  RouteNode,
} from '../domain/index';
import { isDevCortexError } from '../domain/index';
import { nextjsPack } from '../stackpacks';
import { MemoryLedger, FeatureLedger, DecisionLedger } from '../ledgers';

import { compileIntent } from './intent';
import { compileContext } from './context';
import type { ContextLedgers } from './context';

// ---------------------------------------------------------------------------
// inline graph builders
// ---------------------------------------------------------------------------

function makeFile(p: string, kind: FileKind, overrides: Partial<FileNode> = {}): FileNode {
  return { path: p, kind, imports: [], importedBy: [], symbols: [], risky: false, tags: [], ...overrides };
}

function makeGraph(): ProjectGraph {
  const files: FileNode[] = [
    makeFile('src/lib/db.ts', 'lib', {
      importedBy: ['src/lib/auth.ts', 'src/lib/billing.ts'],
    }),
    makeFile('src/lib/auth.ts', 'auth', {
      risky: true,
      imports: ['src/lib/db.ts'],
      importedBy: ['middleware.ts', 'src/app/dashboard/page.tsx'],
      symbols: ['requireUser'],
      tags: ['auth'],
    }),
    makeFile('src/lib/billing.ts', 'billing', {
      risky: true,
      imports: ['src/lib/db.ts'],
      importedBy: ['src/app/billing/page.tsx', 'src/app/api/checkout/route.ts', 'src/lib/billing.test.ts'],
      symbols: ['createCheckoutSession'],
      tags: ['billing', 'stripe', 'subscription'],
    }),
    makeFile('middleware.ts', 'middleware', { risky: true, imports: ['src/lib/auth.ts'] }),
    makeFile('src/app/dashboard/page.tsx', 'page', { imports: ['src/lib/auth.ts'] }),
    makeFile('src/app/billing/page.tsx', 'page', { imports: ['src/lib/billing.ts'], tags: ['billing'] }),
    makeFile('src/app/api/checkout/route.ts', 'api', {
      imports: ['src/lib/billing.ts'],
      tags: ['billing', 'checkout'],
    }),
    makeFile('src/components/PricingTable.tsx', 'component', { tags: ['billing', 'subscription'] }),
    makeFile('src/components/Button.tsx', 'component'),
    makeFile('src/lib/billing.test.ts', 'test', { imports: ['src/lib/billing.ts'], tags: ['billing'] }),
    makeFile('prisma/migrations/0001_init/migration.sql', 'migration'),
  ];
  const routes: RouteNode[] = [
    { routePath: '/dashboard', file: 'src/app/dashboard/page.tsx', kind: 'page' },
    { routePath: '/billing', file: 'src/app/billing/page.tsx', kind: 'page' },
    { routePath: '/api/checkout', file: 'src/app/api/checkout/route.ts', kind: 'api' },
  ];
  const envVars: EnvVar[] = [
    { name: 'AUTH_SECRET', usedIn: ['src/lib/auth.ts'], documented: true },
    { name: 'STRIPE_SECRET_KEY', usedIn: ['src/lib/billing.ts'], documented: false },
    { name: 'DATABASE_URL', usedIn: ['src/lib/db.ts'], documented: false },
  ];
  return {
    schemaVersion: 1,
    root: '/repo',
    generatedAt: '2026-06-30T00:00:00.000Z',
    stack: {
      framework: 'nextjs',
      language: 'typescript',
      packageManager: 'pnpm',
      monorepo: false,
      deploymentTargets: ['vercel'],
    },
    files,
    routes,
    envVars,
    scripts: { build: 'next build', test: 'vitest run', lint: 'next lint', typecheck: 'tsc --noEmit' },
    riskyFiles: files.filter((f) => f.risky).map((f) => f.path).sort(),
    stats: {
      fileCount: files.length,
      routeCount: routes.length,
      apiCount: routes.filter((r) => r.kind === 'api').length,
      testCount: files.filter((f) => f.kind === 'test').length,
      riskyCount: files.filter((f) => f.risky).length,
    },
  };
}

function makeConfig(): CortexConfig {
  return {
    schemaVersion: 1,
    mode: 'guarded',
    privacy: 'local-only',
    risk: { protectedPaths: ['**/middleware.ts'], floors: { billing: 'high' } },
    gates: { typecheck: true, lint: true, build: true, test: true, blockUnprovenDone: true },
    stackPacks: [],
    commands: {},
  };
}

const BILLING_TASK = 'add subscription billing with Stripe checkout';

// ---------------------------------------------------------------------------
// compileIntent
// ---------------------------------------------------------------------------

describe('compileIntent', () => {
  const graph = makeGraph();
  const config = makeConfig();

  it('classifies a billing task as billing/high and populates every contract field', () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);

    expect(intent.taskType).toBe('billing');
    expect(intent.riskLevel).toBe('high');
    expect(intent.goal).toContain('subscription billing');

    // every array field is populated (non-empty).
    expect(intent.affectedAreas.length).toBeGreaterThan(0);
    expect(intent.nonGoals.length).toBeGreaterThan(0);
    expect(intent.requiredContext.length).toBeGreaterThan(0);
    expect(intent.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(intent.regressionRisks.length).toBeGreaterThan(0);
    expect(intent.implementationStages.length).toBeGreaterThan(0);
    expect(intent.verificationPlan.length).toBeGreaterThan(0);
    expect(intent.definitionOfDone.length).toBeGreaterThan(0);
    expect(intent.assumptions.length).toBeGreaterThan(0);
  });

  it('derives affected areas + billing regression risk from the blast radius', () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);

    expect(intent.affectedAreas).toContain('src/lib/billing.ts');
    expect(intent.affectedAreas).toContain('Billing & payment flows');
    expect(intent.affectedAreas).toContain('api /api/checkout');
    expect(intent.regressionRisks.some((r) => /[Bb]illing/.test(r))).toBe(true);
  });

  it('emits non-goals for in-repo surfaces the task does not touch', () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);
    // billing change does not reach auth → an explicit auth non-goal guards it.
    expect(intent.nonGoals.some((g) => /auth/i.test(g))).toBe(true);
    expect(intent.nonGoals.some((g) => /scope/i.test(g))).toBe(true);
  });

  it('drives definitionOfDone + verificationPlan from the gate config', () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);
    // all four gates are enabled → all four appear in the definition of done.
    // gate commands prefer the project's own npm scripts (here `pnpm typecheck`).
    expect(intent.definitionOfDone.some((d) => /pnpm typecheck/.test(d))).toBe(true);
    expect(intent.definitionOfDone.some((d) => /succeeds/.test(d))).toBe(true);
    expect(intent.definitionOfDone.some((d) => /green/.test(d))).toBe(true);
    expect(intent.verificationPlan.some((v) => /[Ee]vidence/.test(v))).toBe(true);
    // billing surface → the blast radius required the webhook signature check.
    expect(intent.verificationPlan).toContain('webhook signature check');
  });

  it('always records the inference assumption explicitly', () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);
    expect(intent.assumptions.some((a) => /inferred from files/.test(a))).toBe(true);
  });

  it('respects fewer enabled gates', () => {
    const lean: CortexConfig = {
      ...config,
      gates: { typecheck: true, lint: false, build: false, test: false, blockUnprovenDone: false },
    };
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], lean);
    expect(intent.definitionOfDone.some((d) => /pnpm typecheck/.test(d))).toBe(true);
    expect(intent.definitionOfDone.some((d) => /green/.test(d))).toBe(false);
    expect(intent.verificationPlan.some((v) => /block "done"/.test(v))).toBe(false);
  });

  it('classifies a benign UI task as low risk with a tiny-depth recommendation', () => {
    const intent = compileIntent('tweak the button label spacing in the header component', graph, [nextjsPack], config);
    expect(intent.taskType).toBe('ui');
    expect(intent.riskLevel).toBe('low');
    expect(intent.requiredContext.some((c) => /"tiny" depth/.test(c))).toBe(true);
  });

  it('records a greenfield assumption when no files match', () => {
    const emptyGraph: ProjectGraph = { ...graph, files: [], routes: [], envVars: [], riskyFiles: [] };
    const intent = compileIntent('add a feature flag service', emptyGraph, [nextjsPack], config);
    expect(intent.affectedAreas.length).toBeGreaterThan(0);
    expect(intent.assumptions.some((a) => /new addition/.test(a))).toBe(true);
  });

  it('throws DevCortexError(INTERNAL) on an empty task', () => {
    let caught: unknown;
    try {
      compileIntent('   ', graph, [nextjsPack], config);
    } catch (err) {
      caught = err;
    }
    expect(isDevCortexError(caught)).toBe(true);
    expect(isDevCortexError(caught) && caught.code).toBe('INTERNAL');
  });
});

// ---------------------------------------------------------------------------
// compileContext (real ledgers on a tmp root)
// ---------------------------------------------------------------------------

describe('compileContext', () => {
  const graph = makeGraph();
  const config = makeConfig();
  let tmp: string;
  let ledgers: ContextLedgers;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'devcortex-compilers-'));
    const memory = new MemoryLedger(tmp);
    const feature = new FeatureLedger(tmp);
    const decision = new DecisionLedger(tmp);

    await memory.add({
      type: 'risk',
      title: 'Stripe webhook signature verification failed',
      summary: 'Parsing req.json() before constructEvent broke the raw-body signature check.',
      source: 'incident-2026-05',
      confidence: 0.9,
      evidence: [],
      relatedFiles: ['src/app/api/checkout/route.ts'],
      relatedFeatures: [],
      riskLevel: 'high',
    });
    await memory.add({
      type: 'pattern',
      title: 'Always read the raw body for Stripe webhooks',
      summary: 'Use await req.text() then constructEvent; dedupe on event.id for retries.',
      source: 'team-convention',
      confidence: 0.95,
      evidence: [],
      relatedFiles: ['src/lib/billing.ts'],
      relatedFeatures: [],
      riskLevel: 'medium',
    });
    // a non-matching memory type that must NOT surface as a known failure.
    await memory.add({
      type: 'fact',
      title: 'The team uses pnpm',
      summary: 'Package manager is pnpm across the monorepo.',
      source: 'readme',
      confidence: 1,
      evidence: [],
      relatedFiles: [],
      relatedFeatures: [],
      riskLevel: 'low',
    });

    await feature.add({
      feature: 'Subscription billing',
      status: 'shipped',
      purpose: 'Let users subscribe to paid plans via Stripe.',
      userValue: 'Recurring revenue and gated premium features.',
      routes: ['/billing'],
      components: ['src/components/PricingTable.tsx'],
      apiEndpoints: ['/api/checkout'],
      databaseTables: [],
      envVars: ['STRIPE_SECRET_KEY'],
      dependencies: ['stripe'],
      protectedBehaviors: ['Webhook signature verification'],
      acceptanceCriteria: ['Checkout creates a subscription'],
      tests: ['src/lib/billing.test.ts'],
      evidence: [],
      knownRisks: ['Webhook replay'],
      relatedDecisions: [],
      regressionChecks: ['billing flow regression test'],
    });
    // an unrelated feature that should NOT be related to a billing task.
    await feature.add({
      feature: 'Marketing landing page',
      status: 'shipped',
      purpose: 'Static homepage for visitors.',
      userValue: 'Top-of-funnel conversion.',
      routes: ['/'],
      components: ['src/components/Hero.tsx'],
      apiEndpoints: [],
      databaseTables: [],
      envVars: [],
      dependencies: [],
      protectedBehaviors: [],
      acceptanceCriteria: [],
      tests: [],
      evidence: [],
      knownRisks: [],
      relatedDecisions: [],
      regressionChecks: [],
    });

    await decision.add({
      decision: 'Verify Stripe webhooks server-side against the raw body',
      context: 'Webhook handling for billing events.',
      optionsConsidered: ['Trust the parsed JSON', 'Verify the raw body signature'],
      chosenOption: 'Verify the raw body signature',
      reason: 'Parsed bodies break the signature math; raw-body verification is the only safe path.',
      tradeoffs: ['Slightly more handler boilerplate'],
      affectedFiles: ['src/app/api/checkout/route.ts', 'src/lib/billing.ts'],
      status: 'accepted',
    });

    ledgers = { memory, feature, decision };
  });

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('assembles a context pack with every field populated from packs + ledgers', async () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);
    const pack = await compileContext(intent, graph, ledgers, 'standard');

    expect(pack.depth).toBe('standard');
    expect(pack.relevantFiles).toContain('src/lib/billing.ts');

    // patterns / constraints / forbidden approaches come from the nextjs pack.
    expect(pack.patterns.length).toBeGreaterThan(0);
    expect(pack.constraints.length).toBeGreaterThan(0);
    expect(pack.forbiddenApproaches.length).toBeGreaterThan(0);
    expect(pack.forbiddenApproaches.some((f) => /Stripe webhook body|verify/i.test(f))).toBe(true);

    // known failures come from the memory ledger (type risk | pattern only).
    expect(pack.knownFailures.some((k) => /webhook signature/i.test(k))).toBe(true);
    expect(pack.knownFailures.some((k) => /raw body/i.test(k))).toBe(true);
    expect(pack.knownFailures.some((k) => /pnpm/i.test(k))).toBe(false);

    // related features come from the feature ledger, filtered to relevant ones.
    expect(pack.relatedFeatures.some((f) => /Subscription billing/.test(f))).toBe(true);
    expect(pack.relatedFeatures.some((f) => /Marketing/.test(f))).toBe(false);

    // tests to run combine relevant test files, scripts and pack commands.
    expect(pack.testsToRun.length).toBeGreaterThan(0);
    expect(pack.testsToRun.some((t) => /billing\.test\.ts/.test(t))).toBe(true);

    // markdown is the injectable block and references the goal + a prior decision.
    expect(pack.markdown).toContain('DevCortex context');
    expect(pack.markdown).toContain('Stripe webhooks server-side');
  });

  it('respects the token budget at every depth and scales content with depth', async () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);
    const budgets: Record<ContextDepth, number> = { tiny: 800, standard: 2500, deep: 6000 };

    const tiny = await compileContext(intent, graph, ledgers, 'tiny');
    const standard = await compileContext(intent, graph, ledgers, 'standard');
    const deep = await compileContext(intent, graph, ledgers, 'deep');

    for (const pack of [tiny, standard, deep]) {
      expect(pack.markdown.length).toBeGreaterThan(0);
      // tokenEstimate ≈ chars / 4 and must never exceed the depth budget.
      expect(pack.tokenEstimate).toBe(Math.ceil(pack.markdown.length / 4));
      expect(pack.tokenEstimate).toBeLessThanOrEqual(budgets[pack.depth]);
    }

    // deeper context is at least as large as shallower context.
    expect(tiny.tokenEstimate).toBeLessThanOrEqual(800);
    expect(deep.markdown.length).toBeGreaterThanOrEqual(tiny.markdown.length);

    // tiny still surfaces the highest-value "do NOT" guidance.
    expect(tiny.markdown).toContain('Do NOT');
    // the prior-decisions section is a standard+ concept, omitted from tiny markdown.
    expect(tiny.markdown).not.toContain('Prior decisions');
    expect(standard.markdown).toContain('Prior decisions');
  });

  it('falls back to a risk-derived depth when given an invalid depth', async () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);
    // high-risk billing → depthForRisk('high') === 'deep'.
    const pack = await compileContext(intent, graph, ledgers, 'enormous' as unknown as ContextDepth);
    expect(pack.depth).toBe('deep');
    expect(pack.tokenEstimate).toBeLessThanOrEqual(6000);
  });

  it('throws DevCortexError(INTERNAL) when the ledger bundle is incomplete', async () => {
    const intent = compileIntent(BILLING_TASK, graph, [nextjsPack], config);
    const bad = { memory: ledgers.memory, feature: ledgers.feature } as unknown as ContextLedgers;
    await expect(compileContext(intent, graph, bad, 'standard')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
});
