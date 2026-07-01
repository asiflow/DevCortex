/**
 * Supabase reference stack pack.
 *
 * Real, current (2026) guidance for Supabase (Postgres + Auth + Storage + Edge
 * Functions): Row Level Security on every exposed table, server-side identity via
 * auth.getUser() (not getSession()), the service_role key as a server-only,
 * RLS-bypassing secret, the @supabase/ssr cookie pattern for SSR frameworks,
 * migration-as-code via the CLI, storage policies, and generated types. Applies
 * to JS/TS apps (Next.js, React, Vite, Node, Express) or a "supabase" hint.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// Supabase is consumed by JS/TS web and server apps. Match those frameworks
// when the language is JS/TS, or an explicit "supabase" deployment-target hint.
const SUPABASE_FRAMEWORKS = ['nextjs', 'react', 'vite', 'node', 'express'];
const JS_LANGUAGES = ['typescript', 'javascript'];

const bestPractices: Rule[] = [
  {
    id: 'supabase.rls-on-every-table',
    title: 'Enable Row Level Security on every table the anon/authenticated key can reach',
    detail:
      'The anon and authenticated API keys are public and reach Postgres directly through PostgREST. RLS policies are the authorization boundary: enable RLS on every exposed table and write explicit policies (typically scoping rows to auth.uid()). A table with RLS off is fully readable/writable by anyone with the anon key.',
    severity: 'critical',
    appliesTo: ['migration', 'schema', 'auth'],
  },
  {
    id: 'supabase.getuser-server',
    title: 'Authenticate on the server with auth.getUser(), not getSession()',
    detail:
      'auth.getUser() revalidates the JWT against the Supabase Auth server and returns a trustworthy user; getSession() only decodes the cookie locally without verifying it. Gate every server-side authorization decision on getUser() (or getClaims()); reserve getSession() for non-security reads.',
    severity: 'critical',
    appliesTo: ['auth', 'middleware', 'api'],
  },
  {
    id: 'supabase.service-role-server-only',
    title: 'Keep the service_role key server-only — it bypasses RLS',
    detail:
      'The service_role key ignores Row Level Security and has full database access. Use it only in trusted server code (Route Handlers, server actions, backend jobs), read it from an unprefixed env var, and never expose it to the browser or a client bundle. Anything it does is unauthenticated by RLS, so guard those code paths yourself.',
    severity: 'critical',
    appliesTo: ['service', 'env', 'config'],
  },
  {
    id: 'supabase.ssr-cookie-client',
    title: 'Use @supabase/ssr with getAll/setAll for SSR frameworks',
    detail:
      'For Next.js/SSR create the per-request server client with createServerClient from @supabase/ssr, supplying getAll and setAll cookie handlers, and call getUser() in middleware to refresh tokens. Without setAll writing the refreshed tokens back, sessions silently expire and users are logged out at random.',
    severity: 'high',
    appliesTo: ['middleware', 'auth'],
  },
  {
    id: 'supabase.anon-key-is-public',
    title: 'Treat the anon key as public and rely on RLS, not on hiding it',
    detail:
      'The anon key is meant to ship to the browser; it is not a secret and cannot be "protected". Security comes entirely from RLS policies plus verified auth, so never assume client code or a hidden key restricts access — the database policies must.',
    severity: 'high',
    appliesTo: ['auth', 'config'],
  },
  {
    id: 'supabase.migrations-as-code',
    title: 'Manage schema and policies with CLI migrations, not dashboard clicks',
    detail:
      'Use `supabase migration new` / `supabase db push` (or link + migrate) so schema, RLS policies, and functions live in version control and deploy reproducibly across environments. Ad-hoc dashboard edits drift from the repo and cannot be reviewed or rolled back.',
    severity: 'medium',
    appliesTo: ['migration', 'schema'],
  },
  {
    id: 'supabase.storage-policies',
    title: 'Write access policies for Storage buckets too',
    detail:
      'Supabase Storage is backed by Postgres and governed by RLS-style policies on storage.objects. A "public" bucket is world-readable; for private files write policies that scope objects to the owning user and keep buckets private by default.',
    severity: 'high',
    appliesTo: ['auth', 'schema'],
  },
  {
    id: 'supabase.generate-types',
    title: 'Generate TypeScript types from the database schema',
    detail:
      'Run `supabase gen types typescript` and parameterise the client (createClient<Database>) so query results are typed against the live schema. Regenerate the types in CI when migrations change so the app and the database cannot silently drift.',
    severity: 'low',
    appliesTo: ['schema', 'config'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'supabase.anti.service-role-in-client',
    title: 'Shipping the service_role key to the browser',
    detail:
      'Putting service_role behind NEXT_PUBLIC_/VITE_ or using it in client code exposes an RLS-bypassing, full-access database key to every visitor — a total data breach. Use only the anon key on the client; keep service_role in server env and rotate it immediately if leaked.',
    severity: 'critical',
    appliesTo: ['env', 'service'],
  },
  {
    id: 'supabase.anti.rls-disabled',
    title: 'Leaving RLS disabled on an exposed table',
    detail:
      'A table reachable by the anon key with RLS off is open to anyone: full read and, depending on grants, write. "We check it in the UI" is not protection because the REST/GraphQL endpoint is directly callable. Enable RLS and add policies before shipping.',
    severity: 'critical',
    appliesTo: ['migration', 'schema'],
  },
  {
    id: 'supabase.anti.getsession-authz',
    title: 'Authorizing server actions on auth.getSession()',
    detail:
      'getSession() returns the decoded cookie without verifying it against the Auth server, so a forged/expired token can pass. Any server-side access decision built on getSession() is bypassable; use getUser().',
    severity: 'high',
    appliesTo: ['auth', 'middleware'],
  },
  {
    id: 'supabase.anti.client-authz-only',
    title: 'Relying on client-side checks instead of RLS',
    detail:
      'Hiding a button or filtering rows in the client does nothing at the API layer — the anon key can query the table directly. Enforce every access rule in RLS policies; client checks are UX only.',
    severity: 'high',
    appliesTo: ['auth', 'component'],
  },
  {
    id: 'supabase.anti.trust-client-user-id',
    title: 'Filtering by a client-supplied user_id instead of auth.uid()',
    detail:
      'Passing user_id from the client and using it in a query (or policy) lets a caller substitute someone else\'s id (IDOR). Derive the identity from the verified token — auth.uid() inside policies, getUser() in server code — never from request data.',
    severity: 'critical',
    appliesTo: ['auth', 'api', 'service'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: '@supabase/supabase-js',
    supported: '^2',
    note: 'supabase-js v2 is the current client (auth v2, .from().select() query builder). Parameterise it with your generated Database type for end-to-end typing.',
  },
  {
    pkg: '@supabase/ssr',
    supported: '^0.6',
    note: 'Use @supabase/ssr (the auth-helpers packages are deprecated) for server clients in SSR frameworks. createServerClient needs getAll, plus setAll in middleware so token refreshes persist.',
  },
  {
    pkg: 'supabase',
    supported: 'latest',
    note: 'The Supabase CLI manages local dev, migrations, and type generation. Keep it current so `db push`, `migration`, and `gen types` match the platform schema features.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'supabase.fail.rls-empty-result',
    signature: 'A query returns an empty array (or "new row violates row-level security policy") even though rows exist',
    cause: 'RLS is enabled but no policy grants the current role access (or the insert/update lacks a matching WITH CHECK policy), so PostgREST returns nothing / rejects the write.',
    fix: 'Add explicit SELECT/INSERT/UPDATE/DELETE policies scoped to auth.uid(); test with the anon and authenticated roles, and confirm the user is actually authenticated in the request.',
  },
  {
    id: 'supabase.fail.getsession-insecure-warning',
    signature:
      'Console warning: "Using the user object as returned from supabase.auth.getSession() ... could be insecure"',
    cause: 'Server code read identity from getSession(), which does not verify the JWT against the Auth server.',
    fix: 'Switch to `const { data: { user } } = await supabase.auth.getUser()` for any authorization decision; getUser() revalidates the token.',
  },
  {
    id: 'supabase.fail.service-role-leaked',
    signature: 'The service_role key appears in the browser Network tab or the client bundle',
    cause: 'The service_role key was prefixed with NEXT_PUBLIC_/VITE_ or referenced in client code, so it was inlined into the client bundle.',
    fix: 'Remove it from all client code and public env, use only the anon key on the client, rotate the service_role key immediately, and restrict it to server-only modules.',
  },
  {
    id: 'supabase.fail.ssr-random-logout',
    signature: 'Users are intermittently logged out / "Auth session missing!" after navigation in an SSR app',
    cause: 'The @supabase/ssr middleware client was created without a setAll cookie handler (or the mutated response was not returned), so refreshed tokens were never written back.',
    fix: 'Create the server client with getAll and setAll, call getUser() in middleware to trigger the refresh, and return the response whose cookies setAll updated.',
  },
  {
    id: 'supabase.fail.migration-drift',
    signature: 'Local/CI schema disagrees with production, or `supabase db diff` reports unexpected drift',
    cause: 'Schema or RLS policies were changed directly in the dashboard/SQL editor without a corresponding migration in the repo.',
    fix: 'Capture the change as a migration (supabase db diff / migration new), commit it, and apply migrations through the CLI so all environments converge on the same versioned schema.',
  },
];

/**
 * The Supabase reference pack. Matches a JS/TS web-or-server framework, or an
 * explicit "supabase" deployment-target hint.
 */
