/**
 * Node.js (backend) reference stack pack.
 *
 * Real, current (2026) guidance for a server-side Node service (plain Node or
 * Express 5): native ESM, config/secret validation at startup, async error
 * handling (Express 5 forwards rejected promises), boundary input validation,
 * graceful shutdown, security middleware (helmet/cors/rate-limit), never
 * blocking the event loop, structured logging, and connection-pool reuse.
 * Anchored to Node 22 LTS / 24, Express 5.x, Zod 3, Pino 9, Helmet 8.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// A backend Node pack applies to a node service or an Express app.
const NODE_FRAMEWORKS = ['node', 'express'];

const bestPractices: Rule[] = [
  {
    id: 'node.native-esm',
    title: 'Use native ESM with "type": "module"',
    detail:
      'Set "type": "module" and write import/export throughout. Modern Node fully supports ESM; use import.meta.url / import.meta.dirname instead of __dirname, and createRequire only for the rare CJS-only dependency. A consistent module system avoids the ERR_REQUIRE_ESM / dual-package pitfalls.',
    severity: 'medium',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'node.validate-config-at-startup',
    title: 'Load and validate configuration/secrets at startup with a schema',
    detail:
      'Read config from the environment (never hard-code) and parse process.env through a Zod schema at boot, failing fast with a clear message if a required var is missing or malformed. Use node --env-file=.env (or dotenv) for local dev, and inject real secrets from the platform in production.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'node.async-error-handling',
    title: 'Propagate async errors to one centralised error handler',
    detail:
      'Express 5 automatically forwards errors thrown from async route handlers to error middleware, so define a single 4-argument (err, req, res, next) handler at the end of the chain that logs and returns a safe response. On plain Node, wrap request handling so a rejected promise never escapes unhandled.',
    severity: 'high',
    appliesTo: ['service', 'api', 'middleware'],
  },
  {
    id: 'node.validate-request-input',
    title: 'Validate every request input at the boundary',
    detail:
      'Parse req.body, req.query, and req.params through a Zod schema before use; treat all of them as untrusted. Reject invalid input with 400 and a typed error, and derive the handler\'s types from the schema so validation and typing cannot diverge.',
    severity: 'high',
    appliesTo: ['api', 'service'],
  },
  {
    id: 'node.graceful-shutdown',
    title: 'Shut down gracefully on SIGTERM/SIGINT',
    detail:
      'On SIGTERM stop accepting new connections (server.close), let in-flight requests finish within a timeout, then close the DB/redis pools and exit. Orchestrators send SIGTERM before SIGKILL; without a handler you drop live requests and leak connections on every deploy.',
    severity: 'medium',
    appliesTo: ['service', 'config'],
  },
  {
    id: 'node.security-middleware',
    title: 'Apply security headers, a CORS allowlist, and rate limiting',
    detail:
      'Front the app with helmet for secure headers, configure cors with an explicit origin allowlist (not "*") for credentialed APIs, and add rate limiting on auth/public endpoints. These are baseline controls, applied before route handlers.',
    severity: 'high',
    appliesTo: ['middleware', 'api'],
  },
  {
    id: 'node.never-block-event-loop',
    title: 'Keep synchronous/CPU work off the request path',
    detail:
      'Avoid *Sync fs calls, synchronous crypto/hashing, and large JSON.parse on the hot path — they stall the single-threaded event loop and block every concurrent request. Use async APIs, stream large payloads, and offload CPU-bound work to a worker_thread or a queue.',
    severity: 'medium',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'node.timeouts-and-abort',
    title: 'Put timeouts and AbortSignal on every outbound call',
    detail:
      'Wrap outbound fetch/DB/HTTP calls with an AbortController timeout (fetch supports signal / AbortSignal.timeout) so a slow upstream cannot pile up requests and exhaust the pool. A hung dependency without a timeout becomes your outage.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'node.structured-logging',
    title: 'Emit structured logs and never leak secrets into them',
    detail:
      'Use a structured logger (pino) with levels and request correlation ids instead of console.log, and redact tokens/passwords/PII from log payloads. Structured JSON logs are queryable in production; ad-hoc console output is not, and often leaks sensitive fields.',
    severity: 'medium',
    appliesTo: ['service', 'config'],
  },
  {
    id: 'node.reuse-connection-pools',
    title: 'Create connection pools once and reuse them',
    detail:
      'Instantiate DB/redis/HTTP clients a single time at module scope and share the pool across requests. Creating a new client or pool per request exhausts the database\'s connection limit and adds handshake latency to every call.',
    severity: 'high',
    appliesTo: ['service', 'config'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'node.anti.floating-promise',
    title: 'Floating promises / missing await',
    detail:
      'Calling an async function without awaiting it (or handling its rejection) means an error becomes an unhandledRejection — which crashes the process on modern Node — and the ordering guarantees you assumed do not hold. Await it, or explicitly .catch and handle it.',
    severity: 'high',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'node.anti.sync-blocking',
    title: 'Synchronous blocking calls on the request path',
    detail:
      'fs.readFileSync, crypto.pbkdf2Sync/bcrypt sync, or a huge synchronous loop inside a handler freezes the event loop so no other request is served until it finishes. Use the async variants and offload CPU-heavy work.',
    severity: 'medium',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'node.anti.secret-in-code',
    title: 'Hard-coding secrets or connection strings',
    detail:
      'Committing an API key, DB password, or JWT secret bakes it into the repo history and every image. Read secrets from the environment/secret manager, validate them at startup, and rotate anything that was ever committed.',
    severity: 'critical',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'node.anti.no-input-validation',
    title: 'Trusting req.body/query/params without validation',
    detail:
      'Passing request data straight into business logic or a database call invites injection, mass-assignment, and type-confusion bugs. Validate and coerce every input at the boundary before it reaches any handler logic.',
    severity: 'high',
    appliesTo: ['api', 'service'],
  },
  {
    id: 'node.anti.leaky-error-response',
    title: 'Returning raw errors/stack traces to the client',
    detail:
      'Sending err.stack or internal messages in the HTTP response leaks file paths, dependency versions, and query internals that aid an attacker. Log the detail server-side and return a generic, safe error body with a correlation id.',
    severity: 'medium',
    appliesTo: ['api', 'middleware'],
  },
  {
    id: 'node.anti.string-concatenated-sql',
    title: 'Building SQL/commands by string concatenation',
    detail:
      "`\"SELECT * FROM users WHERE id = '\" + id + \"'\"` is a SQL-injection hole; the same applies to shell commands built from input. Use parameterised queries / prepared statements and avoid shelling out with interpolated input.",
    severity: 'critical',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'node.anti.no-timeout',
    title: 'Outbound calls with no timeout',
    detail:
      'An external HTTP/DB call without a timeout can hang indefinitely, holding a connection and a request slot; under load this cascades into pool exhaustion and a full outage. Always bound outbound calls with an AbortSignal/timeout.',
    severity: 'medium',
    appliesTo: ['service'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'node',
    supported: '>=22',
    note: 'Target an active LTS (Node 22 "Jod" or 24): native fetch, node --env-file, the node:test runner, and stable ESM. Avoid EOL majors — they stop receiving security patches.',
  },
  {
    pkg: 'express',
    supported: '^5',
    note: 'Express 5: async route handlers that reject now forward to error middleware automatically, path-matching changed (no more unsafe regex quirks), and req.query is stricter. Review the 4→5 migration notes before upgrading.',
  },
  {
    pkg: 'zod',
    supported: '^3',
    note: 'Zod 3 for runtime validation of env, request bodies, and outbound responses; infer handler types from the schema.',
  },
  {
    pkg: 'helmet',
    supported: '^8',
    note: 'helmet 8 sets secure HTTP response headers (CSP, HSTS, etc.); apply it early in the middleware chain.',
  },
  {
    pkg: 'pino',
    supported: '^9',
    note: 'pino 9 for fast structured JSON logging with redaction; prefer it to console.* in a service.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'node.fail.require-esm',
    signature: 'Error [ERR_REQUIRE_ESM]: require() of ES Module ... not supported / "Cannot use import statement outside a module"',
    cause: 'CommonJS and ESM are mixed — a require() hit an ESM-only package, or "type": "module" is missing/incorrect for the syntax used.',
    fix: 'Standardise on ESM ("type": "module" + import), use await import() for a dynamic case, and reserve createRequire for a genuinely CJS-only dependency.',
  },
  {
    id: 'node.fail.unhandled-rejection-crash',
    signature: 'UnhandledPromiseRejection ... the process will terminate / the service exits after an async error',
    cause: 'A promise rejected with no await and no .catch, so Node raised an unhandledRejection, which terminates the process by default on modern versions.',
    fix: 'Await async calls (enable eslint no-floating-promises), handle rejections in the centralised error path, and let Express 5 forward async handler errors to error middleware.',
  },
  {
    id: 'node.fail.cors-blocked',
    signature: "Browser console: 'has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header'",
    cause: 'The server did not send the CORS headers the browser requires for a cross-origin request, or the preflight OPTIONS request was not handled.',
    fix: 'Configure the cors middleware with the exact allowed origin(s) and credentials setting, and ensure preflight (OPTIONS) requests are answered before auth middleware rejects them.',
  },
  {
    id: 'node.fail.eaddrinuse',
    signature: 'Error: listen EADDRINUSE: address already in use :::PORT',
    cause: 'Another process (often a previous, un-exited dev instance) already holds the port the server is trying to bind.',
    fix: 'Free or change the port (make it configurable via env), and add a graceful-shutdown handler so restarts release the socket instead of leaving a zombie listener.',
  },
  {
    id: 'node.fail.express4-async-throw',
    signature: 'An error thrown in an async Express route hangs the request / never reaches error middleware',
    cause: 'On Express 4 a rejected promise from an async handler is not forwarded automatically; the request stalls until it times out.',
    fix: 'Upgrade to Express 5 (async errors auto-forward) or wrap Express 4 async handlers so rejections call next(err) and reach the error middleware.',
  },
  {
    id: 'node.fail.env-undefined-crash',
    signature: 'Runtime TypeError reading a property of undefined that traces back to a missing process.env value',
    cause: 'A required environment variable was undefined and used without validation, surfacing as a confusing crash deep inside a request instead of at boot.',
    fix: 'Validate all env vars against a schema at startup and exit with a clear message when one is missing, so misconfiguration fails fast and visibly.',
  },
];

/**
 * The Node.js backend reference pack. Matches a node service or an Express
 * detected stack.
 */
