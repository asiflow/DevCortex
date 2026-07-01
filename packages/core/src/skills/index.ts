/**
 * Skill Engine (§7.18) — reusable, evidence-based units of engineering behavior.
 * Skills are safely-identified, strictly-validated manifests persisted under
 * `.cortex/skills/` and recommended per task. Deterministic and tokenless (the
 * OSS layer): built-in skills ship with the engine; project / community skills
 * are loaded and validated through the same guard so a malformed or unsafely
 * named skill never reaches a host agent.
 *
 * Public API:
 *   builtInSkills: readonly SkillManifest[]     — the skills that ship with the engine
 *   SkillStore                                  — JSON-ledger-backed registry under .cortex/skills/
 *   skillsDir(root): string                     — resolve a workspace's skills directory
 *   SkillManifestStrictSchema                   — strict runtime schema for a skill manifest
 *   isSafeSkillId(id): boolean                  — reject path-traversal / unsafe skill ids
 *   assertValidSkill(skill, context): void      — throw DevCortexError('...') on a malformed skill
 *   assertUniqueSkillIds(skills, context): void — throw DevCortexError('...') on duplicate ids
 *   loadSkills(root): Promise<SkillManifest[]>   — built-in pack ∪ project skills, deduped/ordered
 *   recommendSkills(task, graph, config): SkillManifest[] — rank skills by task + detected stack
 *   installSkill(root, skill): Promise<void>     — validate then persist a project skill
 *   generateSkillFromFailure(failure): SkillManifest — deterministic skill from a diagnosis
 */
export { builtInSkills } from './built-in';
export { SkillStore, skillsDir } from './skill-store';
export {
  SkillManifestStrictSchema,
  isSafeSkillId,
  assertValidSkill,
  assertUniqueSkillIds,
} from './validation';
export {
  loadSkills,
  recommendSkills,
  installSkill,
  generateSkillFromFailure,
} from './skills';
