/**
 * Risk classification.
 *
 * `classifyRisk` turns a free-text task description plus the project graph into a
 * structured {@link RiskClassification}. It combines two tokenless, deterministic
 * signal sources:
 *   1. Keyword analysis of the task text (auth / billing / migration / secret /
 *      deploy ... map to elevated risk and a task type).
 *   2. Affected-file analysis: files in the graph that the task plausibly touches
 *      can escalate risk on their own (a migration file is critical even if the
 *      wording looks benign; a risky/protected file is at least high).
 * Finally it honours `config.risk.floors`: a task whose type carries a floor can
 * never be classified below that floor.
 */
import type {
  CortexConfig,
  FileNode,
  ProjectGraph,
  RiskClassification,
  RiskLevel,
  TaskType,
} from '../domain/index';
import { DevCortexError } from '../domain/index';
import { isProtected } from './protected';
import { maxRisk, RISK_RANK } from './risk-order';

interface KeywordRule {
  readonly taskType: TaskType;
  readonly risk: RiskLevel;
  readonly label: string;
  /** Higher priority wins the task-type label when multiple rules match. */
  readonly priority: number;
  /** Tested against the lower-cased task text. Must be non-global (stateless). */
  readonly pattern: RegExp;
}

/**
 * Ordered most-specific/most-severe first. `priority` decides which matched
 * rule owns the task-type label; `risk` contributes to the overall risk level
 * (risk is the max across all matches, never a single rule's value alone).
 */
