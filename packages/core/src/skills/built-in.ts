// ============================================================================
// Built-in skill pack (§7.18).
//
// Eight real, evidence-based skills that ship with DevCortex Core. Each one is a
// reusable unit of engineering behaviour: task signals (`triggers`) that make it
// relevant, an ordered `checklist` an agent must satisfy, runnable `commands`
// the gate/command runner executes (never eval'd), `antiPatterns` to reject, and
// `mcpRecommendations` for capabilities the task typically needs. Guidance is
// anchored to shipping 2026 APIs (Next.js App Router / Server Actions, Stripe
// Node SDK `webhooks.constructEvent` over the RAW body, Supabase `@supabase/ssr`
// + RLS, React Hook Form + Zod).
//
// The pack is validated at module load (structural completeness + unique ids):
// a malformed built-in skill is a bug in *this* file and must fail fast rather
// than reach a host agent, mirroring the stack-pack registry's integrity check.
// ============================================================================

import type { SkillManifest } from '../domain/index';

import { assertUniqueSkillIds, assertValidSkill } from './validation';

// Fixed provenance timestamp: the built-in pack has a stable identity, so its
// `createdAt`/`updatedAt` do not drift every process start (deterministic pack).
const BUILT_IN_AT = '2026-07-01T00:00:00.000Z';

function builtIn(
  skill: Omit<SkillManifest, 'status' | 'source' | 'createdAt' | 'updatedAt'>,
): SkillManifest {
  return {
    ...skill,
    status: 'built-in',
    source: 'built-in',
    createdAt: BUILT_IN_AT,
    updatedAt: BUILT_IN_AT,
  };
}

const nextjsAppRouterAuth: SkillManifest = builtIn({
  id: 'nextjs-app-router-auth',
  name: 'Next.js App Router authentication',
  description:
    'Wire authentication and route protection correctly in the Next.js App Router: verify identity on the server, refresh sessions in middleware, and never trust client-only guards.',
  triggers: [
    'auth',
    'authentication',
    'login',
    'log in',
    'sign in',
    'sign out',
    'session',
    'protected route',
    'route protection',
    'middleware',
    'rbac',
    'app router',
    'nextjs',
    'next.js',
    'supabase auth',
  ],
  checklist: [
    'Establish the verified user on the server with a call that re-checks the token (e.g. supabase.auth.getUser()), not a cached client session, before rendering protected content.',
    'Protect routes in middleware.ts: refresh the session cookie and redirect unauthenticated requests; keep the matcher tight so static assets are not processed.',
    'Read the user inside Server Components / Route Handlers; pass only the minimum identity down to Client Components.',
    'Enforce authorization (role / resource ownership) at every mutation entry point — a "use server" action is a public POST endpoint.',
    'Send auth cookies with HttpOnly, Secure and SameSite set; never persist tokens in localStorage or a NEXT_PUBLIC_ variable.',
    'Add a redirect-to-login and a redirect-after-login path, and cover both with a smoke test.',
  ],
  commands: [
    { name: 'typecheck', run: 'pnpm exec tsc --noEmit' },
    { name: 'build', run: 'pnpm run build' },
    {
      name: 'audit-client-token-storage',
      run: "grep -rniE 'localStorage|sessionStorage' app components lib --include='*.ts' --include='*.tsx' || true",
    },
    {
      name: 'audit-server-identity',
      run: "grep -rn 'getUser' app lib middleware.ts --include='*.ts' --include='*.tsx' || true",
    },
  ],
  antiPatterns: [
    'Trusting getSession() (unverified, decoded locally) instead of getUser() for authorization decisions.',
    'Guarding pages only in a Client Component — the server still renders and can leak data before the guard runs.',
    'Storing access or refresh tokens in localStorage where any XSS can exfiltrate them.',
    'Prefixing an auth secret with NEXT_PUBLIC_, inlining it into the browser bundle.',
    'A middleware matcher so broad it runs auth logic on every static asset request.',
  ],
  mcpRecommendations: [
    'Supabase MCP (read-only) to inspect auth configuration and users.',
    'Playwright MCP to drive the login / logout / protected-route flow and capture evidence.',
  ],
});

