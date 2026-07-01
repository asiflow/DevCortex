/**
 * @devcortex/mcp-server — stdio MCP server exposing the DevCortex cognition
 * engine (`@devcortex/core`) as `cortex.*` tools (design spec §7).
 *
 * Every tool is a thin, zod-validated wrapper over a single core capability and
 * returns its result as structured JSON text content. The engine is tokenless
 * and deterministic: tools scan/analyse the target repo locally rather than
 * calling any model. The target repo root is resolved once per process from
 * `--root <dir>` / `--root=<dir>`, then `DEVCORTEX_ROOT`, falling back to cwd.
 *
 * Failure handling honours the "never block without explanation / fail-safe"
 * philosophy: a tool that hits an internal error returns an `isError` result
 * carrying the stable DevCortexError `code` + message instead of crashing the
 * transport, so a host agent can reason about (and degrade past) the failure.
 */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  analyzeBlastRadius,
  analyzeFailures,
  assertValidSkill,
  blockUnprovenDone,
  builtInSkills,
  classifyRisk,
  compileContext,
  compileIntent,
  defaultConfig,
  depthForRisk,
  diagnose,
  evaluateToolCall,
  generateShipReport,
  installMcpSafely,
  isDevCortexError,
  isSafeSkillId,
  loadConfig,
  loadGraph,
  loadPolicy,
  matchPacks,
  recommendMcp,
  redactText,
  remedyForCategory,
  runDevopsGate,
  runPremiumUiGate,
  runProductGate,
  runQualityGate,
  runSecurityGate,
  runUiGate,
  runWorkflow,
  scanProject,
  selectWorkflow,
  skillsDir,
  verifyBuildEvidence,
  verifyCommandResult,
  verifyFileExists,
  verifyImportPath,
  verifyRouteExists,
  verifySymbolExists,
  workflowDefinitions,
  workspacePaths,
  DecisionLedger,
  EvidenceLedger,
  FeatureLedger,
  MemoryLedger,
  SchemaValidationError,
  SkillStore,
  CONTEXT_DEPTHS,
  EVIDENCE_KINDS,
  EVIDENCE_STATUSES,
  FEATURE_STATUSES,
  MEMORY_TYPES,
  RISK_LEVELS,
  SHIP_STATUSES,
  TASK_TYPES,
  WORKFLOW_IDS,
} from '@devcortex/core';
import type {
  ContextDepth,
  CortexConfig,
  MemoryInput,
  MemoryPatch,
  ProjectGraph,
  ShipReport,
  SkillManifest,
  StackPack,
  ToolCall,
  WorkflowDeps,
} from '@devcortex/core';

/** Server identity reported to MCP clients during initialization. */
const SERVER_NAME = '@devcortex/mcp-server';
const SERVER_VERSION = '0.1.0';

/** Namespace every tool is registered under (design spec §7: `cortex.*`). */
const TOOL_PREFIX = 'cortex.';

// --- shared zod fragments ---------------------------------------------------
// Built from the frozen domain const-arrays so the MCP boundary validates the
// exact same enums the engine does.

const riskLevelEnum = z.enum(RISK_LEVELS);
const contextDepthEnum = z.enum(CONTEXT_DEPTHS);
const memoryTypeEnum = z.enum(MEMORY_TYPES);
const evidenceStatusEnum = z.enum(EVIDENCE_STATUSES);
const evidenceKindEnum = z.enum(EVIDENCE_KINDS);
const featureStatusEnum = z.enum(FEATURE_STATUSES);
const shipStatusEnum = z.enum(SHIP_STATUSES);
const taskTypeEnum = z.enum(TASK_TYPES);
const workflowIdEnum = z.enum(WORKFLOW_IDS);

const evidenceRefSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  status: evidenceStatusEnum,
});

/**
 * Optional per-call override of the target repo root. When omitted a gate runs
 * against the server's process-resolved root; when supplied it is resolved to an
 * absolute path so a host can point a single server at multiple worktrees.
 */
const rootOverride = z
  .string()
  .min(1)
  .optional()
  .describe('Override the target repo root for this call (defaults to the server root).');

const checkResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
  evidenceId: z.string().optional(),
});

const shipReportSchema = z.object({
  status: shipStatusEnum,
  passed: z.array(checkResultSchema),
  blocked: z.array(checkResultSchema),
  warnings: z.array(z.string()),
  suggestedPrompt: z.string().optional(),
  evidenceIds: z.array(z.string()),
  generatedAt: z.string(),
});

// --- root resolution --------------------------------------------------------

/**
 * Resolve the target repo root from CLI args / env / cwd, in that precedence.
 * Accepts both `--root <dir>` and `--root=<dir>`. Pure and exported so the
 * contract test can exercise it without spawning a process.
 *
 * @throws Error when `--root` is supplied without a directory value.
 */
export function resolveRoot(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--root') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--root requires a directory argument');
      }
      return path.resolve(next);
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (value.length === 0) {
        throw new Error('--root= requires a directory argument');
      }
      return path.resolve(value);
    }
  }

  const envRoot = env.DEVCORTEX_ROOT;
  if (envRoot !== undefined && envRoot.trim().length > 0) {
    return path.resolve(envRoot);
  }

  return path.resolve(cwd);
}

// --- engine loaders ---------------------------------------------------------

