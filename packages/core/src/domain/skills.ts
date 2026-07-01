// ============================================================================
// Sub-project #2 domain contract — Skill Engine (§7.18).
//
// A skill is a reusable, evidence-based unit of engineering behaviour that the
// engine can recommend, install, generate from repeated failures, and mark as
// verified/experimental. Skill manifests are PERSISTED under `.cortex/skills/`,
// so this file owns both the canonical interface and its runtime zod validator,
// wired together by the compile-time drift guard at the bottom (mirrors the
// pattern in ./schemas).
//
// Additive to the frozen contract in ./types + ./schemas — nothing here mutates
// those files. Convention: relative imports omit extensions; unions are declared
// as `as const` string arrays; interfaces own object shapes.
// ============================================================================

import { z } from 'zod';

// --- enums ------------------------------------------------------------------

/**
 * Lifecycle/trust status of a skill.
 * - `built-in`     — shipped with DevCortex.
 * - `verified`     — proven by evidence (its checklist + commands succeeded).
 * - `experimental` — generated or imported but not yet evidence-backed.
 */
export const SKILL_STATUSES = ['built-in', 'verified', 'experimental'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

// --- interfaces -------------------------------------------------------------

/** A named, runnable command a skill contributes (e.g. a hardening check). */
export interface SkillCommand {
  name: string;
  /** shell command line; executed by the gate/command runner, never eval'd */
  run: string;
}

/** Persisted skill manifest — one JSON document under `.cortex/skills/`. */
export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  /** task signals / keywords that make this skill relevant */
  triggers: string[];
  /** ordered engineering checklist the skill enforces */
  checklist: string[];
  commands: SkillCommand[];
  antiPatterns: string[];
  mcpRecommendations: string[];
  status: SkillStatus;
  /** provenance, e.g. `built-in`, `project-generated`, or a registry ref */
  source: string;
  createdAt: string;
  updatedAt: string;
}

// --- schemas (disk boundary) ------------------------------------------------

export const SkillStatusSchema = z.enum(SKILL_STATUSES);

export const SkillCommandSchema = z.object({
  name: z.string(),
  run: z.string(),
});

export const SkillManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  checklist: z.array(z.string()),
  commands: z.array(SkillCommandSchema),
  antiPatterns: z.array(z.string()),
  mcpRecommendations: z.array(z.string()),
  status: SkillStatusSchema,
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// --- compile-time drift guard -----------------------------------------------
// Mutual assignability, not strict identity, so zod's optional representation
// does not produce pedantic false positives (mirrors ./schemas).

type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : false) : false;

function assertMatch<_T extends true>(): void {
  /* compile-time only */
}

assertMatch<MutuallyAssignable<z.infer<typeof SkillCommandSchema>, SkillCommand>>();
assertMatch<MutuallyAssignable<z.infer<typeof SkillManifestSchema>, SkillManifest>>();
