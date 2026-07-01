// ============================================================================
// Sub-project #2 domain contract — Agent Flight Recorder (§7.16).
//
// A `RunRecord` is the PERSISTED index for a recorded agent session, stored at
// `.cortex/runs/<id>/record.json`. It points at the sibling artifacts the
// recorder writes into the same directory (prompt.md, intent.md, context.md,
// plan.md, toolcalls.jsonl, ship-report.md, learning.md, …) and captures the
// coverage flags the "learn from outcome" stage keys off.
//
// Additive to the frozen contract in ./types + ./schemas.
// ============================================================================

import { z } from 'zod';

// --- enums ------------------------------------------------------------------

/** Whether a recorded run is still accepting artifacts (`open`) or sealed (`closed`). */
export const RUN_STATUSES = ['open', 'closed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// --- interfaces -------------------------------------------------------------

/** Persisted index of one recorded run — `.cortex/runs/<id>/record.json`. */
export interface RunRecord {
  id: string;
  /** absolute path to this run's directory under `.cortex/runs/` */
  dir: string;
  task: string;
  createdAt: string;
  prompt?: string;
  /** raw captured tool-call payloads; shape is host-agent-specific, hence unknown */
  toolCalls: unknown[];
  commands: string[];
  evidenceIds: string[];
  shipReportPath?: string;
  learning?: string;
  /** true once compiled intent was captured for this run */
  intentPresent: boolean;
  /** true once a context pack was captured for this run */
  contextPresent: boolean;
  /** true once an agent plan was captured for this run */
  planPresent: boolean;
  status: RunStatus;
}

// --- schemas (disk boundary) ------------------------------------------------

export const RunStatusSchema = z.enum(RUN_STATUSES);

export const RunRecordSchema = z.object({
  id: z.string(),
  dir: z.string(),
  task: z.string(),
  createdAt: z.string(),
  prompt: z.string().optional(),
  toolCalls: z.array(z.unknown()),
  commands: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  shipReportPath: z.string().optional(),
  learning: z.string().optional(),
  intentPresent: z.boolean(),
  contextPresent: z.boolean(),
  planPresent: z.boolean(),
  status: RunStatusSchema,
});

// --- compile-time drift guard -----------------------------------------------

type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : false) : false;

function assertMatch<_T extends true>(): void {
  /* compile-time only */
}

assertMatch<MutuallyAssignable<z.infer<typeof RunRecordSchema>, RunRecord>>();
