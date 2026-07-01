/**
 * Policy engine tests: risk classification table, protected-path globbing,
 * shouldBlock matrix, risk→depth mapping, and floor enforcement.
 *
 * Policy is purely computational (path-string + in-memory-graph analysis), so
 * no filesystem fixtures are required — graphs and configs are built in memory.
 */
import { classifyRisk, depthForRisk, isProtected, shouldBlock } from './index';
import { ConfigError, DevCortexError } from '../domain/index';
import type {
  CortexConfig,
  FileKind,
  FileNode,
  OperatingMode,
  ProjectGraph,
  RiskLevel,
  TaskType,
} from '../domain/index';

// --- builders ---------------------------------------------------------------

function makeFile(path: string, kind: FileKind, overrides: Partial<FileNode> = {}): FileNode {
  return {
    path,
    kind,
    imports: [],
    importedBy: [],
    symbols: [],
    risky: false,
    tags: [],
    ...overrides,
  };
}

function makeGraph(files: FileNode[] = []): ProjectGraph {
  const riskyFiles = files.filter((f) => f.risky).map((f) => f.path);
  return {
    schemaVersion: 1,
    root: '/tmp/repo',
    generatedAt: '2026-06-30T00:00:00.000Z',
    stack: {
      framework: 'nextjs',
      language: 'typescript',
      packageManager: 'pnpm',
      monorepo: false,
      deploymentTargets: [],
    },
    files,
    routes: [],
    envVars: [],
    scripts: {},
    riskyFiles,
    stats: {
      fileCount: files.length,
      routeCount: 0,
      apiCount: 0,
      testCount: files.filter((f) => f.kind === 'test').length,
      riskyCount: riskyFiles.length,
    },
  };
}

function makeConfig(
  overrides: {
    mode?: OperatingMode;
    protectedPaths?: string[];
    floors?: Partial<Record<TaskType, RiskLevel>>;
  } = {},
): CortexConfig {
  return {
    schemaVersion: 1,
    mode: overrides.mode ?? 'guarded',
    privacy: 'local-only',
    risk: {
      protectedPaths: overrides.protectedPaths ?? [],
      floors: overrides.floors ?? {},
    },
    gates: { typecheck: true, lint: true, build: true, test: true, blockUnprovenDone: true },
    stackPacks: [],
    commands: {},
  };
}

// --- classifyRisk: classification table -------------------------------------

describe('classifyRisk — classification table', () => {
  const graph = makeGraph();
  const config = makeConfig();

  it('auth task → high', () => {
    const result = classifyRisk('add authentication to the login page', graph, config);
    expect(result.riskLevel).toBe('high');
    expect(result.taskType).toBe('auth');
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.rationale).toContain('auth');
  });

  it('"fix typo" → low', () => {
    const result = classifyRisk('fix typo in the readme', graph, config);
    expect(result.riskLevel).toBe('low');
  });

  it('"run db migration" → critical', () => {
    const result = classifyRisk('run db migration', graph, config);
    expect(result.riskLevel).toBe('critical');
    expect(result.taskType).toBe('database');
  });

  it('subscription billing → high (billing)', () => {
    const result = classifyRisk('add subscription billing with stripe', graph, config);
    expect(result.riskLevel).toBe('high');
    expect(result.taskType).toBe('billing');
  });

  it('secret/credential handling → critical (security)', () => {
    const result = classifyRisk('rotate the api key and the database password', graph, config);
    expect(result.riskLevel).toBe('critical');
    expect(result.taskType).toBe('security');
  });

  it('destructive DDL → critical (database)', () => {
    const result = classifyRisk('drop table legacy_users', graph, config);
    expect(result.riskLevel).toBe('critical');
    expect(result.taskType).toBe('database');
  });

  it('plain UI tweak → low (ui)', () => {
    const result = classifyRisk('adjust button styles on the page', graph, config);
    expect(result.riskLevel).toBe('low');
    expect(result.taskType).toBe('ui');
  });

  it('dependency upgrade → medium (dependency)', () => {
    const result = classifyRisk('upgrade dependencies to latest', graph, config);
    expect(result.riskLevel).toBe('medium');
    expect(result.taskType).toBe('dependency');
  });

  it('deploy to production → critical (devops)', () => {
    const result = classifyRisk('deploy the service to production', graph, config);
    expect(result.riskLevel).toBe('critical');
    expect(result.taskType).toBe('devops');
  });

  it('no keywords at all → low chore with explanatory signal', () => {
    const result = classifyRisk('xyzzy plugh frobnicate', graph, config);
    expect(result.riskLevel).toBe('low');
    expect(result.taskType).toBe('chore');
    expect(result.signals).toContain('no risk keywords detected');
  });

  it('produces a deduplicated, explainable signal list', () => {
    const result = classifyRisk('add authentication and session login', graph, config);
    const unique = new Set(result.signals);
    expect(unique.size).toBe(result.signals.length);
  });
});

