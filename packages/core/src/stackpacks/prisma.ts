/**
 * Prisma ORM reference stack pack.
 *
 * Real, current (2026) guidance for Prisma ORM v6: migrate dev locally /
 * migrate deploy in production (never db push in prod), a single shared
 * PrismaClient instance (the Next.js dev-HMR / serverless connection-exhaustion
 * trap), pooled vs direct connection URLs, explicit select/include to avoid
 * over-fetching and N+1, $transaction for invariants, parameterised $queryRaw,
 * and generating the client in CI. Applies to JS/TS server frameworks
 * (Next.js, Node, Express) or a "prisma" hint.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// Prisma is a Node/TS server-side ORM. Match server-capable JS/TS frameworks,
// or an explicit "prisma" hint.
const PRISMA_FRAMEWORKS = ['nextjs', 'node', 'express'];
const JS_LANGUAGES = ['typescript', 'javascript'];

const bestPractices: Rule[] = [
  {
    id: 'prisma.migrate-deploy-in-prod',
    title: 'Use migrate dev locally and migrate deploy in CI/production',
    detail:
      '`prisma migrate dev` authors and applies migrations against your dev database; `prisma migrate deploy` applies the already-committed migration files non-interactively in CI/production. This keeps a reviewable, ordered migration history and never prompts or resets in prod.',
    severity: 'high',
    appliesTo: ['migration', 'schema'],
  },
  {
    id: 'prisma.single-client-instance',
    title: 'Instantiate exactly one PrismaClient and share it',
    detail:
      'Create PrismaClient once and export the singleton. In Next.js dev, stash it on globalThis so hot-module-reload does not spawn a new client (and a new pool) on every reload; in long-running services instantiate it at module scope. Each client holds its own connection pool, so many clients exhaust the database.',
    severity: 'high',
    appliesTo: ['service', 'lib', 'config'],
  },
  {
    id: 'prisma.pooled-and-direct-urls',
    title: 'Use a pooled URL for the app and a direct URL for migrations',
    detail:
      'In serverless/edge, route queries through a connection pooler (PgBouncer / Prisma Accelerate) via DATABASE_URL, and set directUrl to a direct connection for `migrate`/`db` commands (which need a session, not a transaction-mode pooler). Direct connections from many serverless instances otherwise blow past Postgres max_connections.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'prisma.explicit-select',
    title: 'Select only the fields you need',
    detail:
      'Use select (or a narrow include) to fetch exactly the columns/relations required rather than returning whole rows and every relation. Explicit selection reduces payload, avoids accidentally leaking sensitive columns (password hashes, tokens), and keeps queries fast.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'prisma.avoid-n-plus-1',
    title: 'Batch related reads with include/nested queries, not per-row loops',
    detail:
      'Fetching a list and then querying each item\'s relation in a loop issues N+1 queries. Use include / nested select to load relations in one round trip, or findMany with a where...in, and rely on Prisma\'s automatic query batching where applicable.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'prisma.transactions-for-invariants',
    title: 'Wrap multi-write invariants in a transaction',
    detail:
      'When several writes must all succeed or all fail (e.g. debit + credit, create + audit), use prisma.$transaction (array or interactive callback form) so a partial failure rolls back. Interactive transactions also let you enforce read-then-write consistency.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'prisma.parameterised-raw',
    title: 'Use tagged-template $queryRaw for any raw SQL — never $queryRawUnsafe with input',
    detail:
      'Prefer the query builder; when raw SQL is unavoidable use the tagged-template prisma.$queryRaw`... ${value}` form, which parameterises interpolations. Reserve $queryRawUnsafe for fully static SQL and never concatenate user input into it — that is a SQL-injection hole.',
    severity: 'high',
    appliesTo: ['service'],
  },
  {
    id: 'prisma.generate-in-build',
    title: 'Run prisma generate as part of install/build',
    detail:
      'The typed Prisma Client is code-generated from schema.prisma, so add prisma generate to a postinstall or build step. In CI and container builds this guarantees the client matches the current schema; a stale or missing generated client causes runtime initialization errors.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'prisma.never-edit-applied-migrations',
    title: 'Treat applied migrations as immutable; add new ones to change schema',
    detail:
      'Once a migration has been applied to a shared/production database, editing its SQL causes drift and checksum failures. To change the schema, edit schema.prisma and generate a new migration; only unapplied local migrations are safe to rewrite.',
    severity: 'high',
    appliesTo: ['migration'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'prisma.anti.client-per-request',
    title: 'Constructing new PrismaClient() per request or per module',
    detail:
      'A new client on each request (or a new one created on every Next.js HMR reload) opens a fresh connection pool each time, quickly exhausting the database\'s connection limit. Instantiate once and reuse the singleton.',
    severity: 'high',
    appliesTo: ['service', 'lib'],
  },
  {
    id: 'prisma.anti.db-push-in-prod',
    title: 'Running prisma db push against production',
    detail:
      'db push force-syncs the schema with no migration history and can drop columns/data to make the database match. It is a prototyping tool; in production use migrate deploy so changes are ordered, reviewed, and reversible.',
    severity: 'critical',
    appliesTo: ['migration'],
  },
  {
    id: 'prisma.anti.raw-unsafe-with-input',
    title: 'Interpolating user input into $queryRawUnsafe / $executeRawUnsafe',
    detail:
      '$queryRawUnsafe(`... WHERE name = \'${input}\'`) concatenates input directly into SQL — a classic injection vector. Use the tagged-template $queryRaw (parameterised) or the query builder, and keep Unsafe variants for static SQL only.',
    severity: 'critical',
    appliesTo: ['service'],
  },
  {
    id: 'prisma.anti.n-plus-1-loop',
    title: 'Querying relations inside a loop (N+1)',
    detail:
      'for (const u of users) { await prisma.post.findMany({ where: { userId: u.id } }) } fires one query per user. Load the relation with include on the initial findMany, or a single findMany with where userId in [...], to collapse it to one or two queries.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'prisma.anti.direct-conn-serverless',
    title: 'Direct database connections from serverless functions',
    detail:
      'Each serverless invocation with a direct connection opens (and slowly releases) a Postgres connection; under concurrency this exceeds max_connections and requests fail. Route app traffic through a pooler and keep the direct URL only for migrations.',
    severity: 'high',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'prisma.anti.edit-applied-migration',
    title: 'Editing a migration that has already been applied',
    detail:
      'Changing the SQL of an applied migration makes its checksum mismatch the recorded one, so Prisma reports drift and can refuse to proceed. Never rewrite history; add a new migration for the change.',
    severity: 'high',
    appliesTo: ['migration'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'prisma',
    supported: '^6',
    note: 'Prisma ORM v6 (CLI). Requires a current Node (18.18+/20+). Review the v6 upgrade notes for the generated-client output location and driver-adapter changes before bumping.',
  },
  {
    pkg: '@prisma/client',
    supported: '^6',
    note: 'Keep @prisma/client in lockstep with the prisma CLI major; a client/CLI skew produces generation and runtime mismatches.',
  },
  {
    pkg: 'typescript',
    supported: '^5',
    note: 'TypeScript 5.x consumes the generated types; run prisma generate before typechecking so the client types exist.',
  },
  {
    pkg: 'pg',
    supported: '^8',
    note: 'When using the Postgres driver adapter (or a pooler like PgBouncer) the pg driver 8.x is the common baseline; align it with your pooling setup.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'prisma.fail.too-many-connections',
    signature:
      '"Too many connections" (Postgres 53300) or "Timed out fetching a new connection from the connection pool", typically in serverless',
    cause: 'Many client instances / direct serverless connections opened more pools than the database allows, or the pool size is too large for the replica count.',
    fix: 'Use a single PrismaClient singleton, route queries through a pooler (PgBouncer/Accelerate) with DATABASE_URL, keep directUrl only for migrations, and size the pool so replicas × pool ≤ max_connections.',
  },
  {
    id: 'prisma.fail.hmr-many-instances',
    signature: 'Next.js dev warning: "There are already 10 instances of Prisma Client actively running"',
    cause: 'Hot-module-reload re-ran the module that does new PrismaClient(), creating a new client (and pool) on each reload.',
    fix: 'Cache the client on globalThis in development (const prisma = globalThis.prisma ?? new PrismaClient(); if (dev) globalThis.prisma = prisma) so HMR reuses one instance.',
  },
  {
    id: 'prisma.fail.migrate-drift',
    signature: '"Drift detected: Your database schema is not in sync with your migration history" / migration checksum mismatch',
    cause: 'The database was changed outside migrations (manual SQL/db push) or an already-applied migration file was edited.',
    fix: 'Reconcile by generating a new migration from the current schema (or migrate resolve for a known state); never edit applied migrations, and stop using db push on a migrated database.',
  },
  {
    id: 'prisma.fail.client-not-generated',
    signature: '"@prisma/client did not initialize yet. Please run \'prisma generate\'"',
    cause: 'The generated client is missing or stale — prisma generate did not run after install or after a schema change.',
    fix: 'Add prisma generate to a postinstall/build script and re-run it; ensure the build environment regenerates the client from the current schema.prisma.',
  },
  {
    id: 'prisma.fail.p1001-unreachable',
    signature: "Error P1001: Can't reach database server at ...",
    cause: 'DATABASE_URL is wrong/unreachable, the pooler is down, SSL/sslmode is misconfigured, or a firewall/network rule blocks the connection.',
    fix: 'Verify the connection string (host, port, sslmode), that the pooler/database is reachable from the runtime, and that migrations use directUrl where a session connection is required.',
  },
  {
    id: 'prisma.fail.shadow-db-permission',
    signature: 'migrate dev fails: shadow database could not be created / insufficient privileges',
    cause: 'prisma migrate dev creates a temporary shadow database to detect drift, but the connection role lacks CREATE DATABASE (common on hosted Postgres).',
    fix: 'Grant the dev role permission, or configure a dedicated shadowDatabaseUrl pointing at a database the role can use; production (migrate deploy) does not need a shadow database.',
  },
];

/**
 * The Prisma ORM reference pack. Matches a server-capable JS/TS framework
 * (Next.js / Node / Express) or an explicit "prisma" deployment-target hint.
 */
