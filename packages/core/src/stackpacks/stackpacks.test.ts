import { describe, expect, it } from 'vitest';

import { DevCortexError, RISK_LEVELS } from '../domain/index';
import type { DetectedStack, RiskLevel } from '../domain/index';

import {
  allPacks,
  dockerPack,
  fastapiPack,
  githubActionsPack,
  kubernetesPack,
  matchPacks,
  nextjsPack,
  postgresPack,
  stripePack,
  vercelPack,
} from './index';
import type { StackPack } from '../domain/index';

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

const RISK_SET = new Set<RiskLevel>(RISK_LEVELS);

describe('nextjsPack.matches', () => {
  it('returns true for a Next.js detected stack', () => {
    expect(nextjsPack.matches(makeStack())).toBe(true);
    // framework is the only discriminator — other fields must not affect it.
    expect(nextjsPack.matches(makeStack({ packageManager: 'npm', language: 'javascript', monorepo: true }))).toBe(true);
  });

  it('returns false for non-Next.js stacks', () => {
    for (const framework of ['react', 'vite', 'express', 'node', 'fastapi', 'unknown'] as const) {
      expect(nextjsPack.matches(makeStack({ framework }))).toBe(false);
    }
  });
});

describe('nextjsPack content', () => {
  it('has a stable id and name', () => {
    expect(nextjsPack.id).toBe('nextjs-typescript');
    expect(nextjsPack.name.length).toBeGreaterThan(0);
  });

  it('populates every guidance array with real entries', () => {
    expect(nextjsPack.bestPractices.length).toBeGreaterThan(0);
    expect(nextjsPack.antiPatterns.length).toBeGreaterThan(0);
    expect(nextjsPack.recommendedLibraries.length).toBeGreaterThan(0);
    expect(nextjsPack.versionChecks.length).toBeGreaterThan(0);
    expect(nextjsPack.setupCommands.length).toBeGreaterThan(0);
    expect(nextjsPack.testCommands.length).toBeGreaterThan(0);
    expect(nextjsPack.qualityGates.length).toBeGreaterThan(0);
    expect(nextjsPack.securityNotes.length).toBeGreaterThan(0);
    expect(nextjsPack.deploymentNotes.length).toBeGreaterThan(0);
    expect(nextjsPack.commonFailures.length).toBeGreaterThan(0);
  });

  it('uses only valid risk-level severities and unique rule ids', () => {
    const rules = [...nextjsPack.bestPractices, ...nextjsPack.antiPatterns];
    for (const rule of rules) {
      expect(RISK_SET.has(rule.severity)).toBe(true);
      expect(rule.id.length).toBeGreaterThan(0);
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.detail.length).toBeGreaterThan(0);
    }
    const ids = rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pins next ^15 and react ^19 in versionChecks', () => {
    const next = nextjsPack.versionChecks.find((vc) => vc.pkg === 'next');
    const react = nextjsPack.versionChecks.find((vc) => vc.pkg === 'react');
    expect(next?.supported).toBe('^15');
    expect(react?.supported).toBe('^19');
  });

  it('encodes the classic Stripe webhook raw-body and Supabase getUser pitfalls', () => {
    const failureIds = nextjsPack.commonFailures.map((failure) => failure.id);
    expect(failureIds).toContain('nextjs.fail.stripe-webhook-raw-body');
    expect(failureIds).toContain('nextjs.fail.supabase-getsession-insecure');

    const security = nextjsPack.securityNotes.join('\n');
    expect(security).toContain('NEXT_PUBLIC_');
    expect(security).toContain('getUser()');
  });
});

