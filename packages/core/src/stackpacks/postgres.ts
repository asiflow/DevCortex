/**
 * PostgreSQL (database) reference stack pack.
 *
 * Real, current (2026) guidance for running PostgreSQL 16/17 behind an
 * application: parameterized queries (never string-concatenated SQL), connection
 * pooling — with a transaction pooler in front of serverless so the database is
 * not connection-exhausted — forward-only migrations run in a transaction,
 * indexes on foreign keys and query predicates, least-privilege roles, and the
 * safety timeouts (statement_timeout, idle_in_transaction_session_timeout) that
 * keep one slow query from taking the database down. Language-agnostic: this pack
 * is keyed off a `postgres` deployment hint, so it augments Prisma/Supabase/ORM
 * packs rather than replacing them.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// Postgres is a database, not a framework. Match on an explicit deployment hint
// so this pack augments any language/ORM stack that names Postgres.
const POSTGRES_HINTS = ['postgres', 'postgresql'];

const bestPractices: Rule[] = [
  {
    id: 'postgres.parameterized-queries',
    title: 'Always use parameterized queries / bound parameters',
    detail:
      'Pass values as bind parameters ($1, $2 or the driver/ORM equivalent) so the database treats them as data, never as SQL. String-concatenating user input into a query is the classic SQL-injection hole; an ORM or query builder does this for you, but raw SQL must bind explicitly.',
    severity: 'critical',
    appliesTo: ['service', 'api', 'migration'],
  },
  {
    id: 'postgres.pool-and-serverless-pooler',
    title: 'Pool connections, and put a transaction pooler in front of serverless',
    detail:
      'Postgres has a hard max_connections and each connection is a backend process. Use a bounded application pool for long-lived servers, and a transaction-mode pooler (PgBouncer / provider pooler) for serverless/edge where many short-lived instances would otherwise each open connections and exhaust the server.',
    severity: 'high',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'postgres.migrations-forward-transactional',
    title: 'Version schema with forward-only migrations run in a transaction',
    detail:
      'Keep ordered, reviewed migration files (Prisma/Drizzle/Alembic/golang-migrate) applied as a deploy step. Wrap DDL in a transaction so a failed migration rolls back cleanly, and provide a real down where feasible — never leave the down empty or as a no-op pass.',
    severity: 'high',
    appliesTo: ['migration', 'schema'],
  },
  {
    id: 'postgres.index-fks-and-predicates',
    title: 'Index foreign keys and the columns you filter/join/sort on',
    detail:
      'Postgres does not auto-index foreign keys. Add indexes on FK columns and on WHERE/JOIN/ORDER BY predicates, verify with EXPLAIN (ANALYZE, BUFFERS), and use composite/partial/covering indexes where the query shape warrants; drop unused indexes that only slow writes.',
    severity: 'high',
    appliesTo: ['migration', 'schema', 'service'],
  },
  {
    id: 'postgres.create-index-concurrently',
    title: 'Build indexes on live tables with CREATE INDEX CONCURRENTLY',
    detail:
      'A plain CREATE INDEX takes an exclusive lock that blocks writes for the whole build. On a busy table use CREATE INDEX CONCURRENTLY (outside a transaction) so writes continue; migration tools need this DDL flagged as non-transactional.',
    severity: 'medium',
    appliesTo: ['migration'],
  },
  {
    id: 'postgres.set-statement-timeouts',
    title: 'Set statement_timeout and idle_in_transaction_session_timeout',
    detail:
      'Configure statement_timeout so a runaway query is cancelled instead of pinning a backend, and idle_in_transaction_session_timeout so a forgotten open transaction cannot hold locks and block autovacuum. Set them per-role or per-session for the application user.',
    severity: 'high',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'postgres.least-privilege-roles',
    title: 'Give the app a least-privilege role, separate from the migration role',
    detail:
      'The application should connect as a role with only the DML it needs (SELECT/INSERT/UPDATE/DELETE on its tables), not as a superuser or the owner. Run migrations under a separate role that holds DDL rights so a compromised app credential cannot alter the schema.',
    severity: 'high',
    appliesTo: ['config', 'env', 'migration'],
  },
  {
    id: 'postgres.keep-transactions-short',
    title: 'Keep transactions short and off the network critical path',
    detail:
      'Do not hold a transaction open across external HTTP calls or user think-time; long transactions hold locks, bloat tables by blocking autovacuum, and cause idle-in-transaction. Read/compute first, then open a short write transaction.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'postgres.explicit-columns-and-jsonb-index',
    title: 'Select explicit columns; index JSONB you query with GIN',
    detail:
      'Avoid SELECT * in application queries — it over-fetches and breaks when columns change; list the columns you need. Use JSONB (not json) for semi-structured data and add a GIN index for containment/key queries so they are not sequential scans.',
    severity: 'medium',
    appliesTo: ['service', 'schema'],
  },
  {
    id: 'postgres.tls-backups-pitr',
    title: 'Require TLS, and verify backups + point-in-time recovery',
    detail:
      'Force sslmode=require (verify-full where you can pin the CA) so credentials and data are encrypted in transit, enable encryption at rest, and periodically restore a backup / test PITR — an untested backup is not a backup.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'postgres.anti.string-concat-sql',
    title: 'Building SQL by concatenating user input',
    detail:
      '`"... WHERE email = \'" + email + "\'"` is a SQL-injection vulnerability regardless of validation. Always bind parameters; if you must build dynamic SQL, use the driver\'s identifier-quoting/format helpers, never string concatenation.',
    severity: 'critical',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'postgres.anti.unbounded-serverless-connections',
    title: 'Opening a direct connection per serverless invocation',
    detail:
      'Each cold serverless instance opening its own Postgres connection quickly hits max_connections ("too many clients already"). Route serverless traffic through a transaction-mode pooler and keep the per-instance pool tiny.',
    severity: 'high',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'postgres.anti.missing-fk-index',
    title: 'Leaving foreign keys and hot predicates unindexed',
    detail:
      'Unindexed FKs make joins and ON DELETE cascades do sequential scans, and unindexed WHERE columns turn every lookup into a full scan as the table grows. Index them and confirm with EXPLAIN ANALYZE.',
    severity: 'high',
    appliesTo: ['schema', 'migration'],
  },
  {
    id: 'postgres.anti.select-star-n-plus-1',
    title: 'SELECT * and N+1 query loops',
    detail:
      'SELECT * over-fetches and breaks on schema change; issuing one query per row in a loop (N+1) multiplies round-trips. Select explicit columns and fetch related rows in a single JOIN / IN / batched query.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'postgres.anti.long-idle-transaction',
    title: 'Holding a transaction open across slow work',
    detail:
      'A transaction left open across an external call or user interaction holds row/table locks, blocks autovacuum, and bloats the table (idle in transaction). Commit promptly and keep write transactions short.',
    severity: 'medium',
    appliesTo: ['service'],
  },
  {
    id: 'postgres.anti.app-runs-as-superuser',
    title: 'Connecting the app as superuser / the table owner',
    detail:
      'Running the application with superuser or owner rights means a single leaked credential (or a SQL-injection foothold) can drop tables or read everything. Use a least-privilege DML role and a separate DDL role for migrations.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'postgres.anti.no-timeouts',
    title: 'Running with no statement or idle-transaction timeout',
    detail:
      'Without statement_timeout a single pathological query pins a backend indefinitely; without idle_in_transaction_session_timeout a stuck client blocks vacuum and holds locks. Both should be set for the app role.',
    severity: 'medium',
    appliesTo: ['config'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'postgres',
    supported: '>=16',
    note: 'PostgreSQL 16/17 (17 is current in 2026). Newer majors improve vacuum, logical replication, and monitoring; upgrade majors with pg_upgrade and test extensions first.',
  },
  {
    pkg: 'pg',
    supported: '^8',
    note: 'node-postgres 8.x for Node/TS — use a Pool, pass values as parameters ($1,$2), and never interpolate strings into text.',
  },
  {
    pkg: 'pgbouncer',
    supported: '^1.23',
    note: 'PgBouncer in transaction pooling mode in front of Postgres for serverless/high-fanout clients; note prepared-statement caveats in transaction mode.',
  },
  {
    pkg: 'psycopg',
    supported: '^3',
    note: 'psycopg 3 for Python (sync or async) with server-side parameter binding; the recommended driver over the legacy psycopg2 for new code.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'postgres.fail.too-many-connections',
    signature: 'FATAL: sorry, too many clients already / "remaining connection slots are reserved"',
    cause: 'More client connections were opened than max_connections — typically each serverless instance opening a direct connection, or an oversized/leaking pool.',
    fix: 'Put a transaction-mode pooler (PgBouncer / provider pooler) in front, cap the per-instance pool size, and make sure connections/clients are released back to the pool.',
  },
  {
    id: 'postgres.fail.deadlock-detected',
    signature: 'ERROR: deadlock detected — "Process A waits for ... Process B waits for ..."',
    cause: 'Two transactions acquired the same locks in opposite orders, so Postgres aborted one to break the cycle.',
    fix: 'Acquire locks/rows in a consistent order across transactions, keep transactions short, and retry the aborted transaction with backoff.',
  },
  {
    id: 'postgres.fail.idle-in-transaction',
    signature: 'Connections stuck in "idle in transaction"; autovacuum stalls and table bloat grows',
    cause: 'A transaction was opened but never committed/rolled back (often an error path that skipped cleanup or work done between BEGIN and an external call).',
    fix: 'Set idle_in_transaction_session_timeout, ensure sessions always COMMIT/ROLLBACK (use context-managed/yield-based sessions), and keep external calls out of open transactions.',
  },
  {
    id: 'postgres.fail.index-lock-blocks-writes',
    signature: 'Deploy stalls / writes hang while a migration runs CREATE INDEX on a large table',
    cause: 'A plain CREATE INDEX took an exclusive lock that blocked all writes until the index finished building.',
    fix: 'Use CREATE INDEX CONCURRENTLY outside a transaction (flag the migration as non-transactional), and build large indexes in a low-traffic window.',
  },
  {
    id: 'postgres.fail.ssl-required',
    signature: 'error: no pg_hba.conf entry ... "no encryption" / "SSL connection is required"',
    cause: 'The client connected without TLS to a server that mandates SSL (most managed Postgres).',
    fix: 'Set sslmode=require (or verify-full with the provider CA) in the connection string / driver options.',
  },
  {
    id: 'postgres.fail.sql-injection',
    signature: 'Unexpected rows returned/modified, or a security scan flags SQL injection on an endpoint',
    cause: 'User input was concatenated into a SQL string instead of bound as a parameter.',
    fix: 'Rewrite the query to use bind parameters ($1,$2/ORM), quote any dynamic identifiers with the driver helper, and add a test that a payload like `\' OR 1=1 --` is treated as data.',
  },
];

/**
 * The PostgreSQL reference pack. Matches when the detected stack advertises a
 * `postgres`/`postgresql` deployment target (language-agnostic — it augments the
 * ORM/framework pack in use).
 */
