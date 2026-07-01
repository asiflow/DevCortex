/**
 * Sub-project #2 domain-contract tests — Intelligence & Learning.
 *
 * These exercise the disk-boundary validators for the four PERSISTED artifacts
 * (SkillManifest, WorkflowRun, RunRecord, LearnedFailure): each valid fixture
 * must parse, and representative malformed inputs must be rejected. Council is a
 * computed (non-persisted) artifact, so it is covered at the type/const level.
 *
 * No mocks: the schemas run exactly as they will at the `.cortex/` read boundary.
 */
import { describe, expect, it } from 'vitest';

import {
  LearnedFailureSchema,
  REVIEWER_LENSES,
  RunRecordSchema,
  SkillManifestSchema,
  WorkflowRunSchema,
} from './index';
import type { CouncilReport, LearnedFailure, RunRecord, SkillManifest, WorkflowRun } from './index';

// --- fixtures ----------------------------------------------------------------

const skill: SkillManifest = {
  id: 'skill-1',
  name: 'stripe-webhook-hardening',
  description: 'Verify Stripe webhook signatures against the raw body before parsing.',
  triggers: ['stripe', 'webhook', 'billing'],
  checklist: ['constructEvent on raw body', 'dedup by event.id', 'no secret in source'],
  commands: [{ name: 'test:webhooks', run: 'pnpm vitest run webhooks' }],
  antiPatterns: ['parsing JSON before signature verification'],
  mcpRecommendations: ['stripe-docs'],
  status: 'verified',
  source: 'built-in',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const run: WorkflowRun = {
  id: 'wfr-1',
  workflowId: 'billing.add',
  task: 'Add usage-based billing',
  riskLevel: 'high',
  startedAt: '2026-07-01T00:00:00.000Z',
  finishedAt: '2026-07-01T00:10:00.000Z',
  status: 'completed',
  stages: [
    { stage: 'classify', status: 'ok', detail: 'classified as billing/high', evidenceIds: [] },
    { stage: 'verify', status: 'ok', detail: 'gates green', evidenceIds: ['ev-1'] },
  ],
};

const record: RunRecord = {
  id: 'run-2026-07-01-00-00',
  dir: '/repo/.cortex/runs/run-2026-07-01-00-00',
  task: 'Add usage-based billing',
  createdAt: '2026-07-01T00:00:00.000Z',
  prompt: 'Add metered billing to the checkout flow',
  toolCalls: [{ tool: 'edit', path: 'src/billing.ts' }, 42, 'freeform'],
  commands: ['pnpm build', 'pnpm test'],
  evidenceIds: ['ev-1', 'ev-2'],
  shipReportPath: '.cortex/runs/run-2026-07-01-00-00/ship-report.md',
  learning: 'Webhook dedup was missing on first attempt.',
  intentPresent: true,
  contextPresent: true,
  planPresent: false,
  status: 'open',
};

const failure: LearnedFailure = {
  id: 'kf-1',
  signature: 'supabase auth redirect loop in middleware',
  occurrences: 3,
  diagnosis: { cause: 'session read outside middleware', category: 'missing-skill' },
  remedyKind: 'skill',
  remedyRef: 'supabase-auth-middleware-hardening',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

// --- SkillManifest -----------------------------------------------------------

describe('SkillManifestSchema', () => {
  it('parses a valid manifest and preserves nested commands', () => {
    const parsed = SkillManifestSchema.parse(skill);
    expect(parsed.commands[0]).toEqual({ name: 'test:webhooks', run: 'pnpm vitest run webhooks' });
  });

  it('parses each built-in status', () => {
    for (const status of ['built-in', 'verified', 'experimental'] as const) {
      expect(SkillManifestSchema.parse({ ...skill, status }).status).toBe(status);
    }
  });

  it('rejects an unknown status', () => {
    expect(SkillManifestSchema.safeParse({ ...skill, status: 'draft' }).success).toBe(false);
  });

  it('rejects a command missing its run string', () => {
    const bad = { ...skill, commands: [{ name: 'x' }] };
    expect(SkillManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { triggers: _drop, ...bad } = skill;
    expect(SkillManifestSchema.safeParse(bad).success).toBe(false);
  });
});

// --- WorkflowRun -------------------------------------------------------------

describe('WorkflowRunSchema', () => {
  it('parses a valid run with stage outcomes', () => {
    const parsed = WorkflowRunSchema.parse(run);
    expect(parsed.stages).toHaveLength(2);
  });

  it('parses without the optional finishedAt', () => {
    const { finishedAt: _drop, ...open } = run;
    expect(WorkflowRunSchema.safeParse(open).success).toBe(true);
  });

  it('rejects an unknown workflow id', () => {
    expect(WorkflowRunSchema.safeParse({ ...run, workflowId: 'feature.magic' }).success).toBe(false);
  });

  it('rejects an unknown stage name inside a stage outcome', () => {
    const bad = { ...run, stages: [{ ...run.stages[0], stage: 'teleport' }] };
    expect(WorkflowRunSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown run status', () => {
    expect(WorkflowRunSchema.safeParse({ ...run, status: 'pending' }).success).toBe(false);
  });

  it('rejects an invalid risk level', () => {
    expect(WorkflowRunSchema.safeParse({ ...run, riskLevel: 'extreme' }).success).toBe(false);
  });
});

// --- RunRecord ---------------------------------------------------------------

describe('RunRecordSchema', () => {
  it('parses a valid record with heterogeneous toolCalls', () => {
    const parsed = RunRecordSchema.parse(record);
    expect(parsed.toolCalls).toHaveLength(3);
    expect(parsed.status).toBe('open');
  });

  it('parses without optional prompt/shipReportPath/learning', () => {
    const { prompt: _p, shipReportPath: _s, learning: _l, ...minimal } = record;
    expect(RunRecordSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects a non-boolean coverage flag', () => {
    expect(RunRecordSchema.safeParse({ ...record, intentPresent: 'yes' }).success).toBe(false);
  });

  it('rejects a non-array toolCalls', () => {
    expect(RunRecordSchema.safeParse({ ...record, toolCalls: {} }).success).toBe(false);
  });

  it('rejects an unknown run status', () => {
    expect(RunRecordSchema.safeParse({ ...record, status: 'archived' }).success).toBe(false);
  });
});

// --- LearnedFailure ----------------------------------------------------------

describe('LearnedFailureSchema', () => {
  it('parses a valid learned failure with nested diagnosis', () => {
    const parsed = LearnedFailureSchema.parse(failure);
    expect(parsed.diagnosis.category).toBe('missing-skill');
  });

  it('parses without the optional remedyRef', () => {
    const { remedyRef: _drop, ...bare } = failure;
    expect(LearnedFailureSchema.safeParse(bare).success).toBe(true);
  });

  it('rejects an unknown diagnosis category', () => {
    const bad = { ...failure, diagnosis: { cause: 'x', category: 'cosmic-rays' } };
    expect(LearnedFailureSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown remedy kind', () => {
    expect(LearnedFailureSchema.safeParse({ ...failure, remedyKind: 'prayer' }).success).toBe(false);
  });

  it('rejects a negative or fractional occurrence count', () => {
    expect(LearnedFailureSchema.safeParse({ ...failure, occurrences: -1 }).success).toBe(false);
    expect(LearnedFailureSchema.safeParse({ ...failure, occurrences: 1.5 }).success).toBe(false);
  });
});

// --- Council (computed, non-persisted) --------------------------------------

describe('council contract', () => {
  it('exposes the nine reviewer lenses', () => {
    expect(REVIEWER_LENSES).toHaveLength(9);
    expect(REVIEWER_LENSES).toContain('security');
    expect(REVIEWER_LENSES).toContain('ui-ux');
  });

  it('models a report as a well-typed computed value', () => {
    const report: CouncilReport = {
      task: 'Add usage-based billing',
      lenses: ['architect', 'security', 'devops', 'qa'],
      findings: [
        {
          lens: 'security',
          severity: 'high',
          title: 'Webhook signature not verified on raw body',
          detail: 'constructEvent must run before JSON parsing.',
          file: 'src/billing.ts',
        },
      ],
      generatedAt: '2026-07-01T00:00:00.000Z',
    };
    expect(report.findings[0]?.lens).toBe('security');
    expect(report.lenses).toContain('architect');
  });
});
