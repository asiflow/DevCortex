/**
 * Workflow Orchestrator tests (§7.15).
 *
 * Fixtures, per the design's testing strategy:
 *   1. Inline, hand-wired `ProjectGraph`s — a clean feature graph (no risky
 *      files, so `feature.build` classifies as `medium`) and a billing graph
 *      (risky billing/auth files + a billing risk floor, so `billing.add`
 *      classifies as `high`). This makes risk-driven depth scaling exact.
 *   2. A real, `mkdtemp`'d, initialized `.cortex/` workspace with real ledgers —
 *      never the repo's own `.cortex/`. No mocks: the run is persisted to disk
 *      and read back through the owning zod schema, the memory ledger holds a
 *      real record, and the quality gate runs a real command.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RISK_LEVELS, TASK_TYPES, WORKFLOW_IDS, WORKFLOW_STAGES, SchemaValidationError } from '../domain';
import type {
  CortexConfig,
  DetectedStack,
  EnvVar,
  FileKind,
  FileNode,
  ProjectGraph,
  RouteNode,
  StageOutcome,
  WorkflowDefinition,
  WorkflowStage,
} from '../domain';
import { DecisionLedger, EvidenceLedger, FeatureLedger, MemoryLedger } from '../ledgers';
import { initWorkspace, workspacePaths } from '../workspace';

import {
  assertValidWorkflowDefinition,
  listWorkflowRuns,
  loadWorkflowRun,
  orderCandidatesByRisk,
  runWorkflow,
  selectWorkflow,
  validateWorkflowRegistry,
  workflowDefinitions,
} from './index';
import type { WorkflowDeps } from './index';

// ---------------------------------------------------------------------------
// graph + config fixtures
// ---------------------------------------------------------------------------

function makeFile(p: string, kind: FileKind, overrides: Partial<FileNode> = {}): FileNode {
  return { path: p, kind, imports: [], importedBy: [], symbols: [], risky: false, tags: [], ...overrides };
}

const NEXT_STACK: DetectedStack = {
  framework: 'nextjs',
  language: 'typescript',
  packageManager: 'pnpm',
  monorepo: false,
  deploymentTargets: ['vercel'],
};

function finalizeGraph(files: FileNode[], routes: RouteNode[], envVars: EnvVar[]): ProjectGraph {
  return {
    schemaVersion: 1,
    root: '/repo',
    generatedAt: '2026-06-30T00:00:00.000Z',
    stack: NEXT_STACK,
    files,
    routes,
    envVars,
    scripts: { build: 'next build', test: 'vitest run', lint: 'next lint', typecheck: 'tsc --noEmit' },
    riskyFiles: files
      .filter((f) => f.risky)
      .map((f) => f.path)
      .sort(),
    stats: {
      fileCount: files.length,
      routeCount: routes.length,
      apiCount: routes.filter((r) => r.kind === 'api').length,
      testCount: files.filter((f) => f.kind === 'test').length,
      riskyCount: files.filter((f) => f.risky).length,
    },
  };
}

/** Clean graph with no risky files — a feature task here stays `medium`. */
function makeFeatureGraph(): ProjectGraph {
  const files: FileNode[] = [
    makeFile('src/components/Avatar.tsx', 'component', { tags: ['profile', 'avatar'] }),
    makeFile('src/components/UploadButton.tsx', 'component', { tags: ['upload'] }),
    makeFile('src/app/profile/page.tsx', 'page', {
      imports: ['src/components/Avatar.tsx'],
      tags: ['profile'],
    }),
    makeFile('src/lib/format.ts', 'lib'),
  ];
  const routes: RouteNode[] = [{ routePath: '/profile', file: 'src/app/profile/page.tsx', kind: 'page' }];
  return finalizeGraph(files, routes, []);
}