export const postgresPack: StackPack = {
  id: 'postgres-database',
  name: 'PostgreSQL 16/17 — relational database',
  matches: (stack) => stack.deploymentTargets.some((target) => POSTGRES_HINTS.includes(target)),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'pg@^8',
    'postgres@^3',
    'pgbouncer@^1.23',
    'drizzle-orm@^0.36',
    'kysely@^0.27',
    'psycopg@^3',
  ],
  versionChecks,
  setupCommands: [
    'docker run --name pg -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:17',
    'psql "$DATABASE_URL" -c "CREATE ROLE app LOGIN PASSWORD \'...\'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;"',
    'psql "$DATABASE_URL" -c "ALTER ROLE app SET statement_timeout = \'30s\'; ALTER ROLE app SET idle_in_transaction_session_timeout = \'60s\';"',
  ],
  testCommands: [
    'psql "$DATABASE_URL" -c "SELECT 1;"',
    'psql "$DATABASE_URL" -c "EXPLAIN (ANALYZE, BUFFERS) SELECT ...;"',
    'psql "$DATABASE_URL" -c "SELECT * FROM pg_stat_activity WHERE state = \'idle in transaction\';"',
  ],
  qualityGates: [
    'All application queries use bound parameters; no user input is concatenated into SQL.',
    'Serverless/high-fanout deployments connect through a transaction-mode pooler; pool sizes respect max_connections.',
    'Schema changes ship as ordered, transactional, forward-only migrations with a real down where feasible.',
    'Foreign keys and hot WHERE/JOIN/ORDER BY columns are indexed, verified with EXPLAIN ANALYZE; indexes on live tables are built CONCURRENTLY.',
    'statement_timeout and idle_in_transaction_session_timeout are set for the application role.',
    'The application connects as a least-privilege DML role, separate from the DDL/migration role.',
    'TLS is required in the connection string and a backup/PITR restore has been verified.',
  ],
  securityNotes: [
    'Parameterize every query — bound parameters are the only reliable defence against SQL injection; validation is not a substitute.',
    'The application role should hold only the DML it needs; run DDL/migrations under a separate role so a leaked app credential cannot alter or drop the schema.',
    'Require TLS (sslmode=require, verify-full where the CA can be pinned) and enable encryption at rest for the cluster.',
    'Store the connection string / password in a secret manager and inject at runtime; never commit DATABASE_URL or embed credentials in an image.',
    'For multi-tenant data, enforce isolation in the database (Row Level Security scoped to the tenant) rather than trusting the application to filter every query.',
    'Set statement and idle-in-transaction timeouts so a single query or stuck client cannot exhaust backends or block vacuum.',
  ],
  deploymentNotes: [
    'Run migrations as a discrete, gated deploy step (not on app startup), building large indexes CONCURRENTLY off the transaction and in a low-traffic window.',
    'Size the application pool to (workers x per-worker pool) <= the pooler/server limit; front serverless with PgBouncer in transaction mode and disable client-side prepared statements where the pooler requires it.',
    'Enable automated backups plus point-in-time recovery and rehearse a restore; monitor pg_stat_activity, replication lag, bloat, and slow queries (pg_stat_statements).',
    'Perform major-version upgrades with pg_upgrade after testing extensions and query plans on a copy; keep autovacuum tuned for write-heavy tables.',
    'Use a read replica for heavy read traffic and route only writes/consistent reads to the primary.',
  ],
  commonFailures,
};