describe('allPacks', () => {
  it('is non-empty and contains the Next.js pack', () => {
    expect(allPacks.length).toBeGreaterThan(0);
    expect(allPacks).toContain(nextjsPack);
  });

  it('has unique pack ids', () => {
    const ids = allPacks.map((pack) => pack.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('matchPacks', () => {
  it('returns exactly the registered packs whose matches() predicate is true', () => {
    const stack = makeStack();
    // The contract: matchPacks is the full registry filtered by each pack's own predicate.
    expect(matchPacks(stack)).toEqual(allPacks.filter((pack) => pack.matches(stack)));
    // No pack is included spuriously — every returned pack genuinely claims the stack.
    for (const pack of matchPacks(stack)) {
      expect(pack.matches(stack)).toBe(true);
    }
  });

  it('includes the Next.js pack for a Next.js stack and excludes it for a non-React stack', () => {
    expect(matchPacks(makeStack())).toContain(nextjsPack);
    expect(matchPacks(makeStack({ framework: 'express', language: 'javascript' }))).not.toContain(
      nextjsPack,
    );
  });

  it('returns an empty list when no registered pack claims the stack', () => {
    // Unknown framework + a non-JS language + no infra deployment hints: nothing matches.
    const orphan = makeStack({ framework: 'unknown', language: 'go', deploymentTargets: [] });
    expect(matchPacks(orphan)).toEqual([]);
  });

  it('throws DevCortexError(STACK_PACK_INVALID) for a malformed stack argument', () => {
    // @ts-expect-error — exercising the runtime guard against untrusted input.
    expect(() => matchPacks(null)).toThrow(DevCortexError);
    // @ts-expect-error — missing framework.
    expect(() => matchPacks({})).toThrow(/STACK_PACK_INVALID|framework/i);

    try {
      // @ts-expect-error — wrong type.
      matchPacks(42);
      expect.unreachable('matchPacks should have thrown on a numeric argument');
    } catch (err) {
      expect(err).toBeInstanceOf(DevCortexError);
      expect((err as DevCortexError).code).toBe('STACK_PACK_INVALID');
    }
  });
});

describe('registered pack set', () => {
  const EXPECTED_PACK_IDS = [
    'nextjs-typescript',
    'react-typescript',
    'typescript',
    'tailwind',
    'shadcn-ui',
    'node',
    'supabase',
    'prisma',
    'stripe-payments',
    'vercel-deploy',
    'fastapi-python',
    'postgres-database',
    'docker-container',
    'kubernetes-orchestration',
    'github-actions-ci',
  ];

  it('registers all 15 packs with unique ids', () => {
    // The 8 originals plus the 7 infra packs authored in Wave 2.
    expect(allPacks.length).toBe(15);
    const ids = allPacks.map((pack) => pack.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes each of the 7 new infra pack ids', () => {
    const ids = new Set(allPacks.map((pack) => pack.id));
    for (const id of [
      'stripe-payments',
      'vercel-deploy',
      'fastapi-python',
      'postgres-database',
      'docker-container',
      'kubernetes-orchestration',
      'github-actions-ci',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('exposes exactly the expected pack ids (guards against silent id drift)', () => {
    expect(allPacks.map((pack) => pack.id).sort()).toEqual([...EXPECTED_PACK_IDS].sort());
  });

  it('every pack fully populates its guidance arrays with valid, unique ids', () => {
    for (const pack of allPacks) {
      expect(pack.bestPractices.length).toBeGreaterThan(0);
      expect(pack.antiPatterns.length).toBeGreaterThan(0);
      expect(pack.recommendedLibraries.length).toBeGreaterThan(0);
      expect(pack.versionChecks.length).toBeGreaterThan(0);
      expect(pack.setupCommands.length).toBeGreaterThan(0);
      expect(pack.testCommands.length).toBeGreaterThan(0);
      expect(pack.qualityGates.length).toBeGreaterThan(0);
      expect(pack.securityNotes.length).toBeGreaterThan(0);
      expect(pack.deploymentNotes.length).toBeGreaterThan(0);
      expect(pack.commonFailures.length).toBeGreaterThan(0);

      const ruleIds = [...pack.bestPractices, ...pack.antiPatterns].map((rule) => rule.id);
      expect(new Set(ruleIds).size).toBe(ruleIds.length);
      for (const rule of [...pack.bestPractices, ...pack.antiPatterns]) {
        expect(RISK_SET.has(rule.severity)).toBe(true);
      }
      const failureIds = pack.commonFailures.map((failure) => failure.id);
      expect(new Set(failureIds).size).toBe(failureIds.length);
    }
  });
});

describe('infra pack matching', () => {
  // Each infra pack must be reachable from a realistic detected stack, and none
  // may match the orphan stack (unknown framework, non-JS language, no hints) —
  // that invariant is what keeps matchPacks(orphan) === [] intact.
  const orphan = makeStack({ framework: 'unknown', language: 'go', deploymentTargets: [] });

  function matchesOrphan(pack: StackPack): boolean {
    return pack.matches(orphan);
  }

  it('stripePack matches a stripe hint and a JS/TS server stack, not the orphan', () => {
    expect(stripePack.matches(makeStack({ framework: 'unknown', deploymentTargets: ['stripe'] }))).toBe(true);
    expect(stripePack.matches(makeStack({ framework: 'express', language: 'typescript', deploymentTargets: [] }))).toBe(
      true,
    );
    expect(matchesOrphan(stripePack)).toBe(false);
  });

  it('vercelPack matches a vercel hint and a JS/TS front-end, not the orphan', () => {
    expect(vercelPack.matches(makeStack({ framework: 'unknown', deploymentTargets: ['vercel'] }))).toBe(true);
    expect(vercelPack.matches(makeStack({ framework: 'vite', language: 'typescript', deploymentTargets: [] }))).toBe(
      true,
    );
    expect(matchesOrphan(vercelPack)).toBe(false);
  });

  it('fastapiPack matches only the fastapi framework, not the orphan', () => {
    expect(fastapiPack.matches(makeStack({ framework: 'fastapi', language: 'python', deploymentTargets: [] }))).toBe(
      true,
    );
    expect(fastapiPack.matches(makeStack({ framework: 'express', language: 'javascript' }))).toBe(false);
    expect(matchesOrphan(fastapiPack)).toBe(false);
  });

  it('postgresPack matches a postgres/postgresql hint, not the orphan', () => {
    expect(postgresPack.matches(makeStack({ framework: 'fastapi', language: 'python', deploymentTargets: ['postgres'] }))).toBe(
      true,
    );
    expect(postgresPack.matches(makeStack({ deploymentTargets: ['postgresql'] }))).toBe(true);
    expect(postgresPack.matches(makeStack({ deploymentTargets: [] }))).toBe(false);
    expect(matchesOrphan(postgresPack)).toBe(false);
  });

  it('dockerPack matches a docker/container hint, not the orphan', () => {
    expect(dockerPack.matches(makeStack({ framework: 'unknown', language: 'go', deploymentTargets: ['docker'] }))).toBe(
      true,
    );
    expect(dockerPack.matches(makeStack({ deploymentTargets: ['container'] }))).toBe(true);
    expect(matchesOrphan(dockerPack)).toBe(false);
  });

  it('kubernetesPack matches kubernetes/k8s/gke hints, not the orphan', () => {
    for (const target of ['kubernetes', 'k8s', 'gke', 'eks', 'aks']) {
      expect(kubernetesPack.matches(makeStack({ framework: 'unknown', language: 'go', deploymentTargets: [target] }))).toBe(
        true,
      );
    }
    expect(matchesOrphan(kubernetesPack)).toBe(false);
  });

  it('githubActionsPack matches github-actions/ci hints, not the orphan', () => {
    for (const target of ['github-actions', 'github', 'ci']) {
      expect(
        githubActionsPack.matches(makeStack({ framework: 'unknown', language: 'go', deploymentTargets: [target] })),
      ).toBe(true);
    }
    expect(matchesOrphan(githubActionsPack)).toBe(false);
  });

  it('keeps matchPacks(orphan) empty across the full 15-pack registry', () => {
    // Regression guard: adding infra packs must not make the orphan stack match anything.
    expect(matchPacks(orphan)).toEqual([]);
  });
});

describe('infra pack security guidance', () => {
  it('stripePack encodes webhook raw-body signature verification and secret handling', () => {
    const security = stripePack.securityNotes.join('\n');
    expect(security).toContain('constructEvent');
    expect(security).toContain('STRIPE_WEBHOOK_SECRET');
    const failureIds = stripePack.commonFailures.map((failure) => failure.id);
    expect(failureIds).toContain('stripe.fail.webhook-no-signatures');
    expect(failureIds).toContain('stripe.fail.double-charge-on-retry');
  });

  it('dockerPack encodes container hardening (non-root, no secrets in layers)', () => {
    const security = dockerPack.securityNotes.join('\n');
    expect(security).toContain('non-root');
    expect(security.toLowerCase()).toContain('docker history');
  });

  it('kubernetesPack encodes the restricted securityContext and secret handling', () => {
    const security = kubernetesPack.securityNotes.join('\n');
    expect(security).toContain('runAsNonRoot');
    expect(security).toContain('readOnlyRootFilesystem');
    expect(security.toLowerCase()).toContain('base64');
  });

  it('githubActionsPack encodes SHA pinning and least-privilege token guidance', () => {
    const security = githubActionsPack.securityNotes.join('\n');
    expect(security).toContain('commit SHA');
    expect(security).toContain('GITHUB_TOKEN');
    expect(security).toContain('OIDC');
  });

  it('fastapiPack pins the JWT algorithm in its security guidance', () => {
    const security = fastapiPack.securityNotes.join('\n');
    expect(security).toContain('algorithms=["RS256"]');
  });

  it('postgresPack requires parameterized queries and a least-privilege app role', () => {
    const security = postgresPack.securityNotes.join('\n').toLowerCase();
    expect(security).toContain('parameterize');
    // Least-privilege is expressed as the app role holding only the DML it needs,
    // with a separate role for DDL/migrations.
    expect(security).toContain('only the dml it needs');
    expect(security).toContain('separate role');
  });
});