/**
 * Load `.cortex/config.yaml`, falling back to the conservative default config
 * when the workspace has not been initialized yet. Any other config failure
 * (invalid YAML / schema) propagates so the caller sees a real error.
 */
async function loadConfigOrDefault(root: string): Promise<CortexConfig> {
  try {
    return await loadConfig(root);
  } catch (err) {
    if (isDevCortexError(err) && err.code === 'CONFIG_NOT_FOUND') {
      return defaultConfig();
    }
    throw err;
  }
}

/**
 * Return the cached project graph, or scan the repo fresh when no cache exists.
 * A malformed cache surfaces as a SchemaValidationError from `loadGraph`.
 */
async function loadGraphOrScan(root: string): Promise<ProjectGraph> {
  const cached = await loadGraph(root);
  if (cached !== null) {
    return cached;
  }
  return scanProject(root);
}

/**
 * Resolve the effective repo root for a gate call: an explicit per-call override
 * (resolved to absolute) when provided, otherwise the server's process root.
 */
function gateRoot(override: string | undefined, serverRoot: string): string {
  return override !== undefined ? path.resolve(override) : serverRoot;
}

/** Read a generated `.cortex/*.md` document, reporting absence as `exists:false`. */
async function readWorkspaceDoc(
  filePath: string,
): Promise<{ path: string; exists: boolean; markdown: string | null }> {
  try {
    const markdown = await readFile(filePath, 'utf8');
    return { path: filePath, exists: true, markdown };
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { path: filePath, exists: false, markdown: null };
    }
    throw err;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

// --- result helpers ---------------------------------------------------------

/** Wrap a JSON-serializable payload as MCP text content. */
function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Render any thrown value as a structured, `isError` MCP result. */
function errorResult(err: unknown): CallToolResult {
  const error = isDevCortexError(err)
    ? { code: err.code, message: err.message, details: err.details }
    : { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
  return {
    content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }],
    isError: true,
  };
}

/** Run a tool body, mapping success to JSON content and failure to an error result. */
async function guard(run: () => Promise<unknown> | unknown): Promise<CallToolResult> {
  try {
    return jsonResult(await run());
  } catch (err) {
    return errorResult(err);
  }
}

/** Exhaustiveness guard for discriminated-union switches (unreachable at runtime). */
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

// --- intelligence helpers ---------------------------------------------------
// Small, pure, deterministic composition logic for the skill / best-practice
// surfaces the core engine exposes as primitives rather than a single call.

/** A single skill ranked against a task, for the `recommend_skill` tool. */
interface SkillRecommendation {
  id: string;
  name: string;
  description: string;
  status: SkillManifest['status'];
  source: string;
  score: number;
  matchedTriggers: string[];
}

/** Word tokenizer: lowercase alphanumeric runs of length >= 3 (drops noise). */
const WORD_RE = /[a-z0-9]+/g;
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).filter((word) => word.length >= 3);
}

/** A trigger fires when its phrase is a substring of the task or its tokens overlap. */
function triggerMatches(trigger: string, task: string, taskTokens: ReadonlySet<string>): boolean {
  const phrase = trigger.toLowerCase().trim();
  if (phrase.length === 0) {
    return false;
  }
  if (task.toLowerCase().includes(phrase)) {
    return true;
  }
  return tokenize(trigger).some((token) => taskTokens.has(token));
}

/** Merge built-in and project skills by id; a project skill overrides a built-in one. */
function mergeSkillsById(
  builtIn: readonly SkillManifest[],
  project: readonly SkillManifest[],
): SkillManifest[] {
  const byId = new Map<string, SkillManifest>();
  for (const skill of builtIn) {
    byId.set(skill.id, skill);
  }
  for (const skill of project) {
    byId.set(skill.id, skill);
  }
  return [...byId.values()];
}

/**
 * Rank skills by relevance to a task. A matched trigger is worth more than a
 * name/description token overlap. Zero-score skills are dropped; ties break on
 * id so the ordering is stable and testable.
 */
function rankSkillsForTask(skills: readonly SkillManifest[], task: string): SkillRecommendation[] {
  const taskTokens = new Set(tokenize(task));
  const recommendations: SkillRecommendation[] = [];
  for (const skill of skills) {
    const matchedTriggers = skill.triggers.filter((trigger) =>
      triggerMatches(trigger, task, taskTokens),
    );
    const textTokens = new Set([...tokenize(skill.name), ...tokenize(skill.description)]);
    let textOverlap = 0;
    for (const token of taskTokens) {
      if (textTokens.has(token)) {
        textOverlap += 1;
      }
    }
    const score = matchedTriggers.length * 2 + textOverlap;
    if (score > 0) {
      recommendations.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        status: skill.status,
        source: skill.source,
        score,
        matchedTriggers,
      });
    }
  }
  recommendations.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return recommendations;
}

/** Ids of the best-practice / anti-pattern rules whose text is relevant to a task. */
function relevantRuleIds(packs: readonly StackPack[], taskTokens: ReadonlySet<string>): string[] {
  if (taskTokens.size === 0) {
    return [];
  }
  const ids: string[] = [];
  for (const pack of packs) {
    for (const rule of [...pack.bestPractices, ...pack.antiPatterns]) {
      const ruleTokens = new Set([...tokenize(rule.title), ...tokenize(rule.detail)]);
      for (const token of taskTokens) {
        if (ruleTokens.has(token)) {
          ids.push(rule.id);
          break;
        }
      }
    }
  }
  return ids;
}

