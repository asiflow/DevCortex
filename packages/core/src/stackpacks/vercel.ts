/**
 * Vercel (deployment platform) reference stack pack.
 *
 * Real, current (2026) guidance for shipping a Next.js / Vite front-end (and its
 * serverless + edge functions) to Vercel: the serverless execution model
 * (ephemeral, stateless, frozen after the response), runtime selection
 * (Node vs Edge), function duration/memory limits, per-environment env vars and
 * the client-bundle secret rule, ISR/caching headers, Cron Jobs, and Skew
 * Protection. Anchored to Next.js 15 and the Node 22 runtime.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// Vercel targets JS/TS front-end frameworks. A `vercel` deployment-target hint
// force-matches it regardless of framework.
const VERCEL_FRAMEWORKS = ['nextjs', 'react', 'vite'];
const JS_LANGUAGES = ['typescript', 'javascript'];

const bestPractices: Rule[] = [
  {
    id: 'vercel.env-per-environment',
    title: 'Scope environment variables to Production / Preview / Development',
    detail:
      'Set each variable in the correct Vercel environment scope and keep secrets unprefixed (no NEXT_PUBLIC_/VITE_). Preview deployments can run untrusted PR code, so keep production secrets and the production database out of Preview.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'vercel.secret-never-client-prefix',
    title: 'Never expose a secret through a client-inlined env prefix',
    detail:
      'NEXT_PUBLIC_ / VITE_ variables are inlined into the browser bundle at build time. Server-only secrets (API keys, database URLs, signing secrets) must stay unprefixed and be read only in server code (Route Handlers, Server Actions, serverless functions).',
    severity: 'critical',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'vercel.pick-runtime-deliberately',
    title: 'Choose the Node runtime for Node-only dependencies; Edge for low-latency IO',
    detail:
      'The Edge runtime is a Web-standard sandbox without Node built-ins (fs, crypto in the Node sense, most native modules). Declare export const runtime = "nodejs" for handlers using the Stripe SDK, Node crypto, or Prisma\'s Node engine; reserve Edge for lightweight, globally-distributed logic.',
    severity: 'high',
    appliesTo: ['api', 'service', 'config'],
  },
  {
    id: 'vercel.respect-function-limits',
    title: 'Design functions around the duration and payload limits',
    detail:
      'Serverless functions have a maxDuration and memory ceiling and a response body size limit. Configure maxDuration where a route legitimately needs it, stream large responses, and move long-running jobs to a queue or Cron rather than holding a request open.',
    severity: 'high',
    appliesTo: ['api', 'service', 'config'],
  },
  {
    id: 'vercel.stateless-functions',
    title: 'Treat functions as stateless and ephemeral',
    detail:
      'Each invocation may run on a fresh, read-only-except-/tmp instance and is frozen the moment you send the response. Persist state to a database / KV / blob store; never rely on in-process caches surviving requests or on background work continuing after the response.',
    severity: 'high',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'vercel.cache-headers-and-isr',
    title: 'Cache intentionally with ISR and Cache-Control / stale-while-revalidate',
    detail:
      'Use Next revalidate (ISR) or explicit Cache-Control: s-maxage + stale-while-revalidate so the Vercel Edge CDN serves cached content and revalidates in the background. Mark truly dynamic responses no-store; never cache a response that sets per-user auth cookies.',
    severity: 'medium',
    appliesTo: ['route', 'api', 'config'],
  },
  {
    id: 'vercel.config-in-vercel-json',
    title: 'Declare rewrites, headers, redirects and crons in vercel.json',
    detail:
      'Keep routing rewrites/redirects, security headers, and scheduled Cron Jobs (crons) in vercel.json (or next.config) so they are versioned and reviewable, rather than configured ad hoc in the dashboard.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'vercel.secure-cron-endpoints',
    title: 'Authenticate Cron Job endpoints',
    detail:
      'A Cron Job just hits a public URL on a schedule, so that URL is reachable by anyone. Verify a shared CRON_SECRET (Vercel sends it as an Authorization header) inside the handler and reject unauthenticated calls before doing work.',
    severity: 'high',
    appliesTo: ['api', 'service', 'auth'],
  },
  {
    id: 'vercel.preview-isolation',
    title: 'Point Preview deployments at non-production data',
    detail:
      'Wire Preview env vars to a test-mode Stripe key and a branch/preview database so preview builds and untrusted PR code never read or mutate production data.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'vercel.monorepo-root-directory',
    title: 'Set the correct Root Directory (and framework preset) for a monorepo',
    detail:
      'For a pnpm/turbo monorepo configure the project Root Directory to the app package and let Vercel detect the framework; rely on Turborepo remote caching and Ignored Build Step to skip builds when only unrelated packages changed.',
    severity: 'low',
    appliesTo: ['config'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'vercel.anti.secret-in-public-var',
    title: 'Putting a secret behind NEXT_PUBLIC_ / VITE_',
    detail:
      'A prefixed variable is inlined into the client bundle and shipped to every visitor. Drop the prefix, read it server-side, and rotate any key that was ever exposed this way.',
    severity: 'critical',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'vercel.anti.long-running-in-function',
    title: 'Running a long job synchronously inside a request function',
    detail:
      'Video processing, big imports, or polling loops inside a serverless function hit maxDuration and get killed mid-work. Offload to a queue, a Cron Job, or a dedicated worker and return quickly.',
    severity: 'high',
    appliesTo: ['api', 'service'],
  },
  {
    id: 'vercel.anti.work-after-response',
    title: 'Scheduling background work after the response is sent',
    detail:
      'The function is frozen once you respond, so a fire-and-forget promise started after res.send often never completes. Do the work before responding, or hand it to a queue / durable job that runs in its own invocation.',
    severity: 'high',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'vercel.anti.filesystem-persistence',
    title: 'Writing persistent state to the function filesystem',
    detail:
      'The bundle filesystem is read-only (only /tmp is writable, and even that is ephemeral and per-instance). Uploading to disk or writing a local SQLite file loses data between invocations — use blob storage / a managed database.',
    severity: 'high',
    appliesTo: ['service'],
  },
  {
    id: 'vercel.anti.in-memory-cache-assumption',
    title: 'Relying on an in-memory cache or module-level state across requests',
    detail:
      'A module-level Map primed on first request is not shared across the many cold instances Vercel spins up, so hit rates are poor and instances see inconsistent data. Use a shared store (KV/Redis) for cross-request cache.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'vercel.anti.node-api-on-edge',
    title: 'Using a Node built-in / native module in an Edge function',
    detail:
      'Importing fs, a native addon, or the Node Stripe/Prisma engine into an Edge runtime handler fails at build or runtime. Switch that handler to runtime = "nodejs" or use an Edge-compatible client.',
    severity: 'high',
    appliesTo: ['api', 'service'],
  },
  {
    id: 'vercel.anti.unauthenticated-cron',
    title: 'Exposing a Cron endpoint with no auth check',
    detail:
      'Because the cron path is a normal public URL, leaving it unauthenticated lets anyone trigger the job (spam email, duplicate billing). Require the CRON_SECRET before executing.',
    severity: 'high',
    appliesTo: ['api', 'auth'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'vercel',
    supported: '^39',
    note: 'The Vercel CLI (vercel dev / vercel deploy / vercel env pull). Pull env vars locally with `vercel env pull .env.local` so local runs mirror the deployed environment.',
  },
  {
    pkg: 'next',
    supported: '^15',
    note: 'Next.js 15 is the reference framework on Vercel; runtime is selected per Route Handler with export const runtime = "nodejs" | "edge".',
  },
  {
    pkg: 'node',
    supported: '>=22',
    note: 'The Node serverless runtime is Node 22.x in 2026 (set in project settings / package.json engines). Match your local Node major to avoid build/runtime drift.',
  },
  {
    pkg: '@vercel/kv',
    supported: '^3',
    note: 'Managed Redis-compatible KV for cross-invocation cache/state that survives the stateless function model (or use @vercel/blob for files, @vercel/postgres for SQL).',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'vercel.fail.function-timeout',
    signature: 'FUNCTION_INVOCATION_TIMEOUT / 504 — "Task timed out after N seconds"',
    cause: 'The serverless function ran past its maxDuration doing long synchronous work.',
    fix: 'Raise maxDuration only if the work is legitimately short-bounded; otherwise move the job to a Cron Job or a queue/worker and return immediately. Stream long responses instead of buffering.',
  },
  {
    id: 'vercel.fail.edge-node-api',
    signature: 'Build/runtime error: "A Node.js module is loaded (\'fs\'/\'crypto\') which is not supported in the Edge Runtime"',
    cause: 'An Edge-runtime function imported a Node built-in or a Node-only library (Stripe SDK, Prisma Node engine).',
    fix: 'Add export const runtime = "nodejs" to that handler, or swap in an Edge-compatible client. Keep Stripe/Prisma/crypto work on the Node runtime.',
  },
  {
    id: 'vercel.fail.env-missing-at-runtime',
    signature: 'process.env.X is undefined in the deployed function though it works locally',
    cause: 'The variable was not set for that environment scope (Production vs Preview), or a NEXT_PUBLIC_ build-time var was expected to change at runtime.',
    fix: 'Add the variable to the matching Vercel environment and redeploy; remember NEXT_PUBLIC_/VITE_ vars are baked at build time, so change them and rebuild rather than expecting runtime overrides.',
  },
  {
    id: 'vercel.fail.readonly-filesystem',
    signature: 'EROFS: read-only file system, open \'...\' / uploaded files disappear between requests',
    cause: 'Code wrote to the function filesystem (anywhere but /tmp), or relied on /tmp persisting across invocations.',
    fix: 'Write only to /tmp for scratch and persist real data to @vercel/blob or a managed database; never assume local files survive.',
  },
  {
    id: 'vercel.fail.background-task-dropped',
    signature: 'A fire-and-forget task (email, log flush) started after the response never runs in production',
    cause: 'The function was frozen/suspended immediately after sending the response, so the un-awaited promise was discarded.',
    fix: 'Await the work before responding, or enqueue it to a durable queue/Cron that executes in its own invocation.',
  },
  {
    id: 'vercel.fail.stale-chunk-404',
    signature: 'ChunkLoadError / 404 on a _next/static asset for users mid-session after a new deploy',
    cause: 'A client on the old build requested a hashed chunk that the new immutable deployment no longer serves.',
    fix: 'Enable Skew Protection so in-flight clients keep resolving to their original deployment, and handle ChunkLoadError by prompting a reload.',
  },
];

/**
 * The Vercel deployment reference pack. Matches when the detected stack
 * advertises a `vercel` deployment target, or is a JS/TS front-end framework.
 */