// --- classifyRisk: input validation -----------------------------------------

describe('classifyRisk — input validation', () => {
  it('throws DevCortexError on an empty task', () => {
    expect(() => classifyRisk('   ', makeGraph(), makeConfig())).toThrow(DevCortexError);
  });

  it('throws DevCortexError on a non-string task', () => {
    expect(() =>
      classifyRisk(undefined as unknown as string, makeGraph(), makeConfig()),
    ).toThrow(DevCortexError);
  });
});

// --- classifyRisk: affected-file escalation ---------------------------------

describe('classifyRisk — affected-file escalation', () => {
  it('escalates a benign-wording task to high via a relevant auth file', () => {
    const files = [makeFile('src/features/orders.ts', 'billing', { tags: ['orders'] })];
    const result = classifyRisk('rename the orders helper', makeGraph(files), makeConfig());
    expect(result.riskLevel).toBe('high');
    expect(result.signals.some((s) => s.includes('orders.ts'))).toBe(true);
  });

  it('escalates to critical via a relevant migration file', () => {
    const files = [makeFile('src/data/widgets.ts', 'migration', { tags: ['widgets'] })];
    const result = classifyRisk('tweak the widgets module', makeGraph(files), makeConfig());
    expect(result.riskLevel).toBe('critical');
    expect(result.signals.some((s) => s.includes('migration'))).toBe(true);
  });

  it('escalates via the risky flag (and riskyFiles set)', () => {
    const files = [makeFile('src/core/engine.ts', 'lib', { risky: true, tags: ['engine'] })];
    const result = classifyRisk('improve the engine internals', makeGraph(files), makeConfig());
    expect(result.riskLevel).toBe('high');
    expect(result.signals.some((s) => s.includes('risky'))).toBe(true);
  });

  it('escalates via a protected path match even when the file kind is benign', () => {
    const files = [makeFile('src/util/helpers.ts', 'lib', { tags: ['helpers'] })];
    const config = makeConfig({ protectedPaths: ['**/helpers.ts'] });
    const result = classifyRisk('edit the helpers util', makeGraph(files), config);
    expect(result.riskLevel).toBe('high');
    expect(result.signals.some((s) => s.includes('protected path'))).toBe(true);
  });

  it('matches a relevant file by exported symbol', () => {
    const files = [makeFile('src/x.ts', 'config', { symbols: ['FeatureFlags'] })];
    const result = classifyRisk('update the FeatureFlags table', makeGraph(files), makeConfig());
    // config-kind file → medium; "table" keyword → database/high; max wins.
    expect(result.riskLevel).toBe('high');
  });

  it('ignores files the task does not plausibly touch', () => {
    const files = [makeFile('src/unrelated/zzz.ts', 'migration', { tags: ['zzz'] })];
    const result = classifyRisk('fix typo in the readme', makeGraph(files), makeConfig());
    expect(result.riskLevel).toBe('low');
  });
});

// --- classifyRisk: floor enforcement ----------------------------------------

describe('classifyRisk — floor enforcement', () => {
  it('raises a below-floor classification up to the floor', () => {
    const config = makeConfig({ floors: { ui: 'high' } });
    const result = classifyRisk('adjust button styles on the page', makeGraph(), config);
    expect(result.taskType).toBe('ui');
    expect(result.riskLevel).toBe('high');
    expect(result.signals.some((s) => s.includes('floor'))).toBe(true);
  });

  it('never lowers an above-floor classification', () => {
    const config = makeConfig({ floors: { database: 'low' } });
    const result = classifyRisk('run db migration', makeGraph(), config);
    expect(result.riskLevel).toBe('critical');
    expect(result.signals.some((s) => s.includes('floor'))).toBe(false);
  });

  it('only applies a floor to the matched task type', () => {
    const config = makeConfig({ floors: { billing: 'critical' } });
    const result = classifyRisk('adjust button styles on the page', makeGraph(), config);
    expect(result.taskType).toBe('ui');
    expect(result.riskLevel).toBe('low');
  });

  it('applies an equal floor without spuriously claiming it raised risk', () => {
    const config = makeConfig({ floors: { ui: 'low' } });
    const result = classifyRisk('adjust button styles', makeGraph(), config);
    expect(result.riskLevel).toBe('low');
    expect(result.signals.some((s) => s.includes('floor'))).toBe(false);
  });
});