/** Billing graph with risky billing/auth files — a billing task here is `high`. */
function makeBillingGraph(): ProjectGraph {
  const files: FileNode[] = [
    makeFile('src/lib/db.ts', 'lib', { importedBy: ['src/lib/auth.ts', 'src/lib/billing.ts'] }),
    makeFile('src/lib/auth.ts', 'auth', {
      risky: true,
      imports: ['src/lib/db.ts'],
      importedBy: ['src/app/dashboard/page.tsx'],
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
    makeFile('src/app/billing/page.tsx', 'page', { imports: ['src/lib/billing.ts'], tags: ['billing'] }),
    makeFile('src/app/api/checkout/route.ts', 'api', {
      imports: ['src/lib/billing.ts'],
      tags: ['billing', 'checkout'],
    }),
    makeFile('src/components/PricingTable.tsx', 'component', { tags: ['billing', 'subscription'] }),
    makeFile('src/lib/billing.test.ts', 'test', { imports: ['src/lib/billing.ts'], tags: ['billing'] }),
  ];
  const routes: RouteNode[] = [
    { routePath: '/billing', file: 'src/app/billing/page.tsx', kind: 'page' },
    { routePath: '/api/checkout', file: 'src/app/api/checkout/route.ts', kind: 'api' },
  ];
  const envVars: EnvVar[] = [
    { name: 'STRIPE_SECRET_KEY', usedIn: ['src/lib/billing.ts'], documented: false },
    { name: 'AUTH_SECRET', usedIn: ['src/lib/auth.ts'], documented: true },
  ];
  return finalizeGraph(files, routes, envVars);
}

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    schemaVersion: 1,
    mode: 'guarded',
    privacy: 'local-only',
    risk: { protectedPaths: [], floors: {} },
    gates: { typecheck: false, lint: false, build: false, test: false, blockUnprovenDone: true },
    stackPacks: [],
    commands: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// workspace harness
// ---------------------------------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-workflows-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeDeps(graph: ProjectGraph, config: CortexConfig): Promise<WorkflowDeps> {
  await initWorkspace(root, { mode: config.mode, stack: graph.stack, graph, force: true });
  return {
    graph,
    config,
    ledgers: {
      memory: new MemoryLedger(root),
      feature: new FeatureLedger(root),
      decision: new DecisionLedger(root),
      evidence: new EvidenceLedger(root),
    },
  };
}

/** Map a run's stage outcomes to `stage -> status` for terse assertions. */
function statusByStage(stages: StageOutcome[]): Map<WorkflowStage, string> {
  return new Map(stages.map((s) => [s.stage, s.status] as const));
}

const FEATURE_TASK = 'build a user profile avatar upload feature';
const BILLING_TASK = 'add subscription billing with Stripe checkout';

// ---------------------------------------------------------------------------
// workflowDefinitions
// ---------------------------------------------------------------------------

describe('workflowDefinitions', () => {
  it('defines exactly the 15 named workflows with unique ids', () => {
    expect(workflowDefinitions).toHaveLength(WORKFLOW_IDS.length);
    const ids = workflowDefinitions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(WORKFLOW_IDS));
  });

  it('gives every workflow a canonically ordered subset of stages that includes the spine', () => {
    const orderIndex = new Map(WORKFLOW_STAGES.map((s, i) => [s, i] as const));
    const spine: WorkflowStage[] = [
      'classify',
      'intent',
      'context',
      'plan',
      'execute',
      'verify',
      'memory',
      'ship-report',
      'learn',
    ];
    for (const def of workflowDefinitions) {
      expect(def.stages.length).toBeGreaterThan(0);
      // canonical order, strictly increasing, no dupes
      const positions = def.stages.map((s) => orderIndex.get(s));
      expect(positions).toEqual([...positions].sort((a, b) => (a ?? -1) - (b ?? -1)));
      expect(new Set(def.stages).size).toBe(def.stages.length);
      for (const s of spine) expect(def.stages).toContain(s);
    }
  });

  it('covers every task type in the taxonomy', () => {
    const covered = new Set(workflowDefinitions.flatMap((d) => d.taskTypes));
    for (const type of TASK_TYPES) expect(covered.has(type)).toBe(true);
  });

  it('accepts the built-in registry and every built-in definition', () => {
    expect(() => validateWorkflowRegistry(workflowDefinitions)).not.toThrow();
    for (const def of workflowDefinitions) {
      expect(() => assertValidWorkflowDefinition(def)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// definition + registry validation (reused for custom/user workflows)
// ---------------------------------------------------------------------------

describe('assertValidWorkflowDefinition', () => {
  const base: WorkflowDefinition = {
    id: 'docs.sync',
    name: 'Sync documentation',
    taskTypes: ['docs'],
    stages: ['classify', 'intent', 'context', 'plan', 'execute', 'verify', 'memory', 'ship-report', 'learn'],
    minRisk: 'low',
  };

  function withDef(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
    return { ...base, ...overrides };
  }

  it('rejects an unknown id', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- non-enum id
      assertValidWorkflowDefinition(withDef({ id: 'bogus.flow' as any })),
    ).toThrow(/not a known WorkflowId/);
  });

  it('rejects an empty name', () => {
    expect(() => assertValidWorkflowDefinition(withDef({ name: '   ' }))).toThrow(/empty name/);
  });

  it('rejects empty, unknown, or duplicate task types', () => {
    expect(() => assertValidWorkflowDefinition(withDef({ taskTypes: [] }))).toThrow(/no task types/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- non-enum task type
    expect(() => assertValidWorkflowDefinition(withDef({ taskTypes: ['nope' as any] }))).toThrow(
      /unknown task type/,
    );
    expect(() => assertValidWorkflowDefinition(withDef({ taskTypes: ['docs', 'docs'] }))).toThrow(
      /duplicate task type/,
    );
  });

  it('rejects empty, unknown, duplicate, or out-of-order stages', () => {
    expect(() => assertValidWorkflowDefinition(withDef({ stages: [] }))).toThrow(/no stages/);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- non-enum stage
      assertValidWorkflowDefinition(withDef({ stages: ['classify', 'nope' as any] })),
    ).toThrow(/unknown stage/);
    expect(() =>
      assertValidWorkflowDefinition(
        withDef({
          stages: ['classify', 'classify', 'intent', 'context', 'plan', 'execute', 'verify', 'memory', 'ship-report', 'learn'],
        }),
      ),
    ).toThrow(/duplicate stage/);
    expect(() =>
      assertValidWorkflowDefinition(
        withDef({
          stages: ['intent', 'classify', 'context', 'plan', 'execute', 'verify', 'memory', 'ship-report', 'learn'],
        }),
      ),
    ).toThrow(/out of canonical order/);
  });

  it('rejects a definition missing a spine stage', () => {
    expect(() =>
      assertValidWorkflowDefinition(
        withDef({ stages: ['classify', 'intent', 'context', 'plan', 'execute', 'verify', 'memory', 'learn'] }),
      ),
    ).toThrow(/missing required spine stage/);
  });
});

describe('validateWorkflowRegistry', () => {
  const valid = workflowDefinitions[0] as WorkflowDefinition;

  it('rejects a registry with the wrong number of definitions', () => {
    expect(() => validateWorkflowRegistry([valid])).toThrow(/expected/);
  });

  it('rejects a registry with duplicate ids', () => {
    const dupes = workflowDefinitions.map((d) =>
      d.id === 'bug.fix' ? { ...d, id: 'feature.build' as const } : d,
    ) as WorkflowDefinition[];
    expect(() => validateWorkflowRegistry(dupes)).toThrow(/duplicate workflow id|missing a definition/);
  });

  it('rejects a registry that leaves a task type uncovered', () => {
    // Drop docs coverage by re-pointing docs.sync at an already-covered type.
    const uncovered = workflowDefinitions.map((d) =>
      d.id === 'docs.sync' ? { ...d, taskTypes: ['feature' as const] } : d,
    ) as WorkflowDefinition[];
    expect(() => validateWorkflowRegistry(uncovered)).toThrow(/no workflow serves task type "docs"/);
  });
});

// ---------------------------------------------------------------------------
// selectWorkflow
// ---------------------------------------------------------------------------

describe('selectWorkflow', () => {
  it('maps each primary task type to its workflow', () => {
    expect(selectWorkflow('feature', 'medium').id).toBe('feature.build');
    expect(selectWorkflow('billing', 'high').id).toBe('billing.add');
    expect(selectWorkflow('bugfix', 'low').id).toBe('bug.fix');
    expect(selectWorkflow('docs', 'low').id).toBe('docs.sync');
    expect(selectWorkflow('chore', 'low').id).toBe('refactor.safe');
  });

  it('disambiguates overlapping task types by risk fit', () => {
    // devops is served by devops.fix (floor low) and deploy.prepare (floor high).
    expect(selectWorkflow('devops', 'low').id).toBe('devops.fix');
    expect(selectWorkflow('devops', 'medium').id).toBe('devops.fix');
    expect(selectWorkflow('devops', 'critical').id).toBe('deploy.prepare');
    // release is served by release.prepare (floor medium) and deploy.prepare (high).
    expect(selectWorkflow('release', 'low').id).toBe('release.prepare');
    expect(selectWorkflow('release', 'medium').id).toBe('release.prepare');
    expect(selectWorkflow('release', 'high').id).toBe('deploy.prepare');
  });

  it('is total: returns a serving workflow for every (taskType, risk) pair', () => {
    for (const type of TASK_TYPES) {
      for (const risk of RISK_LEVELS) {
        const def = selectWorkflow(type, risk);
        expect(def.taskTypes).toContain(type);
      }
    }
  });

  it('throws on an invalid task type', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard against a non-enum input
    expect(() => selectWorkflow('nope' as any, 'low')).toThrow(/unknown task type/);
  });
});

describe('orderCandidatesByRisk (deterministic tie-breaks)', () => {
  function def(id: WorkflowDefinition['id'], minRisk: WorkflowDefinition['minRisk'], types: number): WorkflowDefinition {
    return {
      id,
      name: id,
      taskTypes: (['feature', 'bugfix', 'ui', 'auth'] as const).slice(0, types) as WorkflowDefinition['taskTypes'],
      stages: ['classify', 'intent', 'context', 'plan', 'execute', 'verify', 'memory', 'ship-report', 'learn'],
      minRisk,
    };
  }

  it('among applicable, prefers the highest floor', () => {
    const ordered = orderCandidatesByRisk([def('devops.fix', 'low', 1), def('deploy.prepare', 'high', 2)], 'critical');
    expect(ordered.map((d) => d.id)).toEqual(['deploy.prepare', 'devops.fix']);
  });

  it('breaks a floor tie by fewest task types, then registry order', () => {
    // Same floor, different task-type counts -> fewer wins.
    const bySpecificity = orderCandidatesByRisk([def('bug.fix', 'high', 2), def('feature.build', 'high', 1)], 'high');
    expect(bySpecificity.map((d) => d.id)).toEqual(['feature.build', 'bug.fix']);
    // Same floor AND same count -> registry order (feature.build precedes bug.fix).
    const byOrder = orderCandidatesByRisk([def('bug.fix', 'high', 1), def('feature.build', 'high', 1)], 'high');
    expect(byOrder.map((d) => d.id)).toEqual(['feature.build', 'bug.fix']);
  });

  it('falls back to lowest floor (then specificity, then order) when nothing is applicable', () => {
    // risk below every floor -> nearest (lowest floor) first.
    const byFloor = orderCandidatesByRisk([def('deploy.prepare', 'high', 1), def('api.integrate', 'medium', 1)], 'low');
    expect(byFloor.map((d) => d.id)).toEqual(['api.integrate', 'deploy.prepare']);
    // all unreachable, equal floor -> fewest task types, then registry order.
    const byRest = orderCandidatesByRisk([def('bug.fix', 'high', 2), def('feature.build', 'high', 1)], 'low');
    expect(byRest.map((d) => d.id)).toEqual(['feature.build', 'bug.fix']);
  });
});

// ---------------------------------------------------------------------------
// runWorkflow — feature.build (medium risk)
// ---------------------------------------------------------------------------

describe('runWorkflow: feature.build (medium risk)', () => {
  it('runs the full stage sequence, hands off execute, and completes', async () => {
    const deps = await makeDeps(makeFeatureGraph(), makeConfig());
    const run = await runWorkflow(root, 'feature.build', FEATURE_TASK, deps);

    expect(run.workflowId).toBe('feature.build');
    expect(run.riskLevel).toBe('medium');
    expect(run.status).toBe('completed');
    expect(run.id).toMatch(/^wf-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}$/);
    expect(new Date(run.startedAt).toISOString()).toBe(run.startedAt);
    expect(run.finishedAt).toBeDefined();

    // Every stage in the definition produced exactly one outcome, in order.
    const def = workflowDefinitions.find((d) => d.id === 'feature.build');
    expect(run.stages.map((s) => s.stage)).toEqual(def?.stages);

    const byStage = statusByStage(run.stages);
    // execute is always a handoff.
    expect(byStage.get('execute')).toBe('skipped');
    // medium risk executes the medium-floor deep stages...
    expect(byStage.get('blast-radius')).toBe('ok');
    expect(byStage.get('research')).toBe('ok');
    expect(byStage.get('stack-pack')).toBe('ok');
    // ...but skips the high-floor regression stage (depth scaling).
    expect(byStage.get('regression')).toBe('skipped');
    // spine stages all ok.
    for (const s of ['classify', 'intent', 'context', 'plan', 'verify', 'memory', 'ship-report', 'learn'] as const) {
      expect(byStage.get(s)).toBe('ok');
    }
  });

  it('persists the run and writes a decision memory item', async () => {
    const deps = await makeDeps(makeFeatureGraph(), makeConfig());
    const run = await runWorkflow(root, 'feature.build', FEATURE_TASK, deps);

    // On disk under .cortex/workflows and readable back through the schema.
    const file = path.join(workspacePaths(root).cortexDir, 'workflows', `${run.id}.json`);
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    expect(onDisk.id).toBe(run.id);

    const loaded = await loadWorkflowRun(root, run.id);
    expect(loaded).toEqual(run);

    const listed = await listWorkflowRuns(root);
    expect(listed.map((r) => r.id)).toContain(run.id);

    // The memory stage wrote exactly one decision item referencing this run.
    const memories = await deps.ledgers.memory.all();
    expect(memories).toHaveLength(1);
    const memory = memories[0];
    expect(memory?.type).toBe('decision');
    expect(memory?.riskLevel).toBe('medium');
    expect(memory?.source).toBe('workflow-run:feature.build');
    const memoryStage = run.stages.find((s) => s.stage === 'memory');
    expect(memoryStage?.evidenceIds).toEqual([memory?.id]);
  });
});

// ---------------------------------------------------------------------------
// runWorkflow — billing.add (high risk) + depth-scaling contrast
// ---------------------------------------------------------------------------

describe('runWorkflow: billing.add (high risk)', () => {
  it('classifies high via the billing floor and runs every deep stage', async () => {
    const config = makeConfig({ risk: { protectedPaths: [], floors: { billing: 'high' } } });
    const deps = await makeDeps(makeBillingGraph(), config);
    const run = await runWorkflow(root, 'billing.add', BILLING_TASK, deps);

    expect(run.riskLevel).toBe('high');
    expect(run.status).toBe('completed');

    const byStage = statusByStage(run.stages);
    expect(byStage.get('execute')).toBe('skipped');
    // At high risk NOTHING is depth-skipped except the execute handoff.
    expect(byStage.get('blast-radius')).toBe('ok');
    expect(byStage.get('research')).toBe('ok');
    expect(byStage.get('regression')).toBe('ok');
    const skipped = run.stages.filter((s) => s.status === 'skipped').map((s) => s.stage);
    expect(skipped).toEqual(['execute']);
  });

  it('scales depth by risk: regression runs at high but is skipped at medium', async () => {
    const featureDeps = await makeDeps(makeFeatureGraph(), makeConfig());
    const featureRun = await runWorkflow(root, 'feature.build', FEATURE_TASK, featureDeps);

    const billingDeps = await makeDeps(
      makeBillingGraph(),
      makeConfig({ risk: { protectedPaths: [], floors: { billing: 'high' } } }),
    );
    const billingRun = await runWorkflow(root, 'billing.add', BILLING_TASK, billingDeps);

    const featureRegression = featureRun.stages.find((s) => s.stage === 'regression');
    const billingRegression = billingRun.stages.find((s) => s.stage === 'regression');
    expect(featureRun.riskLevel).toBe('medium');
    expect(billingRun.riskLevel).toBe('high');
    expect(featureRegression?.status).toBe('skipped');
    expect(billingRegression?.status).toBe('ok');
    expect(billingRegression?.detail).toMatch(/regression/i);
  });

  it('docs.sync omits the deep stages from its definition entirely', () => {
    const docs = workflowDefinitions.find((d) => d.id === 'docs.sync');
    expect(docs?.stages).not.toContain('blast-radius');
    expect(docs?.stages).not.toContain('research');
    expect(docs?.stages).not.toContain('regression');
    expect(docs?.stages).not.toContain('stack-pack');
  });
});

// ---------------------------------------------------------------------------
// runWorkflow — blocked path (failing quality gate)
// ---------------------------------------------------------------------------

describe('runWorkflow: blocked by the quality gate', () => {
  it('records verify + ship-report as failed and blocks the run, but still persists', async () => {
    const config = makeConfig({
      gates: { typecheck: true, lint: false, build: false, test: false, blockUnprovenDone: true },
      commands: { typecheck: 'false' }, // real command that exits 1
    });
    const deps = await makeDeps(makeFeatureGraph(), config);
    const run = await runWorkflow(root, 'feature.build', FEATURE_TASK, deps);

    expect(run.status).toBe('blocked');
    const byStage = statusByStage(run.stages);
    expect(byStage.get('verify')).toBe('failed');
    expect(byStage.get('ship-report')).toBe('failed');

    // A blocked run still writes memory (with lowered confidence) and persists.
    const loaded = await loadWorkflowRun(root, run.id);
    expect(loaded.status).toBe('blocked');
    const memories = await deps.ledgers.memory.all();
    expect(memories).toHaveLength(1);
    expect(memories[0]?.confidence).toBe(0.5);
    // The learn stage reflects the block.
    const learn = run.stages.find((s) => s.stage === 'learn');
    expect(learn?.detail).toMatch(/blocked/i);
  });
});

// ---------------------------------------------------------------------------
// runWorkflow — input validation
// ---------------------------------------------------------------------------

describe('runWorkflow: input validation', () => {
  it('throws on an empty task', async () => {
    const deps = await makeDeps(makeFeatureGraph(), makeConfig());
    await expect(runWorkflow(root, 'feature.build', '   ', deps)).rejects.toThrow(SchemaValidationError);
  });

  it('throws on an unknown workflow id', async () => {
    const deps = await makeDeps(makeFeatureGraph(), makeConfig());
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard against a non-enum id
      runWorkflow(root, 'nope.workflow' as any, FEATURE_TASK, deps),
    ).rejects.toThrow(/unknown workflow id/);
  });

  it('throws when a ledger is missing from deps', async () => {
    const deps = await makeDeps(makeFeatureGraph(), makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed deps for the guard
    const broken = { ...deps, ledgers: { ...deps.ledgers, evidence: undefined } } as any;
    await expect(runWorkflow(root, 'feature.build', FEATURE_TASK, broken)).rejects.toThrow(
      SchemaValidationError,
    );
  });

  it('rejects an unknown risk level in selectWorkflow', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard against a non-enum risk
    expect(() => selectWorkflow('feature', 'severe' as any)).toThrow(/unknown risk level/);
  });
});

// ---------------------------------------------------------------------------
// runWorkflow — stage failure paths (captured into the run, not thrown)
// ---------------------------------------------------------------------------

describe('runWorkflow: stage failures are captured into the run', () => {
  it('fails the run when classification throws (foundational stage)', async () => {
    // A non-string protected-path glob makes isProtected throw a ConfigError,
    // which classifyRisk surfaces while analyzing the task's relevant files.
    const config = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- smuggling a non-string glob to force ConfigError
      risk: { protectedPaths: [123 as any], floors: {} },
    });
    const deps = await makeDeps(makeFeatureGraph(), config);
    const run = await runWorkflow(root, 'feature.build', FEATURE_TASK, deps);

    expect(run.status).toBe('failed');
    expect(run.stages).toHaveLength(1);
    expect(run.stages[0]?.stage).toBe('classify');
    expect(run.stages[0]?.status).toBe('failed');
    expect(run.stages[0]?.detail).toMatch(/stage threw/i);

    // The failed run is still persisted and readable.
    const loaded = await loadWorkflowRun(root, run.id);
    expect(loaded.status).toBe('failed');
  });

  it('fails the run at a later stage and stops (stack-pack resolution throws)', async () => {
    const graph = makeFeatureGraph();
    // Corrupt the detected stack so matchPacks (called by the intent stage)
    // throws a STACK_PACK_INVALID error — classification does not touch it.
    const badGraph = { ...graph, stack: { ...graph.stack, framework: 42 } } as unknown as ProjectGraph;
    const deps = await makeDeps(makeFeatureGraph(), makeConfig());
    deps.graph = badGraph;

    const run = await runWorkflow(root, 'feature.build', FEATURE_TASK, deps);
    expect(run.status).toBe('failed');
    const byStage = statusByStage(run.stages);
    expect(byStage.get('classify')).toBe('ok');
    expect(byStage.get('intent')).toBe('failed');
    // Execution stops after the fatal stage — no stages recorded past intent.
    expect(run.stages.map((s) => s.stage)).toEqual(['classify', 'intent']);
  });
});