export const supabasePack: StackPack = {
  id: 'supabase',
  name: 'Supabase (Postgres + Auth + RLS)',
  matches: (stack) =>
    stack.deploymentTargets.includes('supabase') ||
    (JS_LANGUAGES.includes(stack.language) && SUPABASE_FRAMEWORKS.includes(stack.framework)),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    '@supabase/supabase-js@^2',
    '@supabase/ssr@^0.6',
    'supabase@latest',
    'zod@^3',
    'typescript@^5',
  ],
  versionChecks,
  setupCommands: [
    'pnpm add @supabase/supabase-js @supabase/ssr',
    'pnpm add -D supabase',
    'pnpm exec supabase init',
    'pnpm exec supabase migration new init_schema',
    'pnpm exec supabase gen types typescript --local > src/lib/database.types.ts',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec supabase db lint',
    'pnpm exec vitest run',
  ],
  qualityGates: [
    'Row Level Security is enabled on every table reachable by the anon/authenticated key, with explicit policies scoped to auth.uid().',
    'All server-side authorization uses auth.getUser() (verified), never getSession().',
    'The service_role key exists only in server env — it is absent from client code and any NEXT_PUBLIC_/VITE_ variable.',
    'Storage buckets are private by default with object-level policies for any user-scoped files.',
    'Schema and policies are defined as committed CLI migrations; no unversioned dashboard edits.',
    'Generated Database types are current and the client is parameterised with them.',
    'SSR clients use @supabase/ssr with getAll/setAll so sessions refresh without logout.',
  ],
  securityNotes: [
    'RLS + verified auth is the entire authorization boundary — the anon key is public and PostgREST is directly callable, so a table without RLS is world-accessible.',
    'The service_role key bypasses RLS and grants full database access; keep it strictly server-side, unprefixed, and rotate it the instant it is exposed.',
    'Authorize on auth.getUser()/auth.uid() (verified identity), never on getSession() or a client-supplied user_id — the latter enables IDOR.',
    'Apply policies to Storage (storage.objects) and to any RPC/Postgres function exposed via the API; a public bucket or SECURITY DEFINER function without checks leaks data.',
    'Set auth redirect URLs and email confirmation appropriately, and keep the JWT secret / project keys out of the repo.',
  ],
  deploymentNotes: [
    'Use a separate Supabase project (or branch) per environment so previews never mutate production data; give each its own keys.',
    'Apply migrations through the CLI in the deploy pipeline (supabase db push / link + migrate) so schema and RLS ship with the code.',
    'Store SUPABASE_URL and the anon key as regular env vars; store the service_role key as a protected server-only secret excluded from preview builds that may run untrusted PR code.',
    'Regenerate and commit database types when migrations land so the deployed app types match the live schema.',
    'For SSR, ensure responses that set Supabase auth cookies are not cached by a CDN so one user\'s tokens are never served to another.',
  ],
  commonFailures,
};
