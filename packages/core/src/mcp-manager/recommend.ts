// ============================================================================
// Safe MCP Manager (§7.19) — recommendation ranking.
//
// `recommendMcp(task, graph)` matches a free-text task description AND the
// scanned project graph against the curated catalog, returning the servers most
// likely to help — ranked, deterministic, tokenless (no LLM).
//
// Scoring is a transparent additive heuristic:
//  - each distinct task keyword that appears in the task text scores TASK_WEIGHT;
//  - each distinct stack signal that appears in the project's "stack haystack"
//    (framework, language, deployment targets, env-var names, scripts, file
//    paths + tags) scores STACK_WEIGHT — stack evidence is weighted higher than
//    task phrasing because it is a stronger, harder-to-game signal;
//  - universally useful servers (filesystem, git) get a small baseline so a repo
//    with no other signal still gets a sensible default.
//
// Ties break by trust (trusted first) then id, so the output order is stable.
// ============================================================================

import type { McpServerSpec, ProjectGraph } from '../domain';

import { CATALOG_BY_ID, TRUST_RANK } from './catalog';

const TASK_WEIGHT = 2;
const STACK_WEIGHT = 3;
const UNIVERSAL_BASELINE = 1;

/** Match rules for one catalog server. All matching is lowercase substring. */
interface RecommendSignal {
  id: string;
  /** phrases in the task text that indicate this server is relevant */
  keywords: readonly string[];
  /** substrings in the project graph's stack haystack that indicate relevance */
  stackSignals: readonly string[];
  /** small baseline for servers useful in essentially any repo */
  universal?: boolean;
}

const SIGNALS: readonly RecommendSignal[] = [
  {
    id: 'filesystem',
    keywords: ['file', 'files', 'filesystem', 'directory', 'folder', 'read a file', 'write a file', 'local file', 'disk'],
    stackSignals: [],
    universal: true,
  },
  {
    id: 'git',
    keywords: ['git', 'commit', 'branch', 'diff', 'blame', 'stage', 'version control', 'checkout'],
    stackSignals: ['.git'],
    universal: true,
  },
  {
    id: 'github',
    keywords: ['github', 'pull request', 'pull-request', ' pr ', 'issue', 'repository', 'code review', 'merge', 'fork'],
    stackSignals: ['github', '.github', 'github_token', 'octokit', 'gh_token'],
  },
  {
    id: 'playwright',
    keywords: ['browser', 'playwright', 'e2e', 'end-to-end', 'ui test', 'scrape', 'screenshot', 'navigate', 'click', 'web page'],
    stackSignals: ['playwright', 'e2e', 'test:e2e'],
  },
  {
    id: 'postgres',
    keywords: ['postgres', 'postgresql', 'database', 'sql', 'query', 'schema', 'table', 'migration'],
    stackSignals: ['postgres', 'postgresql', 'database_url', 'prisma', 'typeorm', 'sqlalchemy', 'psql', 'drizzle'],
  },
  {
    id: 'stripe-docs',
    keywords: ['stripe', 'payment', 'billing', 'subscription', 'checkout', 'invoice', 'charge', 'webhook'],
    stackSignals: ['stripe'],
  },
  {
    id: 'vercel',
    keywords: ['vercel', 'deploy', 'deployment', 'hosting', 'preview', 'edge function'],
    stackSignals: ['vercel', 'vercel_token', 'nextjs', 'next.js'],
  },
  {
    id: 'docker',
    keywords: ['docker', 'container', 'image', 'compose', 'dockerfile', 'containerize'],
    stackSignals: ['docker', 'dockerfile', 'docker-compose', 'compose.yaml', 'compose.yml', '.dockerignore'],
  },
  {
    id: 'cloud-logs',
    keywords: ['logs', 'logging', 'observability', 'metrics', 'monitoring', 'trace', 'incident', 'grafana', 'production issue', 'debug production'],
    stackSignals: ['grafana', 'loki', 'prometheus', 'datadog', 'cloudwatch', 'opentelemetry', 'otel'],
  },
];

/**
 * Recommend MCP servers for `task` in the context of `graph`, ranked best-first.
 *
 * Deterministic and side-effect free. Only servers with a positive match score
 * are returned; a task/graph with no signal at all still surfaces the universal
 * staples (filesystem, git) via their baseline.
 */
export function recommendMcp(task: string, graph: ProjectGraph): McpServerSpec[] {
  const taskLower = typeof task === 'string' ? ` ${task.toLowerCase()} ` : ' ';
  const haystack = buildStackHaystack(graph);

  const scored: Array<{ spec: McpServerSpec; score: number }> = [];
  for (const signal of SIGNALS) {
    const spec = CATALOG_BY_ID.get(signal.id);
    if (spec === undefined) {
      continue;
    }
    let score = 0;
    for (const keyword of signal.keywords) {
      if (taskLower.includes(keyword.toLowerCase())) {
        score += TASK_WEIGHT;
      }
    }
    for (const stackSignal of signal.stackSignals) {
      if (haystack.includes(stackSignal.toLowerCase())) {
        score += STACK_WEIGHT;
      }
    }
    if (signal.universal === true) {
      score += UNIVERSAL_BASELINE;
    }
    if (score > 0) {
      scored.push({ spec, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const trustDelta = TRUST_RANK[a.spec.trust] - TRUST_RANK[b.spec.trust];
    if (trustDelta !== 0) {
      return trustDelta;
    }
    return a.spec.id.localeCompare(b.spec.id);
  });

  return scored.map((entry) => entry.spec);
}

/**
 * Flatten every relevance-bearing part of the project graph into one lowercase
 * string that substring matching can run against: stack descriptors, deployment
 * targets, env-var names, script keys + bodies, and file paths + tags.
 */
function buildStackHaystack(graph: ProjectGraph): string {
  const parts: string[] = [];
  const { stack } = graph;
  parts.push(stack.framework, stack.language, stack.packageManager);
  if (stack.frameworkVersion !== undefined) {
    parts.push(stack.frameworkVersion);
  }
  parts.push(...stack.deploymentTargets);
  for (const env of graph.envVars) {
    parts.push(env.name);
  }
  for (const [key, value] of Object.entries(graph.scripts)) {
    parts.push(key, value);
  }
  for (const file of graph.files) {
    parts.push(file.path);
    parts.push(...file.tags);
  }
  // Mark git as universally applicable to a scanned repo without relying on a
  // `.git` file node being present in the graph.
  parts.push('.git');
  return parts.join(' ').toLowerCase();
}