const stripeWebhookHardening: SkillManifest = builtIn({
  id: 'stripe-webhook-hardening',
  name: 'Stripe webhook hardening',
  description:
    'Make a Stripe webhook endpoint secure and idempotent: verify the signature over the raw body, dedupe by event id, and keep the secret key server-side.',
  triggers: [
    'stripe',
    'webhook',
    'billing',
    'subscription',
    'checkout',
    'payment',
    'invoice',
    'constructevent',
    'signature',
    'stripe-signature',
  ],
  checklist: [
    'Read the RAW request body and pass it to stripe.webhooks.constructEvent(rawBody, signature, endpointSecret) — parsing to JSON first breaks the signature check.',
    'Load the signing secret from STRIPE_WEBHOOK_SECRET (server env) and the stripe-signature header from the request.',
    'Run the handler on the Node runtime (export const runtime = "nodejs") — the Stripe SDK needs Node crypto.',
    'Make processing idempotent: record event.id (Redis SET NX or a unique DB column) and skip events already handled — Stripe retries are expected, not a bug.',
    'Handle only the event types you need with an exhaustive switch and return 200 quickly; do heavy work asynchronously.',
    'Keep STRIPE_SECRET_KEY server-side only; document STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET as required env vars.',
    'Return 4xx on signature failure and let Stripe retry on 5xx.',
  ],
  commands: [
    { name: 'build', run: 'pnpm run build' },
    {
      name: 'verify-signature-check-present',
      run: "grep -rn 'constructEvent' app pages src --include='*.ts' --include='*.tsx' || true",
    },
    {
      name: 'audit-secret-key-not-client',
      run: "grep -rniE 'NEXT_PUBLIC_STRIPE_SECRET|STRIPE_SECRET_KEY' app components --include='*.tsx' || true",
    },
  ],
  antiPatterns: [
    'Calling JSON.parse / express.json() on the body before constructEvent — signature verification then always fails.',
    'Skipping idempotency, so a retried event double-charges or double-provisions.',
    'Exposing STRIPE_SECRET_KEY to the client or committing it to the repo.',
    'Running the webhook on the Edge runtime where the Node Stripe SDK cannot execute.',
    'Returning 200 before the event is durably recorded, so a crash loses the event with no retry.',
  ],
  mcpRecommendations: [
    'Stripe MCP / Stripe docs MCP to confirm current event shapes and the constructEvent contract.',
  ],
});

const supabaseRlsCheck: SkillManifest = builtIn({
  id: 'supabase-rls-check',
  name: 'Supabase Row Level Security check',
  description:
    'Ensure every user-facing Supabase table is protected by Row Level Security with explicit per-operation policies, and that the service-role key never reaches the client.',
  triggers: [
    'supabase',
    'rls',
    'row level security',
    'policy',
    'policies',
    'postgres',
    'database',
    'permissions',
    'service role',
    'service_role',
    'anon key',
  ],
  checklist: [
    'Enable RLS on every table in the public schema that holds user data (alter table ... enable row level security).',
    'Write an explicit policy per operation (select / insert / update / delete) scoped to auth.uid(); a table with RLS on but no policy denies all access.',
    'Use the anon key in the browser and the service-role key only in trusted server code — the service-role key bypasses RLS entirely.',
    'Verify writes set the owner column server-side; do not trust a client-supplied user_id.',
    'Add a regression check that an anonymous / other-user request is denied on protected tables.',
    'Keep RLS policies in versioned migrations, not ad-hoc dashboard edits.',
  ],
  commands: [
    {
      name: 'audit-service-role-in-client',
      run: "grep -rniE 'SUPABASE_SERVICE_ROLE|service_role' app components --include='*.ts' --include='*.tsx' || true",
    },
    {
      name: 'list-rls-in-migrations',
      run: "grep -rniE 'enable row level security|create policy' supabase migrations --include='*.sql' || true",
    },
  ],
  antiPatterns: [
    'A public table with RLS disabled — the anon key can then read or write every row.',
    'Using the service-role key in a Client Component or a NEXT_PUBLIC_ variable, bypassing all policies.',
    'Enabling RLS but forgetting to add policies, then disabling RLS again to "fix" the broken query.',
    'Trusting a user_id sent from the client instead of deriving it from auth.uid().',
  ],
  mcpRecommendations: [
    'Supabase MCP (read-only) to list tables and their policies.',
    'Postgres MCP (read-only) to inspect pg_policies and confirm coverage.',
  ],
});

