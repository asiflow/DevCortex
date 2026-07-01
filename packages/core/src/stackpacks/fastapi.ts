/**
 * FastAPI (Python) reference stack pack.
 *
 * Real, current (2026) guidance for a FastAPI service on Python 3.12+ with
 * Pydantic v2 and SQLAlchemy 2.0. The pack is organised around the mistakes that
 * bite in production: blocking calls inside async def (which stall the single
 * event loop), leaking fields by returning ORM rows without a response_model,
 * the Pydantic v1 -> v2 / BaseSettings move, the lifespan handler replacing the
 * deprecated on_event, and JWT verification with a pinned algorithm.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

const bestPractices: Rule[] = [
  {
    id: 'fastapi.no-blocking-in-async',
    title: 'Never call blocking I/O inside an async def path operation',
    detail:
      'FastAPI runs async endpoints on a single event loop; a blocking call (a sync DB driver, requests, time.sleep, heavy CPU) stalls every concurrent request. Use async libraries (httpx, an async DB driver), or define the endpoint as a plain def so FastAPI runs it in a threadpool, or offload with run_in_threadpool.',
    severity: 'critical',
    appliesTo: ['api', 'service'],
  },
  {
    id: 'fastapi.response-model-guards-output',
    title: 'Declare a response_model / typed return so you never leak fields',
    detail:
      'Return a Pydantic response schema (or annotate the return type) so FastAPI filters the payload to declared fields. Returning an ORM object or a dict directly can expose password hashes, internal flags, or relations you never meant to serialise.',
    severity: 'high',
    appliesTo: ['api', 'schema', 'service'],
  },
  {
    id: 'fastapi.pydantic-v2-validation',
    title: 'Validate every request body/query with Pydantic v2 models',
    detail:
      'Type path/query/body params with Pydantic v2 models (or Annotated + Field/Query) so FastAPI validates and coerces input and returns a structured 422 on bad data. Treat the schema as the trust boundary — do not read raw request bodies to bypass it.',
    severity: 'high',
    appliesTo: ['api', 'schema'],
  },
  {
    id: 'fastapi.dependency-injection',
    title: 'Use Depends for auth, DB sessions, and shared resources',
    detail:
      'Express cross-cutting concerns (current user, database session, settings) as dependencies with Depends. Yield-based dependencies give deterministic setup/teardown (closing the session), and dependencies compose and are overridable in tests.',
    severity: 'medium',
    appliesTo: ['api', 'service', 'auth'],
  },
  {
    id: 'fastapi.lifespan-not-on-event',
    title: 'Manage startup/shutdown with the lifespan context manager',
    detail:
      'Use the lifespan async context manager passed to FastAPI(lifespan=...) to open/close pools, warm caches, and register clients. The @app.on_event("startup"/"shutdown") decorators are deprecated and do not compose with sub-apps.',
    severity: 'medium',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'fastapi.settings-from-env',
    title: 'Load configuration from the environment with pydantic-settings',
    detail:
      'Define a BaseSettings subclass (from pydantic-settings in v2) to read and validate config from environment variables / secret files at startup, failing fast on a missing required secret. Never hardcode secrets or read os.environ scattered across the code.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'fastapi.jwt-pin-algorithm',
    title: 'Verify JWTs with an explicitly pinned algorithm',
    detail:
      'Call jwt.decode(token, key, algorithms=["RS256"]) with the exact allowed algorithm(s). Never accept a list mixing RS256 and HS256 (algorithm-confusion), and never allow alg "none". Validate exp/aud/iss and check scopes/roles for authorization.',
    severity: 'critical',
    appliesTo: ['auth', 'api', 'middleware'],
  },
  {
    id: 'fastapi.async-sqlalchemy-2',
    title: 'Use SQLAlchemy 2.0 async sessions with an async driver end-to-end',
    detail:
      'Pair create_async_engine + async_sessionmaker with an async driver (asyncpg) and await every query. Scope one AsyncSession per request via a dependency and eager-load relationships you serialise so lazy access does not fire outside the async context.',
    severity: 'high',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'fastapi.offload-heavy-work',
    title: 'Push heavy or slow work to a real task queue',
    detail:
      'BackgroundTasks are fine for short, fire-and-forget follow-ups tied to a response, but CPU-bound or long jobs belong on a durable queue (Celery, ARQ, Dramatiq) so a worker restart does not lose them and the API stays responsive.',
    severity: 'medium',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'fastapi.cors-scoped',
    title: 'Configure CORS narrowly, not with a wildcard plus credentials',
    detail:
      'Add CORSMiddleware with an explicit allow_origins list for the browsers that call the API. allow_origins=["*"] together with allow_credentials=True is rejected by browsers and is unsafe — enumerate the real origins.',
    severity: 'medium',
    appliesTo: ['middleware', 'config'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'fastapi.anti.blocking-call-in-async',
    title: 'A blocking/sync call inside an async def endpoint',
    detail:
      'requests.get(), a sync SQLAlchemy session, or time.sleep() inside async def blocks the event loop so throughput collapses under load. Use an async client, a plain def endpoint (threadpool), or run_in_threadpool.',
    severity: 'critical',
    appliesTo: ['api', 'service'],
  },
  {
    id: 'fastapi.anti.return-orm-directly',
    title: 'Returning an ORM model / raw dict without a response schema',
    detail:
      'Serialising a SQLAlchemy row directly leaks every column (including secrets and relations) and couples the API to the DB shape. Map to a Pydantic response model with only the intended fields.',
    severity: 'high',
    appliesTo: ['api', 'schema'],
  },
  {
    id: 'fastapi.anti.on-event-deprecated',
    title: 'Using @app.on_event("startup"/"shutdown")',
    detail:
      'These decorators are deprecated, run in a fragile order, and do not work with mounted sub-apps. Move initialisation/cleanup into the lifespan context manager.',
    severity: 'medium',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'fastapi.anti.unpinned-jwt-alg',
    title: 'Decoding a JWT without pinning the algorithm',
    detail:
      'Omitting algorithms=, or allowing both RS256 and HS256, enables algorithm-confusion attacks where an attacker signs a token using the public key as an HMAC secret. Always pin the exact algorithm and reject "none".',
    severity: 'critical',
    appliesTo: ['auth', 'api'],
  },
  {
    id: 'fastapi.anti.sync-driver-async-endpoint',
    title: 'Mixing a sync DB driver/session into async request handling',
    detail:
      'Using a sync psycopg2 session inside async endpoints blocks the loop and, with async SQLAlchemy, lazy attribute access outside the session raises MissingGreenlet. Use an async engine/session and eager-load what you serialise.',
    severity: 'high',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'fastapi.anti.secrets-in-code',
    title: 'Hardcoding secrets or scattering os.environ reads',
    detail:
      'Literal API keys/passwords in source (or ad-hoc os.environ["X"] with no validation) leak into version control and fail silently when unset. Centralise config in a validated BaseSettings loaded at startup.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'fastapi.anti.broad-except-swallow',
    title: 'Catching bare Exception and returning 200/None',
    detail:
      'A broad try/except that swallows errors hides failures and returns misleading success. Let FastAPI map known errors via HTTPException / exception handlers, and log the unexpected ones with a 500.',
    severity: 'medium',
    appliesTo: ['api', 'service'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'fastapi',
    supported: '>=0.115,<1',
    note: 'FastAPI 0.115.x on Starlette. Uses the lifespan handler (on_event is deprecated) and Annotated dependencies; pair with Pydantic v2.',
  },
  {
    pkg: 'pydantic',
    supported: '^2',
    note: 'Pydantic v2 (Rust core). BaseSettings moved to the separate pydantic-settings package; validators use field_validator/model_validator and .model_dump()/.model_validate().',
  },
  {
    pkg: 'pydantic-settings',
    supported: '^2',
    note: 'Provides BaseSettings for v2 — env/secret loading with validation. Required because pydantic v2 removed BaseSettings from the core package.',
  },
  {
    pkg: 'uvicorn',
    supported: '^0.32',
    note: 'ASGI server (uvicorn[standard]). In production run under a process manager (uvicorn workers or Gunicorn with the uvicorn worker class) for multiple processes.',
  },
  {
    pkg: 'sqlalchemy',
    supported: '^2',
    note: 'SQLAlchemy 2.0 async (create_async_engine + async_sessionmaker) with the asyncpg driver; the 2.0 select()/Mapped typing style.',
  },
  {
    pkg: 'python',
    supported: '>=3.12',
    note: 'Python 3.12+ for current typing, performance, and library support; match the interpreter used in the container base image.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'fastapi.fail.event-loop-blocked',
    signature: 'Throughput collapses / requests queue up under load though CPU is idle; endpoints serialise instead of running concurrently',
    cause: 'A blocking call (sync DB driver, requests, time.sleep, CPU-bound work) runs inside an async def, stalling the single event loop.',
    fix: 'Use an async client/driver, make the endpoint a plain def so it runs in the threadpool, or wrap the blocking call in run_in_threadpool; move CPU-heavy work to a worker/queue.',
  },
  {
    id: 'fastapi.fail.pydantic-v1-v2-break',
    signature: 'ImportError: "BaseSettings has been moved to pydantic-settings" / PydanticUserError about @validator or .dict()',
    cause: 'Code written for Pydantic v1 (BaseSettings in core, @validator, .dict()/.parse_obj()) is running under Pydantic v2.',
    fix: 'Install pydantic-settings and import BaseSettings from it; replace @validator with field_validator/model_validator and .dict()/.parse_obj() with model_dump()/model_validate().',
  },
  {
    id: 'fastapi.fail.missing-greenlet',
    signature: 'sqlalchemy.exc.MissingGreenlet: greenlet_spawn has not been called; can\'t call await_only() here',
    cause: 'A lazy-loaded relationship/attribute on an async SQLAlchemy model was accessed outside the async session (e.g. during response serialisation).',
    fix: 'Eager-load the relationships you serialise (selectinload/joinedload) within the request, or map to a Pydantic response model before the session closes.',
  },
  {
    id: 'fastapi.fail.422-unexpected',
    signature: 'HTTP 422 Unprocessable Entity with a "field required" / "value is not a valid ..." body the client did not expect',
    cause: 'The request payload did not match the declared Pydantic model (missing field, wrong type, or body sent where a query param was declared).',
    fix: 'Align the client payload with the schema; use the auto-generated OpenAPI docs as the contract, and mark genuinely optional fields Optional with defaults.',
  },
  {
    id: 'fastapi.fail.cors-preflight',
    signature: 'Browser: "blocked by CORS policy: No \'Access-Control-Allow-Origin\' header" on a cross-origin call',
    cause: 'CORSMiddleware was not configured for the calling origin, or a wildcard origin was combined with credentials (which browsers reject).',
    fix: 'Add CORSMiddleware with an explicit allow_origins list (and allow_methods/allow_headers), enabling allow_credentials only with concrete origins, not "*".',
  },
  {
    id: 'fastapi.fail.on-event-deprecation',
    signature: 'DeprecationWarning: on_event is deprecated, use lifespan event handlers instead',
    cause: 'Startup/shutdown logic still uses @app.on_event decorators.',
    fix: 'Move it into an async lifespan context manager and pass FastAPI(lifespan=lifespan); open resources before yield and close them after.',
  },
];

/**
 * The FastAPI (Python) reference pack. Matches a detected stack whose framework
 * is "fastapi".
 */
