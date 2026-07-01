/**
 * Next.js + TypeScript reference stack pack.
 *
 * Real, current (2026) guidance for a Next.js 15 / React 19 App Router app:
 * Server Components by default, Server Actions, env safety (the NEXT_PUBLIC_
 * rule), Route Handlers, forms with React Hook Form + Zod, server-side Stripe
 * Checkout + webhook signature verification, and the Supabase SSR auth /
 * middleware pattern. Versions and patterns are anchored to the shipping APIs:
 * Stripe Node SDK 19.x (`webhooks.constructEvent` over the RAW body) and
 * `@supabase/ssr` (`auth.getUser()` for verified identity, `getAll`/`setAll`
 * cookie handlers for middleware token refresh).
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

const bestPractices: Rule[] = [
  {
    id: 'nextjs.rsc-default',
    title: 'Default to Server Components; add "use client" only at interactive leaves',
    detail:
      'App Router files are Server Components unless they declare "use client". Keep data fetching, secrets and heavy logic on the server and push "use client" as deep as possible (a button, an input) so the client bundle and the secret surface stay small.',
    severity: 'medium',
    appliesTo: ['component', 'page', 'route'],
  },
  {
    id: 'nextjs.server-action-validate-authorize',
    title: 'Validate and authorize inside every Server Action',
    detail:
      'A "use server" action is a public POST endpoint. Treat every argument as untrusted: re-parse it with the same Zod schema used on the client, then check authentication and resource ownership before mutating. Return a typed { ok, error } result rather than throwing raw errors to the client.',
    severity: 'high',
    appliesTo: ['service', 'api', 'auth'],
  },
  {
    id: 'nextjs.env-public-prefix',
    title: 'Only NEXT_PUBLIC_ vars reach the browser — never prefix a secret',
    detail:
      'At build time Next inlines every NEXT_PUBLIC_-prefixed variable into the client JS bundle. Keep secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY) unprefixed and read them only in server code.',
    severity: 'critical',
    appliesTo: ['env', 'config'],
  },
  {
    id: 'nextjs.server-only-guard',
    title: 'Import "server-only" in any module that holds a secret',
    detail:
      'Add `import "server-only"` at the top of modules that read secrets or call privileged APIs. If such a module is ever pulled into a Client Component the build fails loudly instead of silently shipping the secret to the browser.',
    severity: 'high',
    appliesTo: ['lib', 'service', 'config'],
  },
  {
    id: 'nextjs.route-handler-node-runtime',
    title: 'Use Route Handlers with the Node runtime for Stripe/Node-SDK work',
    detail:
      'Implement REST/webhook endpoints as app/api/**/route.ts Route Handlers. When the handler uses the Stripe Node SDK (it needs Node crypto) declare `export const runtime = "nodejs"`; the Edge runtime cannot run it.',
    severity: 'medium',
    appliesTo: ['api', 'route', 'billing'],
  },
  {
    id: 'nextjs.forms-rhf-zod',
    title: 'React Hook Form + zodResolver on the client, re-validate the same schema on the server',
    detail:
      'Drive forms with react-hook-form and @hookform/resolvers/zod for UX-level validation, but share the Zod schema with the Server Action / Route Handler and re-validate there. Client validation is for ergonomics; server validation is the security boundary.',
    severity: 'medium',
    appliesTo: ['component', 'api', 'service'],
  },
  {
    id: 'nextjs.stripe-server-checkout',
    title: 'Create Stripe Checkout Sessions server-side; the client only redirects',
    detail:
      'Build the Checkout Session in a Server Action or Route Handler using the secret key, then hand the browser only the session URL (or id for @stripe/stripe-js redirectToCheckout). The secret key and price logic never leave the server.',
    severity: 'critical',
    appliesTo: ['billing', 'api', 'service'],
  },
  {
    id: 'nextjs.stripe-webhook-raw-signature',
    title: 'Verify Stripe webhooks against the RAW body before trusting the event',
    detail:
      'In the webhook Route Handler read the unparsed body with `const body = await req.text()` and call `stripe.webhooks.constructEvent(body, req.headers.get("stripe-signature"), STRIPE_WEBHOOK_SECRET)`. Only act on the event after verification; respond 400 on a verification error and dedupe on event.id for Stripe retries.',
    severity: 'critical',
    appliesTo: ['billing', 'api', 'route'],
  },
  {
    id: 'nextjs.supabase-getuser-server',
    title: 'Authenticate with supabase.auth.getUser() on the server, never getSession()',
    detail:
      'On the server use `const { data: { user } } = await supabase.auth.getUser()`, which revalidates the JWT against the Supabase Auth server. `getSession()` only decodes the cookie without verifying it and must not gate authorization decisions.',
    severity: 'critical',
    appliesTo: ['auth', 'middleware', 'api'],
  },
  {
    id: 'nextjs.supabase-middleware-refresh',
    title: 'Refresh the Supabase session in middleware.ts with getAll/setAll',
    detail:
      'Create the per-request server client with createServerClient and both `getAll` and `setAll` cookie handlers, call getUser() to trigger a token refresh, and return the NextResponse whose cookies setAll mutated. Without setAll the refreshed tokens are never written back and users get logged out intermittently.',
    severity: 'high',
    appliesTo: ['middleware', 'auth'],
  },
  {
    id: 'nextjs.revalidate-after-mutation',
    title: 'Revalidate or redirect after a successful mutation',
    detail:
      'After a Server Action writes data call revalidatePath()/revalidateTag() (or redirect()) so cached Server Component segments refetch. Otherwise the Full Route Cache serves stale data until a hard refresh.',
    severity: 'medium',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'nextjs.await-async-dynamic-apis',
    title: 'Await the async dynamic APIs (cookies/headers/params) in Next 15',
    detail:
      'Next 15 made cookies(), headers(), draftMode(), and the page `params`/`searchParams` props asynchronous. Await them (`const cookieStore = await cookies()`; `const { id } = await params`) and type page props with `params: Promise<...>`.',
    severity: 'medium',
    appliesTo: ['page', 'route', 'api'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'nextjs.anti.secret-in-public-env',
    title: 'Putting a secret behind NEXT_PUBLIC_',
    detail:
      'NEXT_PUBLIC_STRIPE_SECRET_KEY (or any secret with that prefix) is inlined into the browser bundle and leaks to every visitor. Drop the prefix, read it server-side only, and rotate any key that was ever exposed this way.',
    severity: 'critical',
    appliesTo: ['env', 'config'],
  },
  {
    id: 'nextjs.anti.secret-import-in-client',
    title: 'Importing a secret-reading module from a "use client" component',
    detail:
      'A Client Component that imports a module reading process.env secrets (or Node built-ins) bundles that code for the browser. Keep secret access in Server Components / "use server" actions and pass only serialisable props down.',
    severity: 'critical',
    appliesTo: ['component', 'service'],
  },
  {
    id: 'nextjs.anti.webhook-json-before-verify',
    title: 'Parsing the Stripe webhook body before constructEvent',
    detail:
      'Calling await req.json() (or any reserialization) before signature verification changes the bytes Stripe signed, so constructEvent always fails. Read req.text() first and verify, then JSON.parse the verified event if needed.',
    severity: 'critical',
    appliesTo: ['billing', 'api', 'route'],
  },
  {
    id: 'nextjs.anti.stripe-secret-on-client',
    title: 'Initialising Stripe with the secret key in client code',
    detail:
      'new Stripe(STRIPE_SECRET_KEY) must run only on the server. The browser uses @stripe/stripe-js with the publishable key. Shipping the secret key to the client exposes full account access.',
    severity: 'critical',
    appliesTo: ['billing', 'component'],
  },
  {
    id: 'nextjs.anti.supabase-getsession-authz',
    title: 'Trusting auth.getSession() for server-side authorization',
    detail:
      'getSession() returns the cookie contents without contacting the Auth server, so a forged cookie passes. Use getUser() (or getClaims()) for any access-control decision on the server.',
    severity: 'high',
    appliesTo: ['auth', 'middleware'],
  },
  {
    id: 'nextjs.anti.server-action-no-authz',
    title: 'A Server Action that mutates without an auth/ownership check',
    detail:
      'Because Server Actions are reachable as public endpoints, an action that updates or deletes data without verifying the caller and their ownership of the resource is an IDOR. Always check user identity and ownership first.',
    severity: 'critical',
    appliesTo: ['service', 'api', 'auth'],
  },
  {
    id: 'nextjs.anti.client-only-validation',
    title: 'Validating forms only on the client',
    detail:
      'react-hook-form validation runs in the browser and is trivially bypassed. The Server Action / Route Handler must re-validate the payload with the same Zod schema before persisting.',
    severity: 'high',
    appliesTo: ['component', 'api'],
  },
  {
    id: 'nextjs.anti.client-effect-data-fetch',
    title: 'Fetching server data in a client useEffect that an RSC could fetch',
    detail:
      'Fetching in a Client Component useEffect adds a waterfall, ships the fetch logic to the browser, and loses streaming. Fetch in the Server Component and pass data (or stream with Suspense) instead.',
    severity: 'low',
    appliesTo: ['component', 'page'],
  },
  {
    id: 'nextjs.anti.sync-dynamic-api',
    title: 'Accessing cookies()/headers()/params synchronously on Next 15',
    detail:
      'Reading the now-async dynamic APIs without awaiting throws a sync-dynamic-apis error (and breaks the type). Await them or destructure the awaited props prop.',
    severity: 'medium',
    appliesTo: ['page', 'route'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'next',
    supported: '^15',
    note: 'Next.js 15: stable App Router, async cookies()/headers()/params, and React 19 support. Below 15 the App Router caching semantics differ; read the 15.x upgrade notes before bumping major.',
  },
  {
    pkg: 'react',
    supported: '^19',
    note: 'React 19 provides Server Components, useActionState, useFormStatus and the `use` hook that Next 15 relies on. react and react-dom must share the same major.',
  },
  {
    pkg: 'react-dom',
    supported: '^19',
    note: 'Must match the react major exactly; a react/react-dom skew causes invalid-hook-call and hydration errors.',
  },
  {
    pkg: 'typescript',
    supported: '^5',
    note: 'TypeScript 5.x is required for `satisfies`, const type parameters, and the strict flags (noUncheckedIndexedAccess, verbatimModuleSyntax) this stack assumes.',
  },
  {
    pkg: 'stripe',
    supported: '^19',
    note: 'Stripe Node SDK 19.x. Pin the API version via the `apiVersion` constructor option so an SDK upgrade never silently changes webhook payload shapes; verify webhooks with webhooks.constructEvent over the raw body.',
  },
  {
    pkg: '@supabase/ssr',
    supported: '^0.6',
    note: 'Use @supabase/ssr (not the deprecated auth-helpers) for App Router. createServerClient requires getAll, and setAll for middleware so token refreshes persist.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'nextjs.fail.stripe-webhook-raw-body',
    signature:
      'Webhook Error: No signatures found matching the expected signature for payload / "Webhook payload must be provided as a string or a Buffer"',
    cause:
      'The webhook body was parsed (await req.json()) or reserialized before stripe.webhooks.constructEvent, so the bytes no longer match what Stripe signed.',
    fix: 'Read the raw body with `const body = await req.text()` in the App Router Route Handler and pass that string plus req.headers.get("stripe-signature") to constructEvent. Never parse the body first.',
  },
  {
    id: 'nextjs.fail.stripe-edge-runtime',
    signature: 'The edge runtime does not support Node.js "crypto" module / Stripe SDK throws on a Vercel Edge function',
    cause: 'The Stripe Node SDK needs Node crypto, but the Route Handler ran on the Edge runtime (default for some configs).',
    fix: 'Add `export const runtime = "nodejs"` to the Stripe Route Handler, or switch to webhooks.constructEventAsync with a Web Crypto provider if Edge is mandatory.',
  },
  {
    id: 'nextjs.fail.secret-leaked-public-env',
    signature: 'A secret value (e.g. STRIPE_SECRET_KEY) appears in the browser Network tab or in the _next/static client bundle',
    cause: 'The variable was prefixed with NEXT_PUBLIC_ (or read inside a Client Component), so Next inlined it into the client bundle at build time.',
    fix: 'Rename the variable to drop NEXT_PUBLIC_, read it only in server code, rotate the leaked key immediately, and add `import "server-only"` to the module so a future leak becomes a build error.',
  },
  {
    id: 'nextjs.fail.supabase-getsession-insecure',
    signature:
      'Supabase warning: "Using the user object as returned from supabase.auth.getSession() ... could be insecure" / auth bypass in server code',
    cause: 'Server-side authorization was based on getSession(), which decodes the cookie without verifying it against the Auth server.',
    fix: 'Use `const { data: { user } } = await supabase.auth.getUser()` on the server and branch on `user`; getUser() revalidates the JWT. Reserve getSession() for non-security reads.',
  },
  {
    id: 'nextjs.fail.supabase-middleware-logout',
    signature: 'Users are randomly logged out / "Auth session missing!" after navigation / the session refreshes in a loop',
    cause:
      'The SSR middleware created the server client without a setAll cookie handler (or did not return the mutated NextResponse), so refreshed tokens were never written back.',
    fix: 'In middleware.ts create the client with getAll/setAll, call supabase.auth.getUser() to trigger the refresh, and return the NextResponse whose cookies setAll mutated. Keep the no-store cache headers the library sets so a CDN never caches one user\'s tokens.',
  },
  {
    id: 'nextjs.fail.use-client-server-import',
    signature:
      'Build error: "You\'re importing a component that needs server-only..." or "Module not found: Can\'t resolve \'fs\'" inside a "use client" file',
    cause: 'A Client Component imported a module that uses server-only APIs (Node built-ins, secret env, or an inline server action).',
    fix: 'Move the server logic into a Server Component or a "use server" action and pass only serialisable props/handlers to the client leaf. Mark secret modules with `import "server-only"`.',
  },
  {
    id: 'nextjs.fail.async-dynamic-api',
    signature: 'Error: Route used `cookies().get(...)` / `params.id`; these APIs should be awaited before use (sync-dynamic-apis)',
    cause: 'Next 15 made cookies(), headers(), draftMode(), and page params/searchParams asynchronous; synchronous access now errors.',
    fix: 'Await them: `const cookieStore = await cookies()`, type page props as `{ params: Promise<{ id: string }> }`, and `const { id } = await params` before use.',
  },
  {
    id: 'nextjs.fail.server-action-stale-ui',
    signature: 'A Server Action mutation succeeds but the UI keeps showing stale data until a manual refresh',
    cause: 'The action wrote data without revalidating the cached route segment, so the Full Route Cache re-served the old render.',
    fix: 'After a successful mutation call revalidatePath("/path") or revalidateTag("tag") (or redirect()), so the affected Server Component segments refetch.',
  },
];

/**
 * The Next.js + TypeScript reference pack. Matches a detected stack whose
 * framework is "nextjs".
 */
export const nextjsPack: StackPack = {
  id: 'nextjs-typescript',
  name: 'Next.js 15 + TypeScript (App Router)',
  matches: (stack) => stack.framework === 'nextjs',
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'next@^15',
    'react@^19',
    'react-dom@^19',
    'typescript@^5',
    'zod@^3',
    'react-hook-form@^7',
    '@hookform/resolvers@^3',
    'stripe@^19',
    '@stripe/stripe-js@^4',
    '@supabase/ssr@^0.6',
    '@supabase/supabase-js@^2',
    'server-only',
    'eslint-config-next@^15',
    '@playwright/test@^1',
    'vitest@^2',
  ],
  versionChecks,
  setupCommands: [
    'pnpm dlx create-next-app@latest --ts --app --eslint --src-dir',
    'pnpm add zod react-hook-form @hookform/resolvers',
    'pnpm add stripe @stripe/stripe-js',
    'pnpm add @supabase/ssr @supabase/supabase-js',
    'pnpm add server-only',
    'pnpm add -D vitest @vitejs/plugin-react @testing-library/react jsdom @playwright/test',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec next lint',
    'pnpm exec vitest run',
    'pnpm exec playwright test',
    'stripe trigger checkout.session.completed',
  ],
  qualityGates: [
    'Typecheck passes under strict TS: `tsc --noEmit` reports zero errors.',
    'ESLint (eslint-config-next / core-web-vitals) passes with no errors.',
    '`next build` completes — every "use server"/"use client" boundary resolves and no Server module leaks into the client graph.',
    'No NEXT_PUBLIC_ variable holds a secret (audit env + built client bundle).',
    'Every Stripe webhook Route Handler verifies the signature against the raw body and dedupes on event.id before acting.',
    'Every Server Action and mutating Route Handler performs an auth + ownership check before writing.',
    'Supabase Row Level Security is enabled on every table the anon key can reach.',
    'Unit + integration tests are green; critical auth and billing flows are covered by Playwright E2E.',
  ],
  securityNotes: [
    'NEXT_PUBLIC_-prefixed env vars are inlined into the client JS bundle at build time — never prefix STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, or SUPABASE_SERVICE_ROLE_KEY with it.',
    'Import the `server-only` package at the top of any module that reads secrets; the build then fails if that module is pulled into a Client Component.',
    'Initialise the Stripe client with the secret key only in server modules (Route Handlers, Server Actions). The browser receives only the publishable key and the Checkout Session URL/id.',
    'Verify Stripe webhooks with stripe.webhooks.constructEvent(rawBody, "stripe-signature" header, STRIPE_WEBHOOK_SECRET) using the unparsed body, and reject (HTTP 400) on failure.',
    'On the server, authorize with supabase.auth.getUser() (revalidates the JWT against the Auth server). Never gate access on auth.getSession(), which only decodes the cookie.',
    'Treat every Server Action argument and Route Handler payload as untrusted: re-validate with the same Zod schema used on the client and re-check resource ownership.',
    'Enforce Supabase Row Level Security; the anon key plus RLS is the real authorization boundary, not client-side checks.',
    'Responses that set Supabase auth cookies must not be cached by a CDN — keep the no-store cache headers the SSR middleware sets so one user\'s tokens are never served to another.',
  ],
  deploymentNotes: [
    'Vercel is the reference target: choose `export const runtime = "nodejs"` for any Route Handler using the Stripe Node SDK (it needs Node crypto, not Edge).',
    'Configure environment variables per Vercel scope (Production / Preview / Development); secrets must never carry the NEXT_PUBLIC_ prefix.',
    'Register the production webhook endpoint in the Stripe dashboard and store its signing secret as STRIPE_WEBHOOK_SECRET; each environment needs its own endpoint and secret.',
    'Set the Supabase URL + anon key as env vars; keep the service-role key server-only and out of Preview deployments that may run untrusted PR code.',
    'Webhook Route Handlers must stay dynamic (they read the request body, so they already are) — do not add `export const dynamic = "force-static"`.',
    'Use Vercel preview deployments with a Stripe test-mode key and a dedicated Supabase project/branch so previews never mutate production data.',
  ],
  commonFailures,
};
