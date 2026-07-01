/**
 * Stack packs — best-practice / anti-pattern / version knowledge keyed to a
 * detected stack. Ships the Next.js + TypeScript reference pack with real,
 * current (2026) guidance (App Router, Server Actions, RSC, env safety,
 * server-side Stripe, Supabase SSR auth).
 *
 * Public API (Wave 1):
 *   nextjsPack: StackPack
 *   allPacks: StackPack[]
 *   matchPacks(stack: DetectedStack): StackPack[]
 *
 * Registry integrity is validated at module load: a malformed pack throws a
 * DevCortexError('STACK_PACK_INVALID') rather than silently shipping partial
 * guidance to a host agent.
 */

import { z } from 'zod';

import { DevCortexError, FileKindSchema, RiskLevelSchema } from '../domain/index';
import type { DetectedStack, StackPack } from '../domain/index';

import { nextjsPack } from './nextjs';
import { reactPack } from './react';
import { typescriptPack } from './typescript';
import { tailwindPack } from './tailwind';
import { shadcnPack } from './shadcn';
import { nodePack } from './node';
import { supabasePack } from './supabase';
import { prismaPack } from './prisma';
import { stripePack } from './stripe';
import { vercelPack } from './vercel';
import { fastapiPack } from './fastapi';
import { postgresPack } from './postgres';
import { dockerPack } from './docker';
import { kubernetesPack } from './kubernetes';
import { githubActionsPack } from './github-actions';

export { nextjsPack } from './nextjs';
export { reactPack } from './react';
export { typescriptPack } from './typescript';
export { tailwindPack } from './tailwind';
export { shadcnPack } from './shadcn';
export { nodePack } from './node';
export { supabasePack } from './supabase';
export { prismaPack } from './prisma';
export { stripePack } from './stripe';
export { vercelPack } from './vercel';
export { fastapiPack } from './fastapi';
export { postgresPack } from './postgres';
export { dockerPack } from './docker';
export { kubernetesPack } from './kubernetes';
export { githubActionsPack } from './github-actions';

// --- registry integrity validation -----------------------------------------
// StackPack/Rule/VersionCheck/KnownFailure are not persisted artifacts, so they
// have no domain zod schema. These local schemas exist purely to fail fast if a
// pack in this registry is structurally malformed (empty required arrays, blank
// fields, an invalid severity or appliesTo kind). `matches` is a function and is
// validated separately.

const RuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1),
  severity: RiskLevelSchema,
  appliesTo: z.array(FileKindSchema).min(1).optional(),
});

const VersionCheckSchema = z.object({
  pkg: z.string().min(1),
  supported: z.string().min(1),
  note: z.string().min(1),
});

const KnownFailureSchema = z.object({
  id: z.string().min(1),
  signature: z.string().min(1),
  cause: z.string().min(1),
  fix: z.string().min(1),
});

const nonEmptyStrings = z.array(z.string().min(1)).min(1);

const StackPackDataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  bestPractices: z.array(RuleSchema).min(1),
  antiPatterns: z.array(RuleSchema).min(1),
  recommendedLibraries: nonEmptyStrings,
  versionChecks: z.array(VersionCheckSchema).min(1),
  setupCommands: nonEmptyStrings,
  testCommands: nonEmptyStrings,
  qualityGates: nonEmptyStrings,
  securityNotes: nonEmptyStrings,
  deploymentNotes: nonEmptyStrings,
  commonFailures: z.array(KnownFailureSchema).min(1),
});

function assertValidPack(pack: StackPack): void {
  if (typeof pack.matches !== 'function') {
    throw new DevCortexError('STACK_PACK_INVALID', `stack pack "${pack.id}" is missing a matches() function`, {
      details: { packId: pack.id },
    });
  }

  const parsed = StackPackDataSchema.safeParse(pack);
  if (!parsed.success) {
    throw new DevCortexError(
      'STACK_PACK_INVALID',
      `stack pack "${pack.id}" failed structural validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      { details: parsed.error.issues },
    );
  }

  // Rule ids and KnownFailure ids must be unique within a pack so a host agent
  // never receives two conflicting entries under the same id.
  const ruleIds = [...pack.bestPractices, ...pack.antiPatterns].map((rule) => rule.id);
  const failureIds = pack.commonFailures.map((failure) => failure.id);
  for (const [label, ids] of [
    ['rule', ruleIds],
    ['common-failure', failureIds],
  ] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        throw new DevCortexError('STACK_PACK_INVALID', `stack pack "${pack.id}" has a duplicate ${label} id "${id}"`, {
          details: { packId: pack.id, duplicateId: id },
        });
      }
      seen.add(id);
    }
  }
}

const REGISTERED_PACKS: StackPack[] = [
  nextjsPack,
  reactPack,
  typescriptPack,
  tailwindPack,
  shadcnPack,
  nodePack,
  supabasePack,
  prismaPack,
  stripePack,
  vercelPack,
  fastapiPack,
  postgresPack,
  dockerPack,
  kubernetesPack,
  githubActionsPack,
];

const seenPackIds = new Set<string>();
for (const pack of REGISTERED_PACKS) {
  assertValidPack(pack);
  if (seenPackIds.has(pack.id)) {
    throw new DevCortexError('STACK_PACK_INVALID', `duplicate stack pack id "${pack.id}" in the registry`, {
      details: { packId: pack.id },
    });
  }
  seenPackIds.add(pack.id);
}

/** All stack packs known to the engine. */
export const allPacks: StackPack[] = [...REGISTERED_PACKS];

/**
 * Return every stack pack whose `matches(stack)` predicate is true for the
 * detected stack.
 *
 * @throws DevCortexError('STACK_PACK_INVALID') when `stack` is not a
 *   DetectedStack-shaped object (defends against untrusted callers).
 */
export function matchPacks(stack: DetectedStack): StackPack[] {
  if (stack === null || typeof stack !== 'object' || typeof (stack as Partial<DetectedStack>).framework !== 'string') {
    throw new DevCortexError('STACK_PACK_INVALID', 'matchPacks requires a DetectedStack with a string framework', {
      details: { received: stack },
    });
  }
  return REGISTERED_PACKS.filter((pack) => pack.matches(stack));
}
