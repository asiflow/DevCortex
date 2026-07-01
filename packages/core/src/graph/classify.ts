/**
 * Deterministic file classification: maps a repo-relative path to a `FileKind`,
 * a `risky` flag, and a set of domain `tags`, using path + filename heuristics
 * only (never file contents). The rules are ordered most-specific first; the
 * first matching rule wins.
 *
 * `risky` flags security/financial/structural surfaces (auth, billing,
 * middleware, migrations, env, config, and anything carrying a security-related
 * token) so downstream policy/blast-radius code can raise depth on edits.
 */

import type { FileKind } from '../domain/index';

const SCRIPT_EXT = /\.[cm]?[jt]sx?$/; // .js .jsx .ts .tsx .mjs .cjs .mts .cts
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.pcss']);

const AUTH_TOKENS = new Set([
  'auth',
  'authn',
  'authz',
  'login',
  'logout',
  'signin',
  'signup',
  'session',
  'oauth',
  'oidc',
  'jwt',
  'nextauth',
  'clerk',
  'rbac',
  'permission',
  'permissions',
]);

const BILLING_TOKENS = new Set([
  'billing',
  'payment',
  'payments',
  'stripe',
  'subscription',
  'subscriptions',
  'checkout',
  'invoice',
  'invoices',
  'paywall',
]);

const SECURITY_TOKENS = new Set([
  'security',
  'secret',
  'secrets',
  'crypto',
  'encrypt',
  'decrypt',
  'password',
  'credential',
  'credentials',
  'token',
  'tokens',
  'sanitize',
  'csrf',
  'cors',
  'webhook',
  'webhooks',
  'apikey',
]);

const RISKY_KINDS = new Set<FileKind>([
  'auth',
  'billing',
  'middleware',
  'migration',
  'env',
  'config',
]);

const CONFIG_BASENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'vercel.json',
  'turbo.json',
  'lerna.json',
  'pnpm-workspace.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'dockerfile',
  'netlify.toml',
  'babel.config.js',
  'jest.config.js',
  'jest.config.ts',
  '.babelrc',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
]);

const ROUTE_SEGMENT_FILE = /^(layout|loading|error|template|default|global-error|not-found)\.[cm]?[jt]sx?$/;

const GENERIC_TAG_TOKENS = new Set([
  'src',
  'index',
  'app',
  'pages',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'json',
  'page',
  'route',
  'the',
  'and',
  'for',
]);

export interface FileClassification {
  kind: FileKind;
  risky: boolean;
  tags: string[];
}

/**
 * Split a path into lowercased word tokens, breaking on path separators,
 * punctuation, AND camelCase boundaries (so `authMiddleware` → `auth`,
 * `middleware`). Exact-token matching against keyword sets avoids false
 * positives like `author` → `auth`.
 */
export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

function baseName(posixPath: string): string {
  const idx = posixPath.lastIndexOf('/');
  return idx === -1 ? posixPath : posixPath.slice(idx + 1);
}

function extOf(base: string): string {
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx).toLowerCase();
}

function isUnderAppRouter(segs: string[]): boolean {
  const idx = segs.indexOf('app');
  return idx === 0 || (idx === 1 && segs[0] === 'src');
}

function isUnderPagesRouter(segs: string[]): boolean {
  const idx = segs.indexOf('pages');
  return idx === 0 || (idx === 1 && segs[0] === 'src');
}

function hasAnyToken(tokens: Set<string>, keywords: Set<string>): boolean {
  for (const k of keywords) if (tokens.has(k)) return true;
  return false;
}