export const vercelPack: StackPack = {
  id: 'vercel-deploy',
  name: 'Vercel — serverless & edge deployment',
  matches: (stack) =>
    stack.deploymentTargets.includes('vercel') ||
    (JS_LANGUAGES.includes(stack.language) && VERCEL_FRAMEWORKS.includes(stack.framework)),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'vercel@^39',
    'next@^15',
    '@vercel/kv@^3',
    '@vercel/blob@^0.27',
    '@vercel/analytics@^1',
    'typescript@^5',
  ],
  versionChecks,
  setupCommands: [
    'pnpm add -g vercel',
    'pnpm dlx vercel link',
    'pnpm dlx vercel env pull .env.local',
    'pnpm dlx vercel dev',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec next build',
    'pnpm dlx vercel build',
  ],
  qualityGates: [
    'No secret is exposed through a NEXT_PUBLIC_/VITE_ variable (audit env + the built client bundle).',
    'Each Route Handler / function declares the correct runtime (nodejs for Node-only deps, edge for lightweight IO).',
    'Long-running work is offloaded to a Cron Job or queue; no request function relies on exceeding maxDuration or on work after the response.',
    'Functions persist state to a database / KV / blob store, not the local filesystem or module-level memory.',
    'Cron endpoints verify CRON_SECRET before executing.',
    'Preview deployments use non-production secrets and database.',
    'Cache-Control / ISR revalidation is set intentionally, and responses that set auth cookies are no-store.',
    '`next build` / `vercel build` completes and the deployment preview passes smoke tests before promotion.',
  ],
  securityNotes: [
    'NEXT_PUBLIC_/VITE_ variables are inlined into the browser bundle at build time — never prefix a secret with them; read secrets only in server code.',
    'Scope secrets to the right environment and keep production secrets out of Preview, which may execute untrusted PR code.',
    'Store secrets in Vercel Environment Variables (encrypted) or an external secret manager; pull them locally with `vercel env pull`, never commit .env files.',
    'Authenticate Cron Job handlers with CRON_SECRET (sent by Vercel as an Authorization header) since the cron URL is publicly reachable.',
    'Set security headers (CSP, X-Content-Type-Options, Referrer-Policy) via vercel.json/next.config, and never cache a response that carries per-user auth cookies at the Edge CDN.',
  ],
  deploymentNotes: [
    'Vercel deployments are immutable and atomic; promote a passing Preview to Production and roll back by re-promoting a previous deployment.',
    'Enable Skew Protection so clients mid-session keep hitting the deployment they loaded, avoiding ChunkLoadError after a new release.',
    'For a monorepo set the project Root Directory to the app package and use Turborepo remote caching + Ignored Build Step to skip unaffected builds.',
    'The Node serverless runtime is Node 22.x — align local Node and package.json engines; select edge only for handlers with no Node dependencies.',
    'Use @vercel/kv / @vercel/blob / a managed Postgres for state; the function filesystem is read-only except an ephemeral /tmp.',
  ],
  commonFailures,
};
