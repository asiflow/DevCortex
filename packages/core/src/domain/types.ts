// ============================================================================
// DevCortex domain contract — shared types.
//
// This file is the single source of truth for the data shapes that flow
// between every engine module (graph, ledgers, compilers, blast-radius, gates,
// policy, evidence, stackpacks) and every surface (CLI, MCP server, Claude
// integration). Persisted artifacts also have zod schemas in ./schemas that are
// compile-time-checked to match these interfaces; this file owns the canonical
// interface, schemas own runtime validation at the disk boundary.
//
// Convention: relative imports omit extensions (moduleResolution: "Bundler").
// ============================================================================

// --- Risk, modes, depth, privacy -------------------------------------------

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const OPERATING_MODES = ['passive', 'guarded', 'autopilot'] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

export const CONTEXT_DEPTHS = ['tiny', 'standard', 'deep'] as const;
export type ContextDepth = (typeof CONTEXT_DEPTHS)[number];

export const PRIVACY_MODES = ['local-only', 'metadata-cloud', 'deep-cloud'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

// --- Task taxonomy ----------------------------------------------------------

export const TASK_TYPES = [
  'feature',
  'bugfix',
  'ui',
  'auth',
  'billing',
  'database',
  'api',
  'dependency',
  'security',
  'devops',
  'refactor',
  'test',
  'docs',
  'release',
  'chore',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

// --- Project graph primitives ----------------------------------------------

export const FRAMEWORKS = [
  'nextjs',
  'react',
  'vite',
  'express',
  'node',
  'fastapi',
  'unknown',
] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const LANGUAGES = ['typescript', 'javascript', 'python', 'go', 'unknown'] as const;
export type Language = (typeof LANGUAGES)[number];

export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun', 'pip', 'poetry', 'unknown'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const FILE_KINDS = [
  'route',
  'page',
  'api',
  'component',
  'service',
  'auth',
  'billing',
  'middleware',
  'config',
  'test',
  'migration',
  'env',
  'lib',
  'style',
  'schema',
  'other',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

// --- Evidence primitives ----------------------------------------------------

export const EVIDENCE_STATUSES = ['verified', 'partial', 'refuted', 'unverified'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_KINDS = [
  'build',
  'test',
  'lint',
  'typecheck',
  'route',
  'file',
  'symbol',
  'import',
  'command',
  'env',
  'runtime',
  'migration',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

// --- Project graph (persisted to .cortex/graph.json) ------------------------

export interface DetectedStack {
  framework: Framework;
  language: Language;
  packageManager: PackageManager;
  frameworkVersion?: string;
  monorepo: boolean;
  deploymentTargets: string[];
}

export interface FileNode {
  /** repo-relative POSIX path */
  path: string;
  kind: FileKind;
  /** resolved repo-relative paths this file imports */
  imports: string[];
  /** repo-relative paths that import this file */
  importedBy: string[];
  /** top-level exported symbol names, best-effort */
  symbols: string[];
  /** true when the file touches a security/financial/structural surface */
  risky: boolean;
  tags: string[];
}

export interface RouteNode {
  /** e.g. "/dashboard", "/api/user" */
  routePath: string;
  file: string;
  kind: 'page' | 'api' | 'layout';
}

export interface EnvVar {
  name: string;
  usedIn: string[];
  documented: boolean;
}

export interface GraphStats {
  fileCount: number;
  routeCount: number;
  apiCount: number;
  testCount: number;
  riskyCount: number;
}

export interface ProjectGraph {
  schemaVersion: number;
  /** absolute repo root */
  root: string;
  generatedAt: string;
  stack: DetectedStack;
  files: FileNode[];
  routes: RouteNode[];
  envVars: EnvVar[];
  scripts: Record<string, string>;
  riskyFiles: string[];
  stats: GraphStats;
}

// --- Ledgers (persisted under .cortex/) -------------------------------------

export const MEMORY_TYPES = [
  'fact',
  'decision',
  'risk',
  'assumption',
  'constraint',
  'pattern',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface EvidenceRef {
  id: string;
  claim: string;
  status: EvidenceStatus;
}

export interface MemoryItem {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  /** 0..1 — unverified memory must never be treated as permanent truth */
  confidence: number;
  evidence: EvidenceRef[];
  relatedFiles: string[];
  relatedFeatures: string[];
  riskLevel: RiskLevel;
  expiry?: string;
  lastVerified?: string;
}

export const FEATURE_STATUSES = ['planned', 'building', 'shipped', 'deprecated'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface FeatureRecord {
  id: string;
  feature: string;
  status: FeatureStatus;
  builtAt?: string;
  updatedAt: string;
  purpose: string;
  userValue: string;
  routes: string[];
  components: string[];
  apiEndpoints: string[];
  databaseTables: string[];
  envVars: string[];
  dependencies: string[];
  protectedBehaviors: string[];
  acceptanceCriteria: string[];
  tests: string[];
  evidence: EvidenceRef[];
  knownRisks: string[];
  relatedDecisions: string[];
  regressionChecks: string[];
}

export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface DecisionRecord {
  id: string;
  decision: string;
  context: string;
  optionsConsidered: string[];
  chosenOption: string;
  reason: string;
  tradeoffs: string[];
  date: string;
  affectedFiles: string[];
  status: DecisionStatus;
  reviewDate?: string;
}

export interface EvidenceItem {
  id: string;
  claim: string;
  status: EvidenceStatus;
  kind: EvidenceKind;
  detail: string;
  command?: string;
  exitCode?: number;
  output?: string;
  createdAt: string;
}

// --- Config (.cortex/config.yaml) -------------------------------------------

export interface RiskPolicy {
  /** glob patterns whose edits are treated as high/critical risk */
  protectedPaths: string[];
  /** task-type -> minimum risk floor */
  floors: Partial<Record<TaskType, RiskLevel>>;
}

export interface GateConfig {
  typecheck: boolean;
  lint: boolean;
  build: boolean;
  test: boolean;
  /** block "done" when required evidence is missing */
  blockUnprovenDone: boolean;
}

export interface CortexCommands {
  typecheck?: string;
  lint?: string;
  build?: string;
  test?: string;
}

export interface CortexConfig {
  schemaVersion: number;
  mode: OperatingMode;
  privacy: PrivacyMode;
  risk: RiskPolicy;
  gates: GateConfig;
  /** stack pack ids to force-load in addition to auto-detected ones */
  stackPacks: string[];
  /** commands the gates use, overriding stack-pack defaults */
  commands: CortexCommands;
}

// --- Computed: risk classification ------------------------------------------

export interface RiskClassification {
  riskLevel: RiskLevel;
  taskType: TaskType;
  signals: string[];
  rationale: string;
}

// --- Computed: intent contract ---------------------------------------------

export interface IntentContract {
  goal: string;
  nonGoals: string[];
  taskType: TaskType;
  riskLevel: RiskLevel;
  affectedAreas: string[];
  requiredContext: string[];
  acceptanceCriteria: string[];
  regressionRisks: string[];
  implementationStages: string[];
  verificationPlan: string[];
  definitionOfDone: string[];
  assumptions: string[];
}

// --- Computed: context pack --------------------------------------------------

export interface ContextPack {
  depth: ContextDepth;
  tokenEstimate: number;
  relevantFiles: string[];
  relatedFeatures: string[];
  patterns: string[];
  constraints: string[];
  knownFailures: string[];
  forbiddenApproaches: string[];
  testsToRun: string[];
  /** compact markdown rendering suitable for injection into a host agent */
  markdown: string;
}

// --- Computed: blast radius --------------------------------------------------

export interface BlastRadius {
  changedFiles: string[];
  affectedRoutes: string[];
  affectedComponents: string[];
  affectedApi: string[];
  affectedTables: string[];
  affectsAuth: boolean;
  affectsBilling: boolean;
  affectedEnvVars: string[];
  affectedTests: string[];
  fragileAreas: string[];
  requiredChecks: string[];
  severity: RiskLevel;
}

// --- Computed: gates + ship report ------------------------------------------

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  evidenceId?: string;
}

export interface GateResult {
  gate: string;
  passed: boolean;
  checks: CheckResult[];
}

export const SHIP_STATUSES = ['READY', 'READY_WITH_WARNINGS', 'NOT_READY'] as const;
export type ShipStatus = (typeof SHIP_STATUSES)[number];

export interface ShipReport {
  status: ShipStatus;
  passed: CheckResult[];
  blocked: CheckResult[];
  warnings: string[];
  suggestedPrompt?: string;
  evidenceIds: string[];
  generatedAt: string;
}

// --- Stack packs ------------------------------------------------------------

export interface Rule {
  id: string;
  title: string;
  detail: string;
  severity: RiskLevel;
  appliesTo?: FileKind[];
}

export interface VersionCheck {
  pkg: string;
  /** semver range considered current/supported */
  supported: string;
  note: string;
}

export interface KnownFailure {
  id: string;
  signature: string;
  cause: string;
  fix: string;
}

export interface StackPack {
  id: string;
  name: string;
  /** true when this pack applies to the detected stack */
  matches: (stack: DetectedStack) => boolean;
  bestPractices: Rule[];
  antiPatterns: Rule[];
  recommendedLibraries: string[];
  versionChecks: VersionCheck[];
  setupCommands: string[];
  testCommands: string[];
  qualityGates: string[];
  securityNotes: string[];
  deploymentNotes: string[];
  commonFailures: KnownFailure[];
}