const shadcnDashboardPolish: SkillManifest = builtIn({
  id: 'shadcn-dashboard-polish',
  name: 'shadcn/ui dashboard polish',
  description:
    'Lift a shadcn/ui dashboard from "generic AI UI" to premium: consistent spacing and radius, real loading / empty / error states, strong hierarchy, and a responsive, accessible layout.',
  triggers: [
    'shadcn',
    'dashboard',
    'ui',
    'ui polish',
    'polish',
    'component',
    'tailwind',
    'design',
    'layout',
    'cards',
    'premium ui',
  ],
  checklist: [
    'Use one spacing scale and one border-radius / shadow token set across cards, buttons and inputs; remove one-off values.',
    'Give every data surface a real loading state (skeletons), empty state (illustration + primary action) and error state (retry) — not a blank panel.',
    'Establish visual hierarchy: one clear page title, grouped sections, and a single primary CTA per view.',
    'Make the grid responsive: cards stack cleanly and nothing overflows at 375px width.',
    'Verify dark-mode contrast on text, borders and muted foregrounds; meet WCAG AA (4.5:1 body text).',
    'Use shadcn primitives consistently (Card, Button, Badge) instead of bespoke divs that drift from the design system.',
  ],
  commands: [
    { name: 'build', run: 'pnpm run build' },
    { name: 'lint', run: 'pnpm run lint' },
  ],
  antiPatterns: [
    'Mixing several border radii and shadow depths so the UI looks assembled from unrelated kits.',
    'Rendering a bare spinner or empty div where a skeleton / empty state belongs.',
    'A flat wall of identical cards with no hierarchy or grouping.',
    'Low-contrast muted text that fails AA, especially in dark mode.',
  ],
  mcpRecommendations: [
    'Playwright MCP to screenshot the dashboard at desktop and 375px for a visual diff.',
  ],
});

const reactHookFormZod: SkillManifest = builtIn({
  id: 'react-hook-form-zod',
  name: 'React Hook Form + Zod validation',
  description:
    'Build forms with a single Zod schema as the source of truth: validate on the client with zodResolver and re-validate the same schema on the server.',
  triggers: [
    'form',
    'forms',
    'react hook form',
    'rhf',
    'zod',
    'validation',
    'validate',
    'zodresolver',
    'input',
    'submit',
    'schema',
  ],
  checklist: [
    'Define one Zod schema for the form and infer the TypeScript type from it (z.infer) — do not hand-maintain a parallel interface.',
    'Wire useForm({ resolver: zodResolver(schema) }) and render field-level errors from formState.errors.',
    'Re-parse the same schema on the server (Server Action / Route Handler) before persisting — client validation is a UX affordance, not a security boundary.',
    'Disable the submit button and show a pending state while isSubmitting is true to prevent double submits.',
    'Associate every input with a label and set aria-invalid / aria-describedby for accessible error messaging.',
    'Return a typed { ok, error } result from the server rather than throwing raw errors to the client.',
  ],
  commands: [
    { name: 'typecheck', run: 'pnpm exec tsc --noEmit' },
    { name: 'test', run: 'pnpm run test' },
    {
      name: 'audit-shared-schema',
      run: "grep -rn 'zodResolver' app components src --include='*.tsx' || true",
    },
  ],
  antiPatterns: [
    'Validating only on the client, leaving the Server Action to trust arbitrary input.',
    'Maintaining a separate TypeScript interface alongside the Zod schema so the two drift.',
    'Leaving the submit button enabled during submission, allowing duplicate requests.',
    'Swallowing validation errors instead of surfacing them per-field.',
  ],
  mcpRecommendations: [
    'Docs MCP (read-only) to confirm the current React Hook Form + Zod resolver API.',
  ],
});