// --- isProtected ------------------------------------------------------------

describe('isProtected — glob matching', () => {
  const config = makeConfig({
    protectedPaths: ['**/auth/**', 'middleware.ts', 'app/api/**', '.env*', '**/*.migration.ts'],
  });

  it('matches a nested auth directory', () => {
    expect(isProtected('src/auth/session.ts', config)).toBe(true);
  });

  it('matches a slashless pattern against a nested basename', () => {
    expect(isProtected('src/app/middleware.ts', config)).toBe(true);
  });

  it('matches a slashless pattern at the repo root', () => {
    expect(isProtected('middleware.ts', config)).toBe(true);
  });

  it('matches a multi-segment App Router api glob', () => {
    expect(isProtected('app/api/users/route.ts', config)).toBe(true);
  });

  it('matches dotfile variants', () => {
    expect(isProtected('.env', config)).toBe(true);
    expect(isProtected('.env.local', config)).toBe(true);
  });

  it('matches a nested dotfile via basename', () => {
    expect(isProtected('config/.env.production', config)).toBe(true);
  });

  it('matches a deep suffix glob', () => {
    expect(isProtected('db/0001_users.migration.ts', config)).toBe(true);
  });

  it('normalizes Windows separators before matching', () => {
    expect(isProtected('src\\auth\\session.ts', config)).toBe(true);
  });

  it('strips a leading ./ before matching', () => {
    expect(isProtected('./middleware.ts', config)).toBe(true);
  });

  it('does not match unrelated files', () => {
    expect(isProtected('src/components/Button.tsx', config)).toBe(false);
  });

  it('does not let a slashed pattern leak basename matching', () => {
    // `app/api/**` must not match a file merely named under some other dir.
    expect(isProtected('src/lib/api/helpers.ts', config)).toBe(false);
  });

  it('returns false when there are no protected paths', () => {
    expect(isProtected('anything.ts', makeConfig())).toBe(false);
  });

  it('returns false for an empty path', () => {
    expect(isProtected('', config)).toBe(false);
  });

  it('skips empty patterns rather than throwing', () => {
    const cfg = makeConfig({ protectedPaths: ['', '   ', '*.secret'] });
    expect(isProtected('keys.secret', cfg)).toBe(true);
    expect(isProtected('keys.txt', cfg)).toBe(false);
  });

  it('throws ConfigError on a non-string protected-path entry', () => {
    const cfg = makeConfig({ protectedPaths: ['valid.ts', 42 as unknown as string] });
    expect(() => isProtected('x.ts', cfg)).toThrow(ConfigError);
  });
});

// --- depthForRisk -----------------------------------------------------------

describe('depthForRisk', () => {
  it('low → tiny', () => expect(depthForRisk('low')).toBe('tiny'));
  it('medium → standard', () => expect(depthForRisk('medium')).toBe('standard'));
  it('high → deep', () => expect(depthForRisk('high')).toBe('deep'));
  it('critical → deep', () => expect(depthForRisk('critical')).toBe('deep'));

  it('throws DevCortexError on an unknown risk level', () => {
    expect(() => depthForRisk('weird' as RiskLevel)).toThrow(DevCortexError);
  });
});

// --- shouldBlock ------------------------------------------------------------

describe('shouldBlock — mode/risk matrix', () => {
  const cases: ReadonlyArray<readonly [OperatingMode, RiskLevel, boolean]> = [
    ['passive', 'low', false],
    ['passive', 'medium', false],
    ['passive', 'high', false],
    ['passive', 'critical', false],
    ['guarded', 'low', false],
    ['guarded', 'medium', false],
    ['guarded', 'high', true],
    ['guarded', 'critical', true],
    ['autopilot', 'low', false],
    ['autopilot', 'medium', false],
    ['autopilot', 'high', false],
    ['autopilot', 'critical', true],
  ];

  for (const [mode, risk, expected] of cases) {
    it(`${mode} + ${risk} → ${String(expected)}`, () => {
      expect(shouldBlock(mode, risk)).toBe(expected);
    });
  }

  it('throws DevCortexError on an unknown operating mode', () => {
    expect(() => shouldBlock('weird' as OperatingMode, 'critical')).toThrow(DevCortexError);
  });
});