const KEYWORD_RULES: readonly KeywordRule[] = [
  // --- secrets / credentials (most sensitive surface) -----------------------
  {
    taskType: 'security',
    risk: 'critical',
    priority: 105,
    label: 'secret/credential handling',
    pattern:
      /\b(?:secret|secrets|credential|credentials|api[\s-]?keys?|private[\s-]?key|encryption[\s-]?key|password|passwords|token[\s-]?signing)\b/,
  },
  // --- database / migrations ------------------------------------------------
  {
    taskType: 'database',
    risk: 'critical',
    priority: 100,
    label: 'schema migration',
    pattern: /\bmigrat(?:e|es|ed|ion|ions)\b/,
  },
  {
    taskType: 'database',
    risk: 'critical',
    priority: 100,
    label: 'destructive DDL',
    pattern: /\b(?:drop|truncate|alter)\s+(?:table|column|schema|database|index)\b/,
  },
  {
    taskType: 'database',
    risk: 'high',
    priority: 100,
    label: 'database change',
    pattern:
      /\b(?:database|db|sql|postgres|postgresql|mysql|sqlite|mongodb|prisma|drizzle|schema|table|seed)\b/,
  },
  // --- security hardening ---------------------------------------------------
  {
    taskType: 'security',
    risk: 'high',
    priority: 95,
    label: 'security hardening',
    pattern:
      /\b(?:security|secure|vulnerability|vulnerabilities|cve|exploit|xss|csrf|ssrf|injection|sanitiz(?:e|es|ed|ation)|hardening|rate[\s-]?limit)\b/,
  },
  // --- auth -----------------------------------------------------------------
  {
    taskType: 'auth',
    risk: 'high',
    priority: 90,
    label: 'authentication/authorization',
    pattern:
      /\b(?:auth|authentication|authenticate|authorization|authorize|login|logout|signin|sign-in|signup|sign-up|oauth|openid|oidc|jwt|session|sessions|rbac|permission|permissions|access[\s-]?control|sso)\b/,
  },
  // --- billing --------------------------------------------------------------
  {
    taskType: 'billing',
    risk: 'high',
    priority: 88,
    label: 'payment/billing flow',
    pattern:
      /\b(?:billing|payment|payments|stripe|paypal|subscription|subscriptions|invoice|invoices|checkout|charge|charges|refund|refunds|paywall|pricing)\b/,
  },
  // --- devops / deploy ------------------------------------------------------
  {
    taskType: 'devops',
    risk: 'critical',
    priority: 82,
    label: 'production change',
    pattern: /\bproduction\b/,
  },
  {
    taskType: 'devops',
    risk: 'high',
    priority: 80,
    label: 'deployment/infrastructure',
    pattern:
      /\b(?:deploy|deployment|deployments|rollout|docker|dockerfile|kubernetes|k8s|terraform|helm|infra|infrastructure|pipeline|cicd)\b/,
  },
  // --- release --------------------------------------------------------------
  {
    taskType: 'release',
    risk: 'high',
    priority: 78,
    label: 'release/publish',
    pattern: /\b(?:release|publish|semver|version[\s-]?bump)\b/,
  },
  // --- dependency -----------------------------------------------------------
  {
    taskType: 'dependency',
    risk: 'medium',
    priority: 70,
    label: 'dependency change',
    pattern:
      /\b(?:dependency|dependencies|upgrade|upgrades|downgrade|lockfile|node_modules|vendored?)\b/,
  },
  // --- api ------------------------------------------------------------------
  {
    taskType: 'api',
    risk: 'medium',
    priority: 60,
    label: 'API surface',
    pattern:
      /\b(?:api|endpoint|endpoints|route|routes|rest|graphql|resolver|resolvers|controller|controllers|webhook|webhooks)\b/,
  },
  // --- ui -------------------------------------------------------------------
  {
    taskType: 'ui',
    risk: 'low',
    priority: 40,
    label: 'UI change',
    pattern:
      /\b(?:ui|component|components|button|buttons|modal|modals|css|style|styles|styling|layout|page|pages|frontend|tailwind|responsive)\b/,
  },
  // --- test -----------------------------------------------------------------
  {
    taskType: 'test',
    risk: 'low',
    priority: 38,
    label: 'test change',
    pattern: /\b(?:test|tests|spec|specs|coverage|vitest|jest|e2e|fixture|fixtures)\b/,
  },
  // --- feature --------------------------------------------------------------
  {
    taskType: 'feature',
    risk: 'medium',
    priority: 35,
    label: 'new feature',
    pattern: /\b(?:implement|implements|build|create|introduce|scaffold|feature|features)\b/,
  },
  // --- bugfix ---------------------------------------------------------------
  {
    taskType: 'bugfix',
    risk: 'low',
    priority: 30,
    label: 'bug fix',
    pattern: /\b(?:fix|fixes|fixed|bug|bugs|bugfix|patch|hotfix|crash|broken|regression)\b/,
  },
  // --- refactor -------------------------------------------------------------
  {
    taskType: 'refactor',
    risk: 'low',
    priority: 28,
    label: 'refactor',
    pattern:
      /\b(?:refactor|refactors|refactoring|cleanup|reorganize|restructure|rename|renames|extract|simplify|deduplicate)\b/,
  },
  // --- docs -----------------------------------------------------------------
  {
    taskType: 'docs',
    risk: 'low',
    priority: 25,
    label: 'documentation change',
    pattern: /\b(?:docs?|documentation|readme|comment|comments|typo|typos|wording|changelog)\b/,
  },
  // --- chore ----------------------------------------------------------------
  {
    taskType: 'chore',
    risk: 'low',
    priority: 20,
    label: 'chore',
    pattern: /\b(?:chore|format|formatting|lint|whitespace|tidy)\b/,
  },
];

/** Generic words that carry no relevance signal for file matching. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'onto',
  'out',
  'add',
  'use',
  'update',
  'updates',
  'change',
  'changes',
  'make',
  'makes',
  'new',
  'our',
  'your',
  'their',
  'all',
  'any',
  'some',
  'get',
  'set',
  'run',
  'via',
  'per',
  'not',
  'but',
  'too',
  'its',
]);

interface FileEscalation {
  readonly reason: string;
  readonly risk: RiskLevel;
}

/**
 * Classifies a task into a risk level + task type with explainable signals.
 *
 * @throws DevCortexError('INTERNAL') when `task` is not a non-empty string.
 */