const vercelDeploymentDebugging: SkillManifest = builtIn({
  id: 'vercel-deployment-debugging',
  name: 'Vercel deployment debugging',
  description:
    'Diagnose a failing or misbehaving Vercel deployment systematically: reproduce the build locally, reconcile environment variables per environment, and check runtime / framework settings.',
  triggers: [
    'vercel',
    'deployment',
    'deploy',
    'deployment failed',
    'build failed',
    'preview',
    'env var',
    'environment variable',
    'runtime',
    'edge',
    'serverless',
  ],
  checklist: [
    'Read the failing build log top-to-bottom and identify the first error, not the last — later errors are usually cascades.',
    'Reproduce the production build locally (vercel build or pnpm run build) so you are not debugging blind against the remote.',
    'Reconcile env vars: confirm each required variable is set for the correct environment (Production / Preview / Development); a missing var is the most common cause.',
    'Confirm the Node version and framework preset match the project (engines field / Project Settings).',
    'Check the function runtime: Node vs Edge, and per-route runtime exports — Edge cannot run Node-only SDKs.',
    'Verify no secret is committed and no build step depends on a file excluded by .vercelignore / .gitignore.',
    'Plan a rollback to the last good deployment before shipping a risky fix.',
  ],
  commands: [
    { name: 'build-local', run: 'pnpm run build' },
    { name: 'vercel-build', run: 'vercel build' },
    { name: 'list-env', run: 'vercel env ls' },
  ],
  antiPatterns: [
    'Redeploying repeatedly without reading the build log.',
    'Setting an env var only for Production and wondering why Preview deployments still fail.',
    'Using a Node-only SDK in a route pinned to the Edge runtime.',
    'Committing .env with real secrets to make the build pass.',
  ],
  mcpRecommendations: [
    'Vercel MCP (read-only) to inspect deployments, build logs and environment variables.',
  ],
});

const dockerBuildFailureDiagnosis: SkillManifest = builtIn({
  id: 'docker-build-failure-diagnosis',
  name: 'Docker build failure diagnosis',
  description:
    'Diagnose a failing Docker image build methodically: read the failing layer, tighten the build context and cache order, and pin the base image.',
  triggers: [
    'docker',
    'dockerfile',
    'docker build',
    'build failure',
    'image',
    'container',
    'layer',
    'buildkit',
    'multi-stage',
  ],
  checklist: [
    'Rebuild with plain progress (docker build --progress=plain) and locate the exact failing RUN / COPY step and its command output.',
    'Confirm the build context is small and correct: add a .dockerignore for node_modules, .git, .env and build output.',
    'Pin the base image to a specific tag or digest instead of :latest so builds are reproducible.',
    'Order layers cheapest-to-most-volatile: copy manifests and install deps before copying source, so the dependency layer stays cached.',
    'Use a multi-stage build to keep build-only tooling out of the final image.',
    'Match the target architecture (--platform) when building for a different host than your machine.',
    'Never bake secrets into a layer; use build secrets / runtime env instead.',
  ],
  commands: [
    { name: 'build-plain', run: 'docker build --progress=plain -t devcortex-diagnose .' },
    { name: 'build-no-cache', run: 'docker build --no-cache -t devcortex-diagnose .' },
    {
      name: 'check-dockerignore',
      run: "test -f .dockerignore && echo '.dockerignore present' || echo 'MISSING .dockerignore'",
    },
  ],
  antiPatterns: [
    'Building with no .dockerignore, shipping node_modules and .git into the context (slow, and can leak secrets).',
    'Basing the image on :latest so a base update silently breaks the build.',
    'Copying the whole source before installing dependencies, busting the cache on every code change.',
    'Embedding secrets in a RUN or ENV layer where docker history exposes them.',
  ],
  mcpRecommendations: [
    'Docker MCP (read-only) to inspect images, layers and build history.',
  ],
});

