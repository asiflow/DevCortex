import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SchemaValidationError } from '../domain/index';
import type {
  CortexConfig,
  DetectedStack,
  LearnedFailure,
  ProjectGraph,
  SkillManifest,
} from '../domain/index';

import {
  SkillManifestStrictSchema,
  assertUniqueSkillIds,
  assertValidSkill,
  builtInSkills,
  generateSkillFromFailure,
  installSkill,
  loadSkills,
  recommendSkills,
  skillsDir,
} from './index';

// --- fixtures ---------------------------------------------------------------

function makeStack(overrides: Partial<DetectedStack> = {}): DetectedStack {
  return {
    framework: 'nextjs',
    language: 'typescript',
    packageManager: 'pnpm',
    frameworkVersion: '15.1.0',
    monorepo: false,
    deploymentTargets: ['vercel'],
    ...overrides,
  };
}

function makeGraph(overrides: Partial<ProjectGraph> = {}): ProjectGraph {
  return {
    schemaVersion: 1,
    root: '/tmp/example-repo',
    generatedAt: '2026-07-01T00:00:00.000Z',
    stack: makeStack(),
    files: [],
    routes: [],
    envVars: [],
    scripts: {},
    riskyFiles: [],
    stats: { fileCount: 0, routeCount: 0, apiCount: 0, testCount: 0, riskyCount: 0 },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    schemaVersion: 1,
    mode: 'passive',
    privacy: 'local-only',
    risk: { protectedPaths: [], floors: {} },
    gates: { typecheck: true, lint: true, build: true, test: true, blockUnprovenDone: true },
    stackPacks: [],
    commands: {},
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'custom-skill',
    name: 'Custom project skill',
    description: 'A project-authored skill used to exercise install/load round-tripping.',
    triggers: ['custom', 'project'],
    checklist: ['Do the custom thing correctly.'],
    commands: [{ name: 'build', run: 'pnpm run build' }],
    antiPatterns: ['Doing the custom thing incorrectly.'],
    mcpRecommendations: [],
    status: 'experimental',
    source: 'project',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFailure(overrides: Partial<LearnedFailure> = {}): LearnedFailure {
  return {
    id: 'failure-abc123def456',
    signature: 'build:cmd=pnpm run build#exit=1',
    occurrences: 3,
    diagnosis: {
      cause: 'A required dependency was not installed before the build ran.',
      category: 'wrong-package',
    },
    remedyKind: 'skill',
    createdAt: '2026-06-30T12:00:00.000Z',
    updatedAt: '2026-07-01T09:00:00.000Z',
    ...overrides,
  };
}

// --- per-test workspace -----------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-skills-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- recommendSkills --------------------------------------------------------

describe('recommendSkills', () => {
  it('ranks the stripe skill first for a billing task', () => {
    const result = recommendSkills(
      'add stripe billing checkout webhook signature verification',
      makeGraph(),
      makeConfig(),
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.id).toBe('stripe-webhook-hardening');
    expect(result.map((skill) => skill.id)).toContain('stripe-webhook-hardening');
  });

  it('surfaces the app-router auth skill for an authentication task', () => {
    const result = recommendSkills(
      'protect the login route and refresh the session in middleware',
      makeGraph(),
      makeConfig(),
    );
    expect(result[0]?.id).toBe('nextjs-app-router-auth');
  });

  it('boosts skills matching the detected stack and force-loaded stack packs', () => {
    // Task carries no skill signal — every hit here is a stack/config signal.
    const result = recommendSkills('general cleanup', makeGraph(), makeConfig({ stackPacks: ['supabase'] }));
    const ids = result.map((skill) => skill.id);
    expect(ids).toContain('nextjs-app-router-auth'); // framework: nextjs
    expect(ids).toContain('vercel-deployment-debugging'); // deploymentTargets: vercel
    expect(ids).toContain('supabase-rls-check'); // config.stackPacks: supabase
    expect(ids).not.toContain('stripe-webhook-hardening'); // no task or stack signal
  });

  it('returns an empty list when nothing matches the task or the stack', () => {
    const graph = makeGraph({
      stack: makeStack({
        framework: 'unknown',
        language: 'unknown',
        packageManager: 'unknown',
        deploymentTargets: [],
      }),
    });
    const result = recommendSkills('quokka wombat platypus', graph, makeConfig());
    expect(result).toEqual([]);
  });

  it('is deterministic — identical inputs yield identical rankings', () => {
    const a = recommendSkills('stripe billing subscription', makeGraph(), makeConfig());
    const b = recommendSkills('stripe billing subscription', makeGraph(), makeConfig());
    expect(a.map((skill) => skill.id)).toEqual(b.map((skill) => skill.id));
  });

  it('ranks over a caller-supplied pool when one is provided', () => {
    const generated = generateSkillFromFailure(makeFailure());
    const result = recommendSkills('fix the wrong package on build', makeGraph(), makeConfig(), [
      generated,
    ]);
    expect(result.map((skill) => skill.id)).toEqual([generated.id]);
  });
});

// --- installSkill + loadSkills ----------------------------------------------

describe('installSkill + loadSkills', () => {
  it('installs a project skill and loads it alongside the built-in pack', async () => {
    const skill = makeSkill();
    await installSkill(root, skill);

    const file = path.join(skillsDir(root), 'custom-skill.json');
    await expect(readFile(file, 'utf8')).resolves.toContain('custom-skill');

    const loaded = await loadSkills(root);
    expect(loaded).toHaveLength(builtInSkills.length + 1);

    const found = loaded.find((entry) => entry.id === 'custom-skill');
    expect(found).toBeDefined();
    expect(found?.name).toBe(skill.name);
    expect(found?.triggers).toEqual(skill.triggers);
  });

  it('returns exactly the built-in pack for a fresh, uninitialized workspace', async () => {
    const loaded = await loadSkills(root);
    expect(loaded.map((skill) => skill.id)).toEqual(builtInSkills.map((skill) => skill.id));
  });

  it('lets a project skill override a built-in skill by id, in place', async () => {
    const override = makeSkill({
      id: 'stripe-webhook-hardening',
      name: 'Custom stripe hardening',
      source: 'project',
    });
    await installSkill(root, override);

    const loaded = await loadSkills(root);
    expect(loaded).toHaveLength(builtInSkills.length); // override, not addition

    const entry = loaded.find((skill) => skill.id === 'stripe-webhook-hardening');
    expect(entry?.source).toBe('project');
    expect(entry?.name).toBe('Custom stripe hardening');

    const loadedIndex = loaded.findIndex((skill) => skill.id === 'stripe-webhook-hardening');
    const builtInIndex = builtInSkills.findIndex((skill) => skill.id === 'stripe-webhook-hardening');
    expect(loadedIndex).toBe(builtInIndex);
  });

  it('rejects a hollow skill before writing anything to disk', async () => {
    const hollow = makeSkill({ id: 'hollow-skill', triggers: [] });
    await expect(installSkill(root, hollow)).rejects.toBeInstanceOf(SchemaValidationError);

    const loaded = await loadSkills(root);
    expect(loaded.some((skill) => skill.id === 'hollow-skill')).toBe(false);
  });

  it('rejects an unsafely-named skill', async () => {
    const unsafe = makeSkill({ id: '../escape' });
    await expect(installSkill(root, unsafe)).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

// --- generateSkillFromFailure -----------------------------------------------

describe('generateSkillFromFailure', () => {
  it('produces a valid, deterministic manifest from a diagnosed failure', () => {
    const failure = makeFailure();
    const skill = generateSkillFromFailure(failure);

    expect(skill.id).toBe('remedy-failure-abc123def456');
    expect(skill.status).toBe('experimental');
    expect(skill.source).toBe('project-generated');
    expect(skill.triggers).toContain('wrong-package');
    expect(skill.triggers.length).toBeGreaterThan(0);
    expect(skill.checklist.length).toBeGreaterThan(1);
    expect(skill.antiPatterns[0]).toContain(failure.signature);

    // Timestamps derive from the failure — no clock, so it is reproducible.
    expect(skill.createdAt).toBe(failure.createdAt);
    expect(skill.updatedAt).toBe(failure.updatedAt);

    // The output always satisfies the strict engine contract.
    expect(() => assertValidSkill(skill, 'test')).not.toThrow();
    expect(SkillManifestStrictSchema.safeParse(skill).success).toBe(true);

    // Same input → byte-identical skill.
    expect(generateSkillFromFailure(failure)).toEqual(skill);
  });

  it('derives triggers from the diagnosis category and the signature keywords', () => {
    const skill = generateSkillFromFailure(
      makeFailure({
        signature: 'typecheck:cmd=tsc --noEmit#exit=2',
        diagnosis: { cause: 'A type error slipped through.', category: 'missing-context' },
      }),
    );
    expect(skill.triggers).toContain('missing-context');
    expect(skill.triggers).toContain('typecheck');
    // Generic runner noise never becomes a trigger.
    expect(skill.triggers).not.toContain('cmd');
    expect(skill.triggers).not.toContain('exit');
  });

  it('carries an MCP hint for a missing-mcp diagnosis', () => {
    const skill = generateSkillFromFailure(
      makeFailure({
        diagnosis: { cause: 'The Playwright MCP was never installed.', category: 'missing-mcp' },
      }),
    );
    expect(skill.mcpRecommendations.length).toBeGreaterThan(0);
  });

  it('round-trips: a generated skill can be installed and loaded', async () => {
    const skill = generateSkillFromFailure(makeFailure());
    await installSkill(root, skill);

    const loaded = await loadSkills(root);
    const found = loaded.find((entry) => entry.id === skill.id);
    expect(found).toBeDefined();
    expect(found?.source).toBe('project-generated');
  });

  it('rejects an invalid failure', () => {
    expect(() =>
      generateSkillFromFailure({ id: 'not-a-failure' } as unknown as LearnedFailure),
    ).toThrow(SchemaValidationError);
  });
});

// --- built-in pack ----------------------------------------------------------

describe('built-in skill pack', () => {
  it('ships eight structurally valid, uniquely-identified built-in skills', () => {
    expect(builtInSkills).toHaveLength(8);
    for (const skill of builtInSkills) {
      expect(() => assertValidSkill(skill, 'built-in')).not.toThrow();
      expect(skill.status).toBe('built-in');
    }
    expect(() => assertUniqueSkillIds(builtInSkills, 'test')).not.toThrow();
  });
});