export const nodePack: StackPack = {
  id: 'node',
  name: 'Node.js backend (Express 5)',
  matches: (stack) => NODE_FRAMEWORKS.includes(stack.framework),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'express@^5',
    'zod@^3',
    'helmet@^8',
    'cors@^2',
    'express-rate-limit@^7',
    'pino@^9',
    'pino-http@^10',
    'jsonwebtoken@^9',
    'typescript@^5',
    'tsx@^4',
    'vitest@^2',
    'supertest@^7',
  ],
  versionChecks,
  setupCommands: [
    'pnpm add express zod helmet cors express-rate-limit pino pino-http',
    'pnpm add -D typescript @types/node @types/express tsx',
    'pnpm add -D vitest supertest @types/supertest',
    'pnpm exec tsc --init',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec eslint .',
    'pnpm exec vitest run',
    'node --test',
  ],
  qualityGates: [
    'Typecheck passes under strict TS and ESLint enforces no-floating-promises.',
    'Configuration and secrets are validated against a schema at startup; a missing var fails the boot, not a request.',
    'A single centralised (err, req, res, next) error handler sits at the end of the chain and returns safe, non-leaking errors.',
    'Every request input (body/query/params) is validated at the boundary before use.',
    'helmet, an explicit CORS allowlist, and rate limiting are applied; no secrets are hard-coded.',
    'The service handles SIGTERM gracefully (drains requests, closes pools).',
    'Integration tests hit routes via supertest and cover auth + error paths.',
  ],
  securityNotes: [
    'Read every secret (DB URL, JWT secret, API keys) from the environment or a secret manager and validate at startup — never commit them; rotate anything that reaches the repo.',
    'Validate and sanitise all request input at the boundary; use parameterised queries for SQL and never build shell commands from user input.',
    'Verify JWTs with an explicitly pinned algorithm (e.g. algorithms: ["RS256"]) — accepting multiple algorithms or leaving it unspecified enables algorithm-confusion attacks.',
    'Apply helmet for secure headers, restrict CORS to an explicit origin allowlist for credentialed requests, and rate-limit authentication and public endpoints.',
    'Return generic error responses; log stack traces server-side only, and redact tokens/passwords/PII from structured logs.',
    'Set timeouts on outbound calls so a slow dependency cannot exhaust the connection pool and take the service down.',
  ],
  deploymentNotes: [
    'Run as an active-LTS Node image (22/24), non-root, with a /health (and readiness) endpoint for the orchestrator.',
    'Inject secrets at runtime from the platform secret store; do not bake .env into the image.',
    'Honour SIGTERM for zero-downtime rollouts: stop accepting connections, drain in-flight requests within the shutdown grace period, then close pools.',
    'Size the DB connection pool to the number of replicas × per-instance pool so the total stays under the database\'s max_connections; front Postgres with a pooler if running many instances.',
    'Ship structured logs to the platform log aggregator and expose metrics (e.g. prom-client) for latency/error-rate SLOs.',
  ],
  commonFailures,
};