const mobileResponsiveFix: SkillManifest = builtIn({
  id: 'mobile-responsive-fix',
  name: 'Mobile responsive fix',
  description:
    'Fix mobile layout defects: eliminate horizontal overflow at small widths, replace fixed pixel widths with fluid layout, and ensure tap targets and images behave on small screens.',
  triggers: [
    'mobile',
    'responsive',
    'responsiveness',
    'overflow',
    'horizontal scroll',
    'viewport',
    'breakpoint',
    '375',
    'small screen',
    'tailwind',
    'layout',
  ],
  checklist: [
    'Test the page at 375px width (iPhone SE / mini) and audit for any horizontal scroll.',
    'Replace fixed widths (w-[900px], min-w-*) with fluid constraints (w-full, max-w-*, responsive grid/flex that wraps).',
    'Constrain media: img / video get max-w-full h-auto so they never force overflow.',
    'Make tables and code blocks scroll inside their own container (overflow-x-auto) rather than the whole page.',
    'Ensure interactive targets are at least 44x44px and spaced for touch.',
    'Respect safe-area insets on notched devices for fixed headers / footers.',
    'Confirm the viewport meta tag is present (width=device-width, initial-scale=1).',
  ],
  commands: [
    { name: 'build', run: 'pnpm run build' },
    {
      name: 'audit-fixed-widths',
      run: "grep -rniE 'w-\\[[0-9]+px\\]|min-w-\\[[0-9]+px\\]' app components src --include='*.tsx' || true",
    },
  ],
  antiPatterns: [
    'Hard-coded pixel widths that exceed 375px and force horizontal scrolling.',
    'Full-bleed images without max-w-full, pushing the layout wider than the viewport.',
    'Tap targets smaller than 44px crammed together.',
    'A wide data table that scrolls the entire page instead of scrolling within its container.',
  ],
  mcpRecommendations: [
    'Playwright MCP with a mobile viewport (375px) to screenshot and confirm no overflow.',
  ],
});

/**
 * The built-in skill pack. Order is stable and meaningful (auth, billing,
 * data, UI, forms, deploy, containers, mobile). Frozen so callers cannot mutate
 * the shared registry.
 */
export const builtInSkills: readonly SkillManifest[] = Object.freeze([
  nextjsAppRouterAuth,
  stripeWebhookHardening,
  supabaseRlsCheck,
  shadcnDashboardPolish,
  reactHookFormZod,
  vercelDeploymentDebugging,
  dockerBuildFailureDiagnosis,
  mobileResponsiveFix,
]);

// --- load-time registry integrity -------------------------------------------
// A malformed built-in skill is a bug in this file; fail fast at import time
// rather than shipping broken guidance to a host agent (mirrors stackpacks).
for (const skill of builtInSkills) {
  assertValidSkill(skill, 'built-in');
  if (skill.status !== 'built-in') {
    // Defensive: the builtIn() helper always sets this, but a future hand-edit
    // must not slip a non-built-in status into the shipped pack.
    throw new Error(`built-in skill "${skill.id}" must have status "built-in"`);
  }
}
assertUniqueSkillIds(builtInSkills, 'built-in registry');