/** Deterministic next-prompt fallback when a ship report carries no suggestedPrompt. */
function defaultNextPrompt(report: ShipReport): string {
  switch (report.status) {
    case 'READY':
      return 'All quality checks passed with recorded evidence. You may proceed to ship.';
    case 'READY_WITH_WARNINGS':
      return report.warnings.length > 0
        ? `Ship is possible, but address these warnings first:\n${report.warnings
            .map((warning) => `- ${warning}`)
            .join('\n')}`
        : 'Ship is possible with warnings. Review the report before shipping.';
    case 'NOT_READY':
      return report.blocked.length > 0
        ? `Do not ship yet. Resolve these blocked checks and re-run the gate:\n${report.blocked
            .map((check) => `- ${check.name}: ${check.detail}`)
            .join('\n')}`
        : 'Do not ship yet. Re-run the quality gate to collect the missing evidence.';
    default:
      return assertNever(report.status);
  }
}

// --- server assembly --------------------------------------------------------

/**
 * Build a fully-wired DevCortex MCP server bound to `root`. Pure: it registers
 * tools but attaches no transport, so it is reusable from the stdio bin and
 * from in-process test harnesses alike.
 */
export function createServer(root: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerCortexTools(server, root);
  return server;
}

/** The full set of `cortex.*` tool names this server exposes. */
export const CORTEX_TOOL_NAMES: readonly string[] = [
  'cortex.get_project_brief',
  'cortex.compile_context',
  'cortex.compile_intent',
  'cortex.classify_task_risk',
  'cortex.analyze_blast_radius',
  'cortex.get_feature_ledger',
  'cortex.get_architecture_map',
  'cortex.get_quality_constitution',
  'cortex.run_quality_gate',
  'cortex.generate_ship_report',
  'cortex.run_ui_gate',
  'cortex.run_security_gate',
  'cortex.run_devops_gate',
  'cortex.run_product_gate',
  'cortex.run_premium_ui_gate',
  'cortex.update_memory',
  'cortex.record_evidence',
  'cortex.verify_file',
  'cortex.verify_route',
  'cortex.verify_symbol',
  'cortex.verify_import',
  'cortex.verify_command',
  'cortex.verify_build',
  'cortex.block_unproven_done',
  'cortex.recommend_skill',
  'cortex.install_skill',
  'cortex.list_workflows',
  'cortex.run_workflow',
  'cortex.explain_failure',
  'cortex.create_regression_check',
  'cortex.generate_next_prompt',
  'cortex.check_best_practices',
  'cortex.recommend_mcp',
  'cortex.install_mcp_safely',
  'cortex.evaluate_tool_call',
  'cortex.redact_text',
];