export const prismaPack: StackPack = {
  id: 'prisma',
  name: 'Prisma ORM v6 (Postgres)',
  matches: (stack) =>
    stack.deploymentTargets.includes('prisma') ||
    (JS_LANGUAGES.includes(stack.language) && PRISMA_FRAMEWORKS.includes(stack.framework)),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'prisma@^6',
    '@prisma/client@^6',
    'typescript@^5',
    'zod@^3',
    'pg@^8',
    'vitest@^2',
  ],
  versionChecks,
  setupCommands: [
    'pnpm add @prisma/client',
    'pnpm add -D prisma',
    'pnpm exec prisma init --datasource-provider postgresql',
    'pnpm exec prisma migrate dev --name init',
    'pnpm exec prisma generate',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec prisma validate',
    'pnpm exec prisma migrate status',
    'pnpm exec vitest run',
  ],
  qualityGates: [
    'Schema changes ship as committed migration files; production applies them with `prisma migrate deploy` (never db push).',
    'Exactly one PrismaClient instance is shared (globalThis singleton in Next dev); no per-request construction.',
    'The app connects through a pooler in serverless (DATABASE_URL) with a separate directUrl for migrations.',
    'Queries use explicit select/include (no accidental over-fetch of sensitive columns) and avoid N+1 loops.',
    'Multi-write invariants run inside $transaction; raw SQL uses the parameterised tagged-template $queryRaw.',
    '`prisma generate` runs in install/build, `prisma validate` passes, and `prisma migrate status` shows no drift.',
  ],
  securityNotes: [
    'Never interpolate user input into $queryRawUnsafe/$executeRawUnsafe — use the parameterised tagged-template $queryRaw or the query builder to prevent SQL injection.',
    'Use explicit select so queries cannot accidentally return sensitive columns (password hashes, tokens, secrets) to callers.',
    'Keep DATABASE_URL/DIRECT_URL and any pooler credentials in server-only secrets; they are full database access and must never reach a client bundle.',
    'Prisma does not enforce row-level authorization — scope every query by the authenticated user in application code (or pair with database RLS); the ORM will happily return another tenant\'s rows if you ask.',
    'Run migrations with a least-privilege role, and review generated SQL (especially destructive column drops) before applying to production.',
  ],
  deploymentNotes: [
    'Run `prisma migrate deploy` as a dedicated release step before the new app version serves traffic; it applies committed migrations non-interactively.',
    'Set DATABASE_URL to the pooled connection and DIRECT_URL to a direct connection so the app pools while migrations get a session connection.',
    'Run `prisma generate` during the container/CI build so the generated client is present and matches the schema at runtime.',
    'Size connection pools to replica count × per-instance pool under the database max_connections; prefer a pooler (PgBouncer/Accelerate) for serverless and high fan-out.',
    'Make migrations forward-compatible for zero-downtime deploys (expand-then-contract: add columns before the old code stops writing, drop only after it is gone).',
  ],
  commonFailures,
};
