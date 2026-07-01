// ============================================================================
// Skill validation — the structural gate every skill passes before it is
// shipped in the built-in pack or persisted to `.cortex/skills/`.
//
// The domain `SkillManifestSchema` (./domain) is the *disk contract*: it proves
// a JSON document is shaped like a SkillManifest. It intentionally allows empty
// arrays and blank strings because that is a valid document. A *useful* skill,
// however, must carry at least one trigger and one checklist step, and its id
// must be a safe file name (skills are stored as `<id>.json`). This module adds
// that stricter, engine-level contract on top of the disk contract, so a hollow
// or path-escaping skill is rejected with a clear SchemaValidationError instead
// of silently shipping useless or unsafe guidance to a host agent.
// ============================================================================

import path from 'node:path';

import { z } from 'zod';

import { SchemaValidationError, SkillStatusSchema } from '../domain/index';
import type { SkillManifest } from '../domain/index';

const SkillCommandStrictSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
});

/**
 * Stricter-than-disk contract for a *usable* skill. Requires non-empty id,
 * name, description, source and timestamps, at least one trigger and one
 * checklist step, and non-blank entries in every string array. `commands`,
 * `antiPatterns` and `mcpRecommendations` may legitimately be empty (a
 * diagnostic-only or generated skill).
 */
export const SkillManifestStrictSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  triggers: z.array(z.string().min(1)).min(1),
  checklist: z.array(z.string().min(1)).min(1),
  commands: z.array(SkillCommandStrictSchema),
  antiPatterns: z.array(z.string().min(1)),
  mcpRecommendations: z.array(z.string().min(1)),
  status: SkillStatusSchema,
  source: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** True when `id` is a single safe path segment (no separators, no traversal). */
export function isSafeSkillId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id === path.basename(id) &&
    !id.includes('..') &&
    !id.includes('/') &&
    !id.includes('\\')
  );
}

/**
 * Assert `skill` is a structurally complete, usable, safely-named SkillManifest.
 *
 * @param context short label woven into the error message (e.g. `"built-in"`,
 *   `"install"`) so the failure points at where the bad skill came from.
 * @throws SchemaValidationError when the skill fails the strict schema or its id
 *   is not a safe entry id.
 */
export function assertValidSkill(skill: SkillManifest, context: string): void {
  const parsed = SkillManifestStrictSchema.safeParse(skill);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new SchemaValidationError(`Invalid skill (${context}): ${detail}`, {
      details: parsed.error.issues,
    });
  }
  if (!isSafeSkillId(skill.id)) {
    throw new SchemaValidationError(
      `Invalid skill (${context}): id "${skill.id}" is not a safe entry id (skills are stored as <id>.json).`,
      { details: { id: skill.id } },
    );
  }
}

/**
 * Assert every skill id in `skills` is unique, so a registry can never ship two
 * conflicting entries under the same id (and a project skill file never collides
 * with itself). Order-preserving; throws on the first duplicate.
 *
 * @throws SchemaValidationError on the first repeated id.
 */
export function assertUniqueSkillIds(skills: readonly SkillManifest[], context: string): void {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.id)) {
      throw new SchemaValidationError(`Duplicate skill id "${skill.id}" (${context}).`, {
        details: { id: skill.id },
      });
    }
    seen.add(skill.id);
  }
}