function registerCortexTools(server: McpServer, root: string): void {
  // --- context / memory surfaces -------------------------------------------

  server.registerTool(
    `${TOOL_PREFIX}get_project_brief`,
    {
      title: 'Get project brief',
      description:
        'Return the generated project brief (.cortex/project.md). Reports exists:false when the workspace has not generated one yet.',
      inputSchema: {},
    },
    () => guard(() => readWorkspaceDoc(workspacePaths(root).projectMd)),
  );

  server.registerTool(
    `${TOOL_PREFIX}get_architecture_map`,
    {
      title: 'Get architecture map',
      description:
        'Return the generated architecture map (.cortex/architecture.md). Reports exists:false when absent.',
      inputSchema: {},
    },
    () => guard(() => readWorkspaceDoc(workspacePaths(root).architectureMd)),
  );

  server.registerTool(
    `${TOOL_PREFIX}get_quality_constitution`,
    {
      title: 'Get quality constitution',
      description:
        'Return the project quality constitution (.cortex/quality-constitution.md). Reports exists:false when absent.',
      inputSchema: {},
    },
    () => guard(() => readWorkspaceDoc(workspacePaths(root).qualityConstitution)),
  );

  server.registerTool(
    `${TOOL_PREFIX}get_feature_ledger`,
    {
      title: 'Get feature ledger',
      description:
        'Read the feature ledger: a single feature by id, all features filtered by status, or every feature.',
      inputSchema: {
        id: z.string().min(1).optional().describe('Return only the feature with this id.'),
        status: featureStatusEnum.optional().describe('Filter features by lifecycle status.'),
      },
    },
    (args) =>
      guard(async () => {
        const ledger = new FeatureLedger(root);
        if (args.id !== undefined) {
          const feature = await ledger.get(args.id);
          return feature === undefined ? { found: false, id: args.id } : { found: true, feature };
        }
        if (args.status !== undefined) {
          const status = args.status;
          const features = await ledger.list((f) => f.status === status);
          return { count: features.length, features };
        }
        const features = await ledger.all();
        return { count: features.length, features };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}update_memory`,
    {
      title: 'Add or update a memory item',
      description:
        'Append a new memory item, or patch an existing one when `id` is provided. Memory carries confidence + evidence so unverified facts are never promoted to permanent truth.',
      inputSchema: {
        id: z.string().min(1).optional().describe('When set, patch this existing memory item.'),
        type: memoryTypeEnum.optional(),
        title: z.string().min(1).optional(),
        summary: z.string().optional(),
        source: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        evidence: z.array(evidenceRefSchema).optional(),
        relatedFiles: z.array(z.string()).optional(),
        relatedFeatures: z.array(z.string()).optional(),
        riskLevel: riskLevelEnum.optional(),
        expiry: z.string().optional(),
        lastVerified: z.string().optional(),
      },
    },
    (args) =>
      guard(async () => {
        const ledger = new MemoryLedger(root);

        if (args.id !== undefined) {
          const patch: MemoryPatch = {};
          if (args.type !== undefined) patch.type = args.type;
          if (args.title !== undefined) patch.title = args.title;
          if (args.summary !== undefined) patch.summary = args.summary;
          if (args.source !== undefined) patch.source = args.source;
          if (args.confidence !== undefined) patch.confidence = args.confidence;
          if (args.evidence !== undefined) patch.evidence = args.evidence;
          if (args.relatedFiles !== undefined) patch.relatedFiles = args.relatedFiles;
          if (args.relatedFeatures !== undefined) patch.relatedFeatures = args.relatedFeatures;
          if (args.riskLevel !== undefined) patch.riskLevel = args.riskLevel;
          if (args.expiry !== undefined) patch.expiry = args.expiry;
          if (args.lastVerified !== undefined) patch.lastVerified = args.lastVerified;
          const memory = await ledger.update(args.id, patch);
          return { action: 'updated', memory };
        }

        if (
          args.type === undefined ||
          args.title === undefined ||
          args.summary === undefined ||
          args.source === undefined
        ) {
          throw new SchemaValidationError(
            'Adding a memory item requires `type`, `title`, `summary` and `source` (or pass `id` to update an existing item).',
          );
        }

        const input: MemoryInput = {
          type: args.type,
          title: args.title,
          summary: args.summary,
          source: args.source,
          confidence: args.confidence ?? 0.5,
          evidence: args.evidence ?? [],
          relatedFiles: args.relatedFiles ?? [],
          relatedFeatures: args.relatedFeatures ?? [],
          riskLevel: args.riskLevel ?? 'low',
        };
        if (args.expiry !== undefined) input.expiry = args.expiry;
        if (args.lastVerified !== undefined) input.lastVerified = args.lastVerified;

        const memory = await ledger.add(input);
        return { action: 'added', memory };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}record_evidence`,
    {
      title: 'Record evidence',
      description:
        'Append an immutable EvidenceItem (verified/partial/refuted/unverified) to the append-only evidence ledger.',
      inputSchema: {
        claim: z.string().min(1),
        status: evidenceStatusEnum,
        kind: evidenceKindEnum,
        detail: z.string(),
        command: z.string().optional(),
        exitCode: z.number().int().optional(),
        output: z.string().optional(),
      },
    },
    (args) =>
      guard(async () => {
        const ledger = new EvidenceLedger(root);
        const evidence = await ledger.add({
          claim: args.claim,
          status: args.status,
          kind: args.kind,
          detail: args.detail,
          command: args.command,
          exitCode: args.exitCode,
          output: args.output,
        });
        return { evidence };
      }),
  );

  // --- compilers / policy / blast radius -----------------------------------

  server.registerTool(
    `${TOOL_PREFIX}classify_task_risk`,
    {
      title: 'Classify task risk',
      description:
        'Classify a task into a RiskClassification (riskLevel, taskType, signals, rationale) using keyword + affected-file analysis honoring config risk floors.',
      inputSchema: { task: z.string().min(1).describe('Natural-language task description.') },
    },
    (args) =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const config = await loadConfigOrDefault(root);
        return classifyRisk(args.task, graph, config);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}compile_intent`,
    {
      title: 'Compile intent contract',
      description:
        'Turn a vague task into a precise engineering contract (goals, acceptance criteria, stages, verification plan, definition of done).',
      inputSchema: { task: z.string().min(1).describe('Natural-language task description.') },
    },
    (args) =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const config = await loadConfigOrDefault(root);
        const packs = matchPacks(graph.stack);
        return compileIntent(args.task, graph, packs, config);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}compile_context`,
    {
      title: 'Compile context pack',
      description:
        'Assemble the minimum-complete, compressed context pack for a task. Depth defaults to the risk-derived depth (tiny/standard/deep) unless overridden.',
      inputSchema: {
        task: z.string().min(1).describe('Natural-language task description.'),
        depth: contextDepthEnum.optional().describe('Override the risk-derived context depth.'),
      },
    },
    (args) =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const config = await loadConfigOrDefault(root);
        const packs = matchPacks(graph.stack);
        const intent = compileIntent(args.task, graph, packs, config);
        const depth: ContextDepth = args.depth ?? depthForRisk(intent.riskLevel);
        const ledgers = {
          memory: new MemoryLedger(root),
          feature: new FeatureLedger(root),
          decision: new DecisionLedger(root),
        };
        const context = await compileContext(intent, graph, ledgers, depth);
        return { intent, depth, context };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}analyze_blast_radius`,
    {
      title: 'Analyze blast radius',
      description:
        'Given changed files, compute what could break (routes, components, api, tables, auth/billing, env, tests, fragile areas), the required checks, and a severity.',
      inputSchema: {
        changedFiles: z
          .array(z.string().min(1))
          .describe('Repo-relative POSIX paths of the files that changed.'),
      },
    },
    (args) =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const config = await loadConfigOrDefault(root);
        return analyzeBlastRadius(graph, args.changedFiles, config);
      }),
  );

  // --- gates ----------------------------------------------------------------

  server.registerTool(
    `${TOOL_PREFIX}run_quality_gate`,
    {
      title: 'Run quality gate',
      description:
        'Run the configured typecheck/lint/build/test commands plus route/env checks against the repo, returning a GateResult and the collected evidence.',
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const config = await loadConfigOrDefault(root);
        return runQualityGate(root, config, graph);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}generate_ship_report`,
    {
      title: 'Generate ship report',
      description:
        'Run the quality gate, persist evidence, and synthesize a ShipReport (READY / READY_WITH_WARNINGS / NOT_READY) with a suggested next-prompt when blocked.',
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const config = await loadConfigOrDefault(root);
        return generateShipReport(root, config, graph, { evidence: new EvidenceLedger(root) });
      }),
  );

  // --- deep quality gates (sub-project #4, spec §7.12-7.13 + §7.21) ---------
  // Each gate is a tokenless, deterministic heuristic over the ProjectGraph +
  // real file reads. Findings are returned as CheckResults inside a GateResult;
  // a gate only throws on internal error (mapped to a structured isError result).

  server.registerTool(
    `${TOOL_PREFIX}run_ui_gate`,
    {
      title: 'Run UI quality gate',
      description:
        'Run the deep UI gate: deterministic JSX/Tailwind heuristics for responsive layout, data-state handling, accessibility, keyboard-navigation and dark-mode consistency. Returns a GateResult with per-category CheckResults plus the collected evidence.',
      inputSchema: { root: rootOverride },
    },
    (args) =>
      guard(async () => {
        const targetRoot = gateRoot(args.root, root);
        const graph = await loadGraphOrScan(targetRoot);
        const config = await loadConfigOrDefault(targetRoot);
        return runUiGate(targetRoot, graph, config);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}run_security_gate`,
    {
      title: 'Run security gate',
      description:
        'Run the deep security gate: heuristics for committed secrets, client-exposed secret env vars, secret leakage, unverified webhook signatures, missing input validation, permissive CORS, auth risks and dependency audit. Returns a GateResult with per-category CheckResults plus evidence.',
      inputSchema: { root: rootOverride },
    },
    (args) =>
      guard(async () => {
        const targetRoot = gateRoot(args.root, root);
        const graph = await loadGraphOrScan(targetRoot);
        const config = await loadConfigOrDefault(targetRoot);
        return runSecurityGate(targetRoot, graph, config);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}run_devops_gate`,
    {
      title: 'Run devops gate',
      description:
        'Run the deep devops gate: heuristics for env-var wiring, Dockerfile hardening, secret exposure, Kubernetes non-root, CI health, build config and rollback plan. Returns a GateResult with per-category CheckResults plus evidence.',
      inputSchema: { root: rootOverride },
    },
    (args) =>
      guard(async () => {
        const targetRoot = gateRoot(args.root, root);
        const graph = await loadGraphOrScan(targetRoot);
        const config = await loadConfigOrDefault(targetRoot);
        return runDevopsGate(targetRoot, graph, config);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}run_product_gate`,
    {
      title: 'Run product-readiness gate',
      description:
        'Run the deep product-readiness gate: heuristics for placeholder pages, fake/non-wired buttons, dead links, missing loading/error states and unmet acceptance criteria on shipped/building features. Returns a GateResult with per-category CheckResults plus evidence.',
      inputSchema: { root: rootOverride },
    },
    (args) =>
      guard(async () => {
        const targetRoot = gateRoot(args.root, root);
        const graph = await loadGraphOrScan(targetRoot);
        const config = await loadConfigOrDefault(targetRoot);
        return runProductGate(targetRoot, graph, config);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}run_premium_ui_gate`,
    {
      title: 'Score premium UI quality',
      description:
        'Score the UI surface across visual-hierarchy, mobile-responsiveness, spacing-consistency, accessibility and premium-feel dimensions (each 0-100), returning an overall score and the highest-leverage fixes ordered most-impactful-first. Deterministic; no threshold gating.',
      inputSchema: { root: rootOverride },
    },
    (args) =>
      guard(async () => {
        const targetRoot = gateRoot(args.root, root);
        const graph = await loadGraphOrScan(targetRoot);
        return runPremiumUiGate(targetRoot, graph);
      }),
  );

  // --- evidence verifiers ---------------------------------------------------

  server.registerTool(
    `${TOOL_PREFIX}verify_file`,
    {
      title: 'Verify file exists',
      description: 'Verify that a repo-relative file exists on disk, returning an EvidenceItem.',
      inputSchema: { path: z.string().min(1).describe('Repo-relative file path.') },
    },
    (args) => guard(() => verifyFileExists(root, args.path)),
  );

  server.registerTool(
    `${TOOL_PREFIX}verify_route`,
    {
      title: 'Verify route exists',
      description: 'Verify that a route is present in the project graph, returning an EvidenceItem.',
      inputSchema: { route: z.string().min(1).describe('Route path, e.g. "/api/user".') },
    },
    (args) =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        return verifyRouteExists(graph, args.route);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}verify_symbol`,
    {
      title: 'Verify symbol exists',
      description:
        'Verify that a top-level symbol is exported/defined in a file, returning an EvidenceItem.',
      inputSchema: {
        path: z.string().min(1).describe('Repo-relative file path.'),
        symbol: z.string().min(1).describe('Symbol name to look for.'),
      },
    },
    (args) => guard(() => verifySymbolExists(root, args.path, args.symbol)),
  );

  server.registerTool(
    `${TOOL_PREFIX}verify_import`,
    {
      title: 'Verify import resolves',
      description:
        'Verify that an import specifier resolves from a given source file, returning an EvidenceItem.',
      inputSchema: {
        fromFile: z.string().min(1).describe('Repo-relative file doing the importing.'),
        importPath: z.string().min(1).describe('The import specifier to resolve.'),
      },
    },
    (args) => guard(() => verifyImportPath(root, args.fromFile, args.importPath)),
  );

  server.registerTool(
    `${TOOL_PREFIX}verify_command`,
    {
      title: 'Verify command result',
      description:
        'Run a shell command in the repo root with a timeout and capture exit code + truncated output as an EvidenceItem (verified when it exits 0).',
      inputSchema: {
        command: z.string().min(1).describe('The command to run.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Wall-clock kill deadline in ms (default 120000).'),
      },
    },
    (args) =>
      guard(() =>
        verifyCommandResult(args.command, { cwd: root, timeoutMs: args.timeoutMs }),
      ),
  );

  server.registerTool(
    `${TOOL_PREFIX}verify_build`,
    {
      title: 'Verify build',
      description:
        'Run the configured build command for the repo and capture the result as an EvidenceItem.',
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const config = await loadConfigOrDefault(root);
        return verifyBuildEvidence(root, config);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}block_unproven_done`,
    {
      title: 'Block unproven done',
      description:
        'Given a ShipReport, decide whether work may be marked done. Returns { blocked, reasons }.',
      inputSchema: { report: shipReportSchema.describe('The ShipReport to evaluate.') },
    },
    (args) => guard(() => blockUnprovenDone(args.report as ShipReport)),
  );

  // --- skills ---------------------------------------------------------------

  server.registerTool(
    `${TOOL_PREFIX}recommend_skill`,
    {
      title: 'Recommend skills',
      description:
        "Rank the skills relevant to a task by matching its wording against each skill's triggers, name and description. Considers both the built-in skill pack and project-local skills under .cortex/skills/.",
      inputSchema: {
        task: z.string().min(1).describe('Natural-language task description.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of skills to return (default: all matches).'),
      },
    },
    (args) =>
      guard(async () => {
        const projectSkills = await new SkillStore(root).all();
        const ranked = rankSkillsForTask(mergeSkillsById(builtInSkills, projectSkills), args.task);
        const recommendations = args.limit === undefined ? ranked : ranked.slice(0, args.limit);
        return { task: args.task, count: recommendations.length, recommendations };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}install_skill`,
    {
      title: 'Install a built-in skill',
      description:
        'Copy a built-in skill into the project skill store (.cortex/skills/<id>.json) so it becomes a project-local, editable skill. Rejects unknown or unsafely-named ids. Installation is explicit: the host agent decides when to call this after recommend_skill.',
      inputSchema: {
        id: z.string().min(1).describe('The id of a built-in skill to install (see recommend_skill).'),
      },
    },
    (args) =>
      guard(async () => {
        if (!isSafeSkillId(args.id)) {
          throw new SchemaValidationError(
            `"${args.id}" is not a safe skill id (skills are stored as <id>.json).`,
            { details: { id: args.id } },
          );
        }
        const builtIn = builtInSkills.find((skill) => skill.id === args.id);
        if (builtIn === undefined) {
          throw new SchemaValidationError(
            `Unknown skill id "${args.id}"; only built-in skills can be installed by id.`,
            { details: { id: args.id, available: builtInSkills.map((skill) => skill.id) } },
          );
        }
        assertValidSkill(builtIn, 'install');
        const installed = await new SkillStore(root).save({
          ...builtIn,
          updatedAt: new Date().toISOString(),
        });
        return {
          action: 'installed',
          skill: installed,
          path: path.join(skillsDir(root), `${installed.id}.json`),
        };
      }),
  );

  // --- workflows ------------------------------------------------------------

  server.registerTool(
    `${TOOL_PREFIX}list_workflows`,
    {
      title: 'List workflows',
      description:
        'List the built-in, risk-scaled workflow definitions. When taskType + risk are both supplied, also returns the workflow selected for that combination.',
      inputSchema: {
        taskType: taskTypeEnum
          .optional()
          .describe('When set with risk, also return the selected workflow.'),
        risk: riskLevelEnum
          .optional()
          .describe('When set with taskType, also return the selected workflow.'),
      },
    },
    (args) =>
      guard(() => {
        const selected =
          args.taskType !== undefined && args.risk !== undefined
            ? selectWorkflow(args.taskType, args.risk)
            : undefined;
        return { count: workflowDefinitions.length, workflows: workflowDefinitions, selected };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}run_workflow`,
    {
      title: 'Run a workflow',
      description:
        'Execute a named workflow end-to-end (classify -> intent -> context -> blast-radius -> stack-pack -> verify -> regression -> memory -> ship-report -> learn), scaling depth by risk, and persist the WorkflowRun under .cortex/workflows/.',
      inputSchema: {
        workflowId: workflowIdEnum.describe('Which workflow to run (see list_workflows).'),
        task: z.string().min(1).describe('Natural-language task description.'),
      },
    },
    (args) =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const config = await loadConfigOrDefault(root);
        const deps: WorkflowDeps = {
          graph,
          config,
          ledgers: {
            memory: new MemoryLedger(root),
            feature: new FeatureLedger(root),
            decision: new DecisionLedger(root),
            evidence: new EvidenceLedger(root),
          },
        };
        return runWorkflow(root, args.workflowId, args.task, deps);
      }),
  );

  // --- learning -------------------------------------------------------------

  server.registerTool(
    `${TOOL_PREFIX}explain_failure`,
    {
      title: 'Explain recurring failures',
      description:
        'Scan the evidence ledger + flight recorder for repeated failure signatures, diagnose each root cause (missing-context / missing-skill / outdated-docs / wrong-package / bad-rule / missing-test / weak-agent / missing-mcp) and report the remedy kind the learning engine would create.',
      inputSchema: {
        minOccurrences: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Minimum recurrence for a signature to count as a learned failure (default: 2).'),
      },
    },
    (args) =>
      guard(async () => {
        const options = args.minOccurrences === undefined ? {} : { minOccurrences: args.minOccurrences };
        const failures = await analyzeFailures(root, options);
        const explained = failures.map((failure) => {
          const diagnosis = diagnose(failure);
          return {
            signature: failure.signature,
            occurrences: failure.occurrences,
            diagnosis,
            remedy: remedyForCategory(diagnosis.category),
          };
        });
        return { count: explained.length, failures: explained };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}create_regression_check`,
    {
      title: 'Create a regression check',
      description:
        'Compute the blast radius of a set of changed files and persist its required checks as a durable regression-check constraint in the memory ledger, so the same verifications are re-run whenever those files change again.',
      inputSchema: {
        changedFiles: z
          .array(z.string().min(1))
          .min(1)
          .describe('Repo-relative POSIX paths of the files whose regression surface should be captured.'),
        title: z.string().min(1).optional().describe('Override the generated constraint title.'),
      },
    },
    (args) =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const config = await loadConfigOrDefault(root);
        const blast = analyzeBlastRadius(graph, args.changedFiles, config);
        if (blast.requiredChecks.length === 0) {
          return {
            created: false,
            reason: 'No required checks were derived from these changes; nothing to persist.',
            blastRadius: blast,
          };
        }
        const title =
          args.title ??
          `Regression check: ${args.changedFiles.length} file(s), ${blast.severity} severity`;
        const summary = [
          'Whenever these files change, re-run the required checks below.',
          '',
          `Changed files:\n${args.changedFiles.map((file) => `- ${file}`).join('\n')}`,
          '',
          `Required checks:\n${blast.requiredChecks.map((check) => `- ${check}`).join('\n')}`,
        ].join('\n');
        const memory = await new MemoryLedger(root).add({
          type: 'constraint',
          title,
          summary,
          source: 'cortex.create_regression_check',
          confidence: 0.9,
          evidence: [],
          relatedFiles: args.changedFiles,
          relatedFeatures: [],
          riskLevel: blast.severity,
        });
        return {
          created: true,
          memory,
          requiredChecks: blast.requiredChecks,
          severity: blast.severity,
        };
      }),
  );

  // --- prompts / best practices --------------------------------------------

  server.registerTool(
    `${TOOL_PREFIX}generate_next_prompt`,
    {
      title: 'Generate the next prompt',
      description:
        'Derive the next actionable prompt for the host agent from a ship report. Pass an existing ShipReport, or omit it to generate a fresh one by running the quality gate. Returns the report status and a concrete next instruction.',
      inputSchema: {
        report: shipReportSchema
          .optional()
          .describe('An existing ShipReport to derive the next prompt from. When omitted, a fresh report is generated.'),
      },
    },
    (args) =>
      guard(async () => {
        let report: ShipReport;
        if (args.report !== undefined) {
          report = args.report as ShipReport;
        } else {
          const graph = await loadGraphOrScan(root);
          const config = await loadConfigOrDefault(root);
          report = await generateShipReport(root, config, graph, {
            evidence: new EvidenceLedger(root),
          });
        }
        return {
          status: report.status,
          suggestedPrompt: report.suggestedPrompt ?? null,
          nextPrompt: report.suggestedPrompt ?? defaultNextPrompt(report),
          blocked: report.blocked,
          warnings: report.warnings,
        };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}check_best_practices`,
    {
      title: 'Check best practices',
      description:
        "Return the best-practice and anti-pattern rules that apply to the project's detected stack, plus version checks and security/deployment notes. When a task is supplied, the rules whose text is relevant to that task are flagged.",
      inputSchema: {
        task: z.string().min(1).optional().describe('When set, flag the rules most relevant to this task.'),
      },
    },
    (args) =>
      guard(async () => {
        const graph = await loadGraphOrScan(root);
        const packs = matchPacks(graph.stack);
        const taskTokens = args.task === undefined ? new Set<string>() : new Set(tokenize(args.task));
        return {
          stack: graph.stack,
          matchedPackIds: packs.map((pack) => pack.id),
          packs: packs.map((pack) => ({
            id: pack.id,
            name: pack.name,
            bestPractices: pack.bestPractices,
            antiPatterns: pack.antiPatterns,
            versionChecks: pack.versionChecks,
            recommendedLibraries: pack.recommendedLibraries,
            securityNotes: pack.securityNotes,
            deploymentNotes: pack.deploymentNotes,
          })),
          relevantRuleIds: args.task === undefined ? undefined : relevantRuleIds(packs, taskTokens),
        };
      }),
  );

  // --- MCP governance & privacy (sub-project #5, spec §7.19-7.20 + §7.22) ---
  // A curated MCP catalog + recommendation, a read-only-by-default installer, a
  // deterministic allow/deny/approval firewall, and a secret/PII redactor. All
  // tokenless: they scan the target repo + the persisted policy locally.

  server.registerTool(
    `${TOOL_PREFIX}recommend_mcp`,
    {
      title: 'Recommend MCP servers',
      description:
        'Rank the curated MCP catalog against a task description and the scanned project graph, best-first. Deterministic and tokenless: task keywords and hard stack signals (framework, env vars, scripts, file paths) drive the score; universally-useful servers (filesystem, git) always surface. Returns honestly-scoped McpServerSpecs (trust, permissions, tools, secretsRequired, sandbox).',
      inputSchema: {
        task: z.string().min(1).describe('Natural-language description of what you want the MCP server for.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of servers to return (default: all matches).'),
        root: rootOverride,
      },
    },
    (args) =>
      guard(async () => {
        const targetRoot = gateRoot(args.root, root);
        const graph = await loadGraphOrScan(targetRoot);
        const ranked = recommendMcp(args.task, graph);
        const recommendations = args.limit === undefined ? ranked : ranked.slice(0, args.limit);
        return { task: args.task, count: recommendations.length, recommendations };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}install_mcp_safely`,
    {
      title: 'Install an MCP server safely',
      description:
        'Install a vetted catalog server by id with a DEFAULT-READ-ONLY posture: empty env placeholders (never secret values), a namespaced devcortex annotation, the entry written to .mcp.json, and the McpServerSpec recorded under .cortex/mcp/. Refuses unknown (uncatalogued) ids. Confirm-before-overwrite: if the id already exists and force is not set, returns { status: "exists", plan } and writes NOTHING.',
      inputSchema: {
        id: z.string().min(1).describe('The id of a catalog server to install (see recommend_mcp).'),
        force: z
          .boolean()
          .optional()
          .describe('Overwrite an existing .mcp.json entry for this id (default: false — confirm first).'),
        root: rootOverride,
      },
    },
    (args) =>
      guard(async () => {
        const targetRoot = gateRoot(args.root, root);
        const opts = args.force === undefined ? {} : { force: args.force };
        return installMcpSafely(targetRoot, args.id, opts);
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}evaluate_tool_call`,
    {
      title: 'Evaluate an MCP tool call',
      description:
        'Ask the MCP security firewall for a verdict on a proposed tool call, evaluated against the persisted policy (.cortex/policies/mcp-firewall.json; safe read-only defaults when absent). Combines rule matching (deny > allow > require-approval), a 0-100 command-risk score (destructive/secret/network heuristics), and prompt-injection + secret scanning over the stringified args. An allow verdict escalates to require-approval on any injection signal or elevated risk. Returns { decision, reasons, riskScore, redactedArgs }.',
      inputSchema: {
        server: z.string().min(1).describe('The MCP server id, e.g. "github".'),
        tool: z.string().min(1).describe('The tool name on that server, e.g. "delete_branch".'),
        args: z
          .unknown()
          .optional()
          .describe('The arguments the agent wants to pass (any JSON-serialisable value); scanned + redacted, never persisted.'),
        root: rootOverride,
      },
    },
    (rawArgs) =>
      guard(async () => {
        const targetRoot = gateRoot(rawArgs.root, root);
        const policy = await loadPolicy(targetRoot);
        const call: ToolCall = { server: rawArgs.server, tool: rawArgs.tool };
        if (rawArgs.args !== undefined) {
          call.args = rawArgs.args;
        }
        return { server: call.server, tool: call.tool, ...evaluateToolCall(policy, call) };
      }),
  );

  server.registerTool(
    `${TOOL_PREFIX}redact_text`,
    {
      title: 'Redact secrets and PII from text',
      description:
        'Mask and tally secrets, credentials and PII (api-key, secret, token, private-key, password, env, db-url, email, phone) in a text buffer before it is logged, cached or sent to the cloud. Deterministic and tokenless (no LLM, no network). Returns { redacted, findings[] } where each finding reports a kind + the number of occurrences masked.',
      inputSchema: {
        text: z.string().describe('The text buffer to redact. Redaction is total over strings; empty input yields no findings.'),
      },
    },
    (args) => guard(() => redactText(args.text)),
  );
}

// --- stdio entrypoint -------------------------------------------------------

async function main(): Promise<void> {
  const root = resolveRoot(process.argv.slice(2), process.env, process.cwd());
  const server = createServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * True when this module is the process entrypoint (run as the `devcortex-mcp`
 * bin), false when imported (e.g. by the contract test). Resolves symlinks so
 * the pnpm `.bin` shim still matches the real built file.
 */
async function isMainModule(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    const [entryReal, selfReal] = await Promise.all([
      realpath(entry),
      realpath(fileURLToPath(import.meta.url)),
    ]);
    return entryReal === selfReal;
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[devcortex-mcp] fatal: ${message}\n`);
    process.exitCode = 1;
  });
}
