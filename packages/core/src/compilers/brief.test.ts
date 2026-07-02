/**
 * Tests for `composeSessionBrief` — the 2 KB session-start project brief.
 *
 * Fixture idiom mirrors `packages/core/src/ledgers/ledgers.test.ts`:
 * a fresh `mkdtemp` root per test, cleaned up via `afterEach`. No mocks;
 * real JSON files on disk, real ledger validation on every read and write.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DecisionLedger, FeatureLedger, MemoryLedger } from '../ledgers/index';
import type { DecisionInput, FeatureInput, MemoryInput } from '../ledgers/index';
import { defaultConfig, saveConfig } from '../workspace/index';

import { composeSessionBrief } from './brief';

// --- fixture -----------------------------------------------------------------

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
    expect(brief.text).toContain('devcortex init');
    expect(brief.bytes).toBe(Buffer.byteLength(brief.text, 'utf8'));
  });

  it('renders all five sections with seeded ledgers within 2048 bytes', async () => {
    await seedWorkspace();

    const memory = new MemoryLedger(root);
    const feature = new FeatureLedger(root);
    const decision = new DecisionLedger(root);

    // Seed: 5 risk memories (top 3 shown, sorted by riskLevel desc then confidence desc)
    await memory.add(memoryInput({ riskLevel: 'critical', confidence: 0.95, title: 'Critical auth flaw' }));
    await memory.add(memoryInput({ riskLevel: 'high', confidence: 0.9, title: 'High risk: token expiry' }));
    await memory.add(memoryInput({ riskLevel: 'high', confidence: 0.8, title: 'High risk: DB injection' }));
    await memory.add(memoryInput({ riskLevel: 'medium', confidence: 0.7, title: 'Medium risk: rate limit' }));
    await memory.add(memoryInput({ riskLevel: 'low', confidence: 0.5, title: 'Low risk: logging noise' }));

    // Seed: 4 building features (top 3 shown)
    await feature.add(featureInput({ feature: 'Billing' }));
    await feature.add(featureInput({ feature: 'SSO' }));
    await feature.add(featureInput({ feature: 'Audit log' }));
    await feature.add(featureInput({ feature: 'Dark mode' }));

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

    // Section 2: Top risks — top 3 by severity
    expect(brief.text).toContain('## Top risks');
    expect(brief.text).toContain('[critical] Critical auth flaw');
    expect(brief.text).toContain('[high] High risk: token expiry');
    expect(brief.text).toContain('[high] High risk: DB injection');
    // 4th and 5th risk must NOT appear
    expect(brief.text).not.toContain('Medium risk: rate limit');
    expect(brief.text).not.toContain('Low risk: logging noise');

    // Section 3: In-flight features — top 3
    expect(brief.text).toContain('## In-flight features');

    // Section 4: Recent decisions — 2 newest
    expect(brief.text).toContain('## Recent decisions');
    expect(brief.text).toContain('Ship via Vercel');
    expect(brief.text).toContain('Adopt pnpm monorepo');
    // Oldest decision must NOT appear
    expect(brief.text).not.toContain('Use RS256 JWT');

    // Section 5: Protected paths — from defaultConfig
    expect(brief.text).toContain('## Protected paths');
  });

  it('stays within 2048 bytes with 50 seeded risk memories (overflow truncation)', async () => {
    await seedWorkspace();

    const memory = new MemoryLedger(root);
    for (let i = 0; i < 50; i++) {
      await memory.add(
        memoryInput({
          riskLevel: 'critical',
          confidence: 0.9,
          title: `Critical risk number ${i + 1} with a long descriptive title for byte stress`,
        }),
      );
    }

    const brief = await composeSessionBrief(root);

    expect(brief.uninitialized).toBe(false);
    expect(brief.bytes).toBeLessThanOrEqual(2048);
    expect(brief.bytes).toBe(Buffer.byteLength(brief.text, 'utf8'));
    // Header must always survive
    expect(brief.text).toContain('CORTEX BRIEF');
  });

  it('produces identical output on two consecutive calls (deterministic)', async () => {
    await seedWorkspace();

    const memory = new MemoryLedger(root);
    const decision = new DecisionLedger(root);

    await memory.add(memoryInput({ title: 'Determinism check risk', riskLevel: 'high' }));
    await decision.add(decisionInput({ decision: 'Determinism check decision', date: '2026-07-01T00:00:00.000Z' }));

    const first = await composeSessionBrief(root);
    const second = await composeSessionBrief(root);

    expect(first.text).toBe(second.text);
    expect(first.bytes).toBe(second.bytes);
    expect(first.uninitialized).toBe(second.uninitialized);
  });
});