export const fastapiPack: StackPack = {
  id: 'fastapi-python',
  name: 'FastAPI (Python 3.12 + Pydantic v2)',
  matches: (stack) => stack.framework === 'fastapi',
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'fastapi>=0.115',
    'pydantic>=2',
    'pydantic-settings>=2',
    'uvicorn[standard]>=0.32',
    'sqlalchemy>=2',
    'asyncpg>=0.30',
    'alembic>=1.13',
    'pyjwt>=2.9',
    'httpx>=0.27',
    'pytest>=8',
    'pytest-asyncio>=0.24',
  ],
  versionChecks,
  setupCommands: [
    'python -m venv .venv && . .venv/bin/activate',
    'pip install "fastapi[standard]" "uvicorn[standard]" pydantic pydantic-settings',
    'pip install "sqlalchemy>=2" asyncpg alembic pyjwt',
    'pip install -D pytest pytest-asyncio httpx ruff mypy',
    'alembic init migrations',
  ],
  testCommands: [
    'ruff check .',
    'mypy .',
    'pytest -q',
    'uvicorn app.main:app --reload',
  ],
  qualityGates: [
    'No blocking I/O runs inside an async def endpoint (async driver/client, plain def, or run_in_threadpool).',
    'Every endpoint declares a response_model / typed return so no unintended fields are serialised.',
    'Request inputs are validated by Pydantic v2 models; the API returns structured 422s on bad input.',
    'Configuration and secrets come from a validated pydantic-settings BaseSettings, not hardcoded literals.',
    'JWT verification pins algorithms=["RS256"] (or the exact expected list) and validates exp/aud/iss; alg "none" is rejected.',
    'Startup/shutdown uses the lifespan context manager; no @app.on_event remain.',
    'mypy and ruff pass; pytest (with pytest-asyncio) is green including auth and DB-session dependency overrides.',
  ],
  securityNotes: [
    'Pin JWT algorithms explicitly (algorithms=["RS256"]); never allow a mixed RS256/HS256 list (algorithm confusion) or alg "none", and validate exp/aud/iss plus scopes.',
    'Return typed response models so ORM rows never leak password hashes, internal flags, or unintended relations.',
    'Load secrets from the environment/secret files via pydantic-settings, validated at startup; never hardcode credentials or commit them.',
    'Treat Pydantic request models as the trust boundary — do not bypass validation by reading the raw request body.',
    'Scope CORS to explicit origins; never combine allow_origins=["*"] with credentials.',
    'Enforce authorization (roles/scopes) in a dependency, not just authentication, and rate-limit sensitive endpoints (e.g. slowapi).',
  ],
  deploymentNotes: [
    'Run under Gunicorn with the uvicorn worker class (or multiple uvicorn workers) behind a reverse proxy; size workers to CPU cores and keep endpoints non-blocking.',
    'Expose a /health endpoint for liveness/readiness and initialise pools/clients in the lifespan handler so they are ready before traffic.',
    'Manage schema changes with Alembic migrations run as a separate step before rollout, not on app startup.',
    'Match the container base image Python major to the pinned interpreter; install from a locked requirements/uv.lock for reproducible builds.',
    'Set an async DB pool sized to the worker count and the database max_connections, and put a pooler (pgbouncer) in front for serverless/high-fanout deployments.',
  ],
  commonFailures,
};
