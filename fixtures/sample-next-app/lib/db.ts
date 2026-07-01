/**
 * Database connection layer for the sample app.
 *
 * Parses and caches a typed connection config from `DATABASE_URL`. The fixture
 * is never executed, so this models the connection surface (env-backed, lazily
 * memoised, fail-fast on misconfiguration) without pulling in a real driver.
 */

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

let cached: ConnectionConfig | null = null;

/** The configured database URL, or throw if it is missing. */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('DATABASE_URL is not configured');
  }
  return url;
}

function parseConnectionConfig(databaseUrl: string): ConnectionConfig {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string');
  }

  const protocol = parsed.protocol.replace(/:$/, '');
  if (protocol !== 'postgres' && protocol !== 'postgresql') {
    throw new Error(`unsupported database protocol: ${protocol}`);
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database.length === 0) {
    throw new Error('DATABASE_URL is missing a database name');
  }

  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 5432;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('DATABASE_URL has an invalid port');
  }

  return {
    host: parsed.hostname,
    port,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    ssl: parsed.searchParams.get('sslmode') === 'require',
  };
}

/** Lazily build and memoise the connection config from `DATABASE_URL`. */
export function getConnectionConfig(): ConnectionConfig {
  if (cached === null) {
    cached = parseConnectionConfig(getDatabaseUrl());
  }
  return cached;
}

/** Reset the memoised config (used by tests / hot reload). */
export function resetConnectionConfig(): void {
  cached = null;
}