function computeKind(posixPath: string, base: string, tokens: Set<string>): FileKind {
  const lower = posixPath.toLowerCase();
  const lowerBase = base.toLowerCase();
  const ext = extOf(lowerBase);
  const segs = lower.split('/').filter((s) => s.length > 0);
  const dirSegs = segs.slice(0, -1);

  // 1. tests
  if (
    /\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(lowerBase) ||
    dirSegs.some((s) => s === '__tests__' || s === '__test__' || s === 'test' || s === 'tests' || s === 'e2e' || s === '__mocks__')
  ) {
    return 'test';
  }

  // 2. env files
  if (/^\.env(\.|$)/.test(lowerBase) || /^env\.[cm]?[jt]s$/.test(lowerBase)) {
    return 'env';
  }

  // 3. migrations
  if (
    dirSegs.includes('migrations') ||
    dirSegs.includes('migration') ||
    /\.migration\.[cm]?[jt]s$/.test(lowerBase) ||
    (ext === '.sql' && (dirSegs.includes('migrations') || dirSegs.includes('drizzle')))
  ) {
    return 'migration';
  }

  // 4. middleware
  if (/^middleware\.[cm]?[jt]sx?$/.test(lowerBase) || tokens.has('middleware')) {
    return 'middleware';
  }

  // 5. config
  if (
    CONFIG_BASENAMES.has(lowerBase) ||
    /\.config\.([cm]?[jt]s|json)$/.test(lowerBase) ||
    /^tsconfig\..*\.json$/.test(lowerBase) ||
    lowerBase.startsWith('.eslintrc') ||
    lowerBase.startsWith('.prettierrc') ||
    lowerBase === 'dockerfile' ||
    lowerBase.startsWith('dockerfile.') ||
    lowerBase.endsWith('.dockerfile')
  ) {
    return 'config';
  }

  // 6. schema
  if (
    ext === '.prisma' ||
    ext === '.graphql' ||
    ext === '.gql' ||
    /\.schema\.[cm]?[jt]s$/.test(lowerBase) ||
    tokens.has('schema') ||
    tokens.has('schemas')
  ) {
    return 'schema';
  }

  // 7. styles
  if (STYLE_EXTS.has(ext)) {
    return 'style';
  }

  // 8. auth (security surface — classified before generic page/component)
  if (hasAnyToken(tokens, AUTH_TOKENS)) {
    return 'auth';
  }

  // 9. billing
  if (hasAnyToken(tokens, BILLING_TOKENS)) {
    return 'billing';
  }

  // 10. api endpoints
  if (isUnderAppRouter(segs) && /^route\.[cm]?[jt]sx?$/.test(lowerBase)) {
    return 'api';
  }
  if (dirSegs.includes('api') && SCRIPT_EXT.test(lowerBase)) {
    return 'api';
  }

  // 11. pages
  if (isUnderAppRouter(segs) && /^page\.[cm]?[jt]sx?$/.test(lowerBase)) {
    return 'page';
  }
  if (isUnderPagesRouter(segs) && !lowerBase.startsWith('_') && SCRIPT_EXT.test(lowerBase)) {
    return 'page';
  }

  // 12. App Router structural segment files
  if (isUnderAppRouter(segs) && ROUTE_SEGMENT_FILE.test(lowerBase)) {
    return 'route';
  }

  // 13. components
  if (ext === '.tsx' || ext === '.jsx' || dirSegs.includes('components') || dirSegs.includes('ui')) {
    return 'component';
  }

  // 14. services
  if (
    /\.(service|controller)\.[cm]?[jt]s$/.test(lowerBase) ||
    dirSegs.includes('services') ||
    dirSegs.includes('service') ||
    dirSegs.includes('server') ||
    dirSegs.includes('actions') ||
    dirSegs.includes('controllers') ||
    dirSegs.includes('handlers') ||
    dirSegs.includes('usecases') ||
    dirSegs.includes('use-cases')
  ) {
    return 'service';
  }

  // 15. lib / shared utility code
  if (
    dirSegs.includes('lib') ||
    dirSegs.includes('libs') ||
    dirSegs.includes('utils') ||
    dirSegs.includes('util') ||
    dirSegs.includes('helpers') ||
    dirSegs.includes('helper') ||
    dirSegs.includes('hooks') ||
    dirSegs.includes('shared') ||
    dirSegs.includes('common')
  ) {
    return 'lib';
  }

  return 'other';
}

function computeRisky(kind: FileKind, tokens: Set<string>): boolean {
  if (RISKY_KINDS.has(kind)) return true;
  return hasAnyToken(tokens, SECURITY_TOKENS);
}

function computeTags(tokens: Set<string>, kind: FileKind): string[] {
  const tags = new Set<string>();
  tags.add(kind);
  for (const token of tokens) {
    if (token.length >= 3 && !GENERIC_TAG_TOKENS.has(token)) tags.add(token);
  }
  return [...tags].sort().slice(0, 16);
}

/** Classify a repo-relative (POSIX or native) path into kind + risky + tags. */
export function classifyFile(relPath: string): FileClassification {
  const posix = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = baseName(posix);
  const tokens = new Set(tokenize(posix));
  const kind = computeKind(posix, base, tokens);
  const risky = computeRisky(kind, tokens);
  const tags = computeTags(tokens, kind);
  return { kind, risky, tags };
}