// ---------------------------------------------------------------------------
// persistence edges
// ---------------------------------------------------------------------------

describe('workflow run persistence', () => {
  it('returns an empty list when no runs exist yet', async () => {
    await makeDeps(makeFeatureGraph(), makeConfig());
    await expect(listWorkflowRuns(root)).resolves.toEqual([]);
  });

  it('throws a clear error for a missing or unsafe run id', async () => {
    await makeDeps(makeFeatureGraph(), makeConfig());
    await expect(loadWorkflowRun(root, 'wf-does-not-exist')).rejects.toThrow(SchemaValidationError);
    await expect(loadWorkflowRun(root, '../escape')).rejects.toThrow(SchemaValidationError);
  });

  it('surfaces a corrupt run file as a schema validation error', async () => {
    await makeDeps(makeFeatureGraph(), makeConfig());
    const dir = path.join(workspacePaths(root).cortexDir, 'workflows');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'wf-corrupt.json'), '{ not valid json', 'utf8');
    await expect(loadWorkflowRun(root, 'wf-corrupt')).rejects.toThrow(SchemaValidationError);
    await expect(listWorkflowRuns(root)).rejects.toThrow(SchemaValidationError);
  });

  it('lists multiple runs sorted by start time', async () => {
    const deps = await makeDeps(makeFeatureGraph(), makeConfig());
    const first = await runWorkflow(root, 'feature.build', FEATURE_TASK, deps);
    const second = await runWorkflow(root, 'docs.sync', 'update the README wording', deps);
    const listed = await listWorkflowRuns(root);
    const ids = listed.map((r) => r.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    // sorted ascending by startedAt then id
    const sorted = [...listed].sort((a, b) =>
      a.startedAt === b.startedAt ? a.id.localeCompare(b.id) : a.startedAt.localeCompare(b.startedAt),
    );
    expect(listed).toEqual(sorted);
  });
});