export function classifyRisk(
  task: string,
  graph: ProjectGraph,
  config: CortexConfig,
): RiskClassification {
  if (typeof task !== 'string') {
    throw new DevCortexError('INTERNAL', 'classifyRisk: task must be a string');
  }
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new DevCortexError('INTERNAL', 'classifyRisk: task description must not be empty');
  }
  const haystack = trimmed.toLowerCase();

  const signals: string[] = [];
  let risk: RiskLevel = 'low';

  // 1. Keyword analysis.
  let best: KeywordRule | undefined;
  for (const rule of KEYWORD_RULES) {
    if (!rule.pattern.test(haystack)) {
      continue;
    }
    signals.push(`keyword: ${rule.label}`);
    risk = maxRisk(risk, rule.risk);
    if (
      best === undefined ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && RISK_RANK[rule.risk] > RISK_RANK[best.risk])
    ) {
      best = rule;
    }
  }
  const taskType: TaskType = best?.taskType ?? 'chore';
  if (best === undefined) {
    signals.push('no risk keywords detected');
  }

  // 2. Affected-file analysis — files the task plausibly touches can escalate
  //    risk regardless of wording.
  const riskySet = new Set(graph.riskyFiles);
  for (const file of relevantFiles(haystack, graph)) {
    const escalation = fileEscalation(file, riskySet, config);
    if (escalation !== undefined) {
      signals.push(escalation.reason);
      risk = maxRisk(risk, escalation.risk);
    }
  }

  // 3. Floor enforcement — a task type's floor can only raise risk, never lower.
  const floor = config.risk.floors[taskType];
  if (floor !== undefined) {
    const raised = maxRisk(risk, floor);
    if (RISK_RANK[raised] > RISK_RANK[risk]) {
      signals.push(`risk floor (${taskType}) raised risk to ${floor}`);
    }
    risk = raised;
  }

  const uniqueSignals = dedupe(signals);
  return {
    riskLevel: risk,
    taskType,
    signals: uniqueSignals,
    rationale: buildRationale(taskType, risk, uniqueSignals),
  };
}

/** Strongest single escalation a file contributes, or undefined if none. */
function fileEscalation(
  file: FileNode,
  riskySet: ReadonlySet<string>,
  config: CortexConfig,
): FileEscalation | undefined {
  const candidates: FileEscalation[] = [];

  switch (file.kind) {
    case 'migration':
      candidates.push({ reason: `affects migration file ${file.path}`, risk: 'critical' });
      break;
    case 'auth':
      candidates.push({ reason: `affects auth file ${file.path}`, risk: 'high' });
      break;
    case 'billing':
      candidates.push({ reason: `affects billing file ${file.path}`, risk: 'high' });
      break;
    case 'middleware':
      candidates.push({ reason: `affects middleware ${file.path}`, risk: 'high' });
      break;
    case 'env':
      candidates.push({ reason: `affects env file ${file.path}`, risk: 'high' });
      break;
    case 'config':
      candidates.push({ reason: `affects config file ${file.path}`, risk: 'medium' });
      break;
    default:
      break;
  }

  if (file.risky || riskySet.has(file.path)) {
    candidates.push({ reason: `affects risky file ${file.path}`, risk: 'high' });
  }
  if (isProtected(file.path, config)) {
    candidates.push({ reason: `affects protected path ${file.path}`, risk: 'high' });
  }

  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.reduce((strongest, candidate) =>
    RISK_RANK[candidate.risk] > RISK_RANK[strongest.risk] ? candidate : strongest,
  );
}

/** Files whose path/symbols/tags share a meaningful token with the task. */
function relevantFiles(haystack: string, graph: ProjectGraph): FileNode[] {
  const taskTokens = tokenize(haystack);
  if (taskTokens.size === 0) {
    return [];
  }
  const relevant: FileNode[] = [];
  for (const file of graph.files) {
    if (isFileRelevant(file, taskTokens)) {
      relevant.push(file);
    }
  }
  return relevant;
}

function isFileRelevant(file: FileNode, taskTokens: ReadonlySet<string>): boolean {
  for (const token of tokenize(file.path)) {
    if (taskTokens.has(token)) {
      return true;
    }
  }
  for (const symbol of file.symbols) {
    if (taskTokens.has(symbol.toLowerCase())) {
      return true;
    }
  }
  for (const tag of file.tags) {
    if (taskTokens.has(tag.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) {
      tokens.add(raw);
    }
  }
  return tokens;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function buildRationale(taskType: TaskType, risk: RiskLevel, signals: string[]): string {
  const shown = signals.slice(0, 4).join('; ');
  const overflow = signals.length > 4 ? ` (+${signals.length - 4} more)` : '';
  const evidence = shown.length > 0 ? `: ${shown}${overflow}` : '';
  return `Classified as "${taskType}" at ${risk} risk from ${signals.length} signal(s)${evidence}.`;
}
