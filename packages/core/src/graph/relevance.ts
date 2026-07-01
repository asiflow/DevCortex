/**
 * Read-only graph queries:
 *  - `relevantFiles` ranks files against a free-text task by keyword/kind match.
 *  - `dependentsOf` returns the transitive `importedBy` closure of a file
 *    (cycle-safe).
 *
 * Both are pure functions over an already-built `ProjectGraph`.
 */

import type { FileKind, FileNode, ProjectGraph } from '../domain/index';
import * as path from 'node:path';
import { tokenize } from './classify';

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'and',
  'or',
  'with',
  'in',
  'on',
  'of',
  'new',
  'please',
  'add',
  'adds',
  'added',
  'update',
  'updates',
  'fix',
  'fixes',
  'implement',
  'create',
  'creates',
  'build',
  'builds',
  'make',
  'change',
  'changes',
  'support',
  'need',
  'want',
  'use',
  'using',
  'from',
  'into',
  'our',
  'my',
  'that',
  'this',
  'it',
  'as',
  'at',
  'be',
  'is',
  'are',
  'so',
  'we',
  'can',
]);

const SHORT_ALLOW = new Set(['ui', 'db', 'id']);

const KIND_HINTS: Record<string, FileKind[]> = {
  auth: ['auth'],
  authentication: ['auth'],
  login: ['auth'],
  signin: ['auth'],
  signup: ['auth'],
  session: ['auth'],
  oauth: ['auth'],
  permission: ['auth'],
  permissions: ['auth'],
  rbac: ['auth'],
  billing: ['billing'],
  payment: ['billing'],
  payments: ['billing'],
  stripe: ['billing'],
  subscription: ['billing'],
  subscriptions: ['billing'],
  checkout: ['billing'],
  invoice: ['billing'],
  api: ['api'],
  endpoint: ['api'],
  endpoints: ['api'],
  route: ['route', 'api', 'page'],
  page: ['page'],
  ui: ['component'],
  component: ['component'],
  components: ['component'],
  migration: ['migration'],
  migrations: ['migration'],
  database: ['migration', 'schema'],
  schema: ['schema'],
  table: ['migration', 'schema'],
  tables: ['migration', 'schema'],
  middleware: ['middleware'],
  test: ['test'],
  tests: ['test'],
  env: ['env'],
  config: ['config'],
  service: ['service'],
  services: ['service'],
};

function taskTokens(task: string): string[] {
  const out = new Set<string>();
  for (const token of tokenize(task)) {
    if (token.length >= 3 || SHORT_ALLOW.has(token)) {
      if (!STOPWORDS.has(token)) out.add(token);
    }
  }
  return [...out];
}

/** a===b, or one is a length-≥4 prefix of the other (handles plurals/stems). */
function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.startsWith(a)) return true;
  if (b.length >= 4 && a.startsWith(b)) return true;
  return false;
}

/** Rank files by relevance to a free-text task. Highest score first. */
export function relevantFiles(graph: ProjectGraph, task: string): FileNode[] {
  const tokens = taskTokens(task);
  if (tokens.length === 0) return [];

  const scored: Array<{ file: FileNode; score: number }> = [];

  for (const file of graph.files) {
    const pathLower = file.path.toLowerCase();
    const pathTokens = new Set(tokenize(file.path));
    const tags = file.tags.map((t) => t.toLowerCase());
    const symbols = file.symbols.map((s) => s.toLowerCase());

    let score = 0;
    for (const token of tokens) {
      if (pathTokens.has(token)) score += 3;
      else if ([...pathTokens].some((p) => tokenMatches(token, p))) score += 2;
      else if (pathLower.includes(token)) score += 1;

      if (tags.some((t) => tokenMatches(token, t))) score += 2;
      if (symbols.some((s) => tokenMatches(token, s))) score += 2;

      for (const key of Object.keys(KIND_HINTS)) {
        if (!tokenMatches(token, key)) continue;
        const kinds = KIND_HINTS[key];
        if (kinds !== undefined && kinds.includes(file.kind)) {
          score += 4;
          break;
        }
      }
    }

    if (score > 0) scored.push({ file, score });
  }

  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0,
  );
  return scored.map((s) => s.file);
}

function normalizeToRepoRel(graph: ProjectGraph, file: string): string {
  let f = file.replace(/\\/g, '/');
  const rootPosix = graph.root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (f === rootPosix) return '';
  if (f.startsWith(`${rootPosix}/`)) {
    f = f.slice(rootPosix.length);
  } else if (path.isAbsolute(file)) {
    const rel = path.relative(graph.root, file).split(path.sep).join('/');
    f = rel;
  }
  return f.replace(/^\/+/, '').replace(/^\.\//, '');
}

/** Transitive set of files that (directly or indirectly) import `file`. */
export function dependentsOf(graph: ProjectGraph, file: string): string[] {
  const target = normalizeToRepoRel(graph, file);
  const byPath = new Map<string, FileNode>(graph.files.map((f) => [f.path, f]));
  if (!byPath.has(target)) return [];

  const result = new Set<string>();
  const visited = new Set<string>([target]);
  const queue: string[] = [target];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const node = byPath.get(current);
    if (node === undefined) continue;
    for (const dependent of node.importedBy) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      result.add(dependent);
      queue.push(dependent);
    }
  }

  return [...result].sort();
}
