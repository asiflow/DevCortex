// Typed factories for daemon payloads used across panel tests. Typing the
// return values against the core contract keeps the fixtures honest: if the
// domain shape changes, these stop compiling.
import type {
  DecisionRecord,
  FeatureRecord,
  MemoryItem,
  RunRecord,
  ReadyScore,
} from '../api';

export function makeReadyScore(overrides: Partial<ReadyScore> = {}): ReadyScore {
  return {
    score: 82,
    status: 'READY_WITH_WARNINGS',
    passed: 11,
    blocked: 0,
    warnings: 2,
    ...overrides,
  };
}

export function makeFeature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    id: 'feat-auth',
    feature: 'Passwordless auth',
    status: 'shipped',
    updatedAt: '2026-06-30T12:00:00.000Z',
    purpose: 'Let users sign in without a password',
    userValue: 'Faster, safer sign-in',
    routes: ['/login'],
    components: ['LoginForm'],
    apiEndpoints: ['/api/auth'],
    databaseTables: ['sessions'],
    envVars: ['AUTH_SECRET'],
    dependencies: [],
    protectedBehaviors: ['session integrity'],
    acceptanceCriteria: ['user can sign in'],
    tests: ['auth.test.ts'],
    evidence: [
      { id: 'e1', claim: 'build passes', status: 'verified' },
      { id: 'e2', claim: 'e2e passes', status: 'partial' },
    ],
    knownRisks: ['token rotation not covered'],
    relatedDecisions: [],
    regressionChecks: [],
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'dec-1',
    decision: 'Adopt Zustand for client state',
    context: 'Needed a light state store',
    optionsConsidered: ['Redux', 'Zustand'],
    chosenOption: 'Zustand',
    reason: 'Smaller API surface, no boilerplate',
    tradeoffs: ['less middleware ecosystem'],
    date: '2026-06-28T09:30:00.000Z',
    affectedFiles: ['src/stores'],
    status: 'accepted',
    ...overrides,
  };
}

export function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    dir: '/repo/.cortex/runs/run-1',
    task: 'Implement billing webhook',
    createdAt: '2026-06-30T10:15:00.000Z',
    toolCalls: [],
    commands: ['pnpm test', 'pnpm build'],
    evidenceIds: ['e1', 'e2', 'e3'],
    intentPresent: true,
    contextPresent: true,
    planPresent: false,
    status: 'closed',
    ...overrides,
  };
}

export function makeMemory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem-1',
    type: 'risk',
    title: 'Stripe webhook signature not verified in dev',
    summary: 'Local webhook handler skips signature verification.',
    createdAt: '2026-06-29T08:00:00.000Z',
    updatedAt: '2026-06-29T08:00:00.000Z',
    source: 'agent run run-1',
    confidence: 0.7,
    evidence: [],
    relatedFiles: ['api/webhook.ts'],
    relatedFeatures: ['billing'],
    riskLevel: 'high',
    ...overrides,
  };
}
