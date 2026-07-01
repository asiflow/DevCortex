// ============================================================================
// Runtime validation for persisted artifacts.
//
// Anything read back from disk (config.yaml, the ledgers, the cached graph) is
// untrusted input and must be validated at the boundary. These zod schemas are
// the validators; the interfaces in ./types are the canonical contract. The
// `assertSchemaMatchesType` block at the bottom is a compile-time guarantee
// that the two never drift apart.
// ============================================================================

import { z } from 'zod';
import type {
  CortexConfig,
  DecisionRecord,
  DetectedStack,
  EnvVar,
  EvidenceItem,
  EvidenceRef,
  FeatureRecord,
  FileNode,
  GraphStats,
  MemoryItem,
  ProjectGraph,
  RouteNode,
} from './types';
import {
  DECISION_STATUSES,
  EVIDENCE_KINDS,
  EVIDENCE_STATUSES,
  FEATURE_STATUSES,
  FILE_KINDS,
  FRAMEWORKS,
  LANGUAGES,
  MEMORY_TYPES,
  OPERATING_MODES,
  PACKAGE_MANAGERS,
  PRIVACY_MODES,
  RISK_LEVELS,
  TASK_TYPES,
} from './types';

// --- enums ------------------------------------------------------------------

export const RiskLevelSchema = z.enum(RISK_LEVELS);
export const OperatingModeSchema = z.enum(OPERATING_MODES);
export const PrivacyModeSchema = z.enum(PRIVACY_MODES);
export const TaskTypeSchema = z.enum(TASK_TYPES);
export const FrameworkSchema = z.enum(FRAMEWORKS);
export const LanguageSchema = z.enum(LANGUAGES);
export const PackageManagerSchema = z.enum(PACKAGE_MANAGERS);
export const FileKindSchema = z.enum(FILE_KINDS);
export const EvidenceStatusSchema = z.enum(EVIDENCE_STATUSES);
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export const FeatureStatusSchema = z.enum(FEATURE_STATUSES);
export const DecisionStatusSchema = z.enum(DECISION_STATUSES);

// --- project graph ----------------------------------------------------------

export const DetectedStackSchema = z.object({
  framework: FrameworkSchema,
  language: LanguageSchema,
  packageManager: PackageManagerSchema,
  frameworkVersion: z.string().optional(),
  monorepo: z.boolean(),
  deploymentTargets: z.array(z.string()),
});

export const FileNodeSchema = z.object({
  path: z.string(),
  kind: FileKindSchema,
  imports: z.array(z.string()),
  importedBy: z.array(z.string()),
  symbols: z.array(z.string()),
  risky: z.boolean(),
  tags: z.array(z.string()),
});

export const RouteNodeSchema = z.object({
  routePath: z.string(),
  file: z.string(),
  kind: z.enum(['page', 'api', 'layout']),
});

export const EnvVarSchema = z.object({
  name: z.string(),
  usedIn: z.array(z.string()),
  documented: z.boolean(),
});

export const GraphStatsSchema = z.object({
  fileCount: z.number(),
  routeCount: z.number(),
  apiCount: z.number(),
  testCount: z.number(),
  riskyCount: z.number(),
});

export const ProjectGraphSchema = z.object({
  schemaVersion: z.number(),
  root: z.string(),
  generatedAt: z.string(),
  stack: DetectedStackSchema,
  files: z.array(FileNodeSchema),
  routes: z.array(RouteNodeSchema),
  envVars: z.array(EnvVarSchema),
  scripts: z.record(z.string(), z.string()),
  riskyFiles: z.array(z.string()),
  stats: GraphStatsSchema,
});

// --- evidence + ledgers -----------------------------------------------------

export const EvidenceRefSchema = z.object({
  id: z.string(),
  claim: z.string(),
  status: EvidenceStatusSchema,
});

export const EvidenceItemSchema = z.object({
  id: z.string(),
  claim: z.string(),
  status: EvidenceStatusSchema,
  kind: EvidenceKindSchema,
  detail: z.string(),
  command: z.string().optional(),
  exitCode: z.number().optional(),
  output: z.string().optional(),
  createdAt: z.string(),
});

export const MemoryItemSchema = z.object({
  id: z.string(),
  type: MemoryTypeSchema,
  title: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceRefSchema),
  relatedFiles: z.array(z.string()),
  relatedFeatures: z.array(z.string()),
  riskLevel: RiskLevelSchema,
  expiry: z.string().optional(),
  lastVerified: z.string().optional(),
});

export const FeatureRecordSchema = z.object({
  id: z.string(),
  feature: z.string(),
  status: FeatureStatusSchema,
  builtAt: z.string().optional(),
  updatedAt: z.string(),
  purpose: z.string(),
  userValue: z.string(),
  routes: z.array(z.string()),
  components: z.array(z.string()),
  apiEndpoints: z.array(z.string()),
  databaseTables: z.array(z.string()),
  envVars: z.array(z.string()),
  dependencies: z.array(z.string()),
  protectedBehaviors: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  tests: z.array(z.string()),
  evidence: z.array(EvidenceRefSchema),
  knownRisks: z.array(z.string()),
  relatedDecisions: z.array(z.string()),
  regressionChecks: z.array(z.string()),
});

export const DecisionRecordSchema = z.object({
  id: z.string(),
  decision: z.string(),
  context: z.string(),
  optionsConsidered: z.array(z.string()),
  chosenOption: z.string(),
  reason: z.string(),
  tradeoffs: z.array(z.string()),
  date: z.string(),
  affectedFiles: z.array(z.string()),
  status: DecisionStatusSchema,
  reviewDate: z.string().optional(),
});

// --- config -----------------------------------------------------------------

export const RiskPolicySchema = z.object({
  protectedPaths: z.array(z.string()),
  floors: z.record(TaskTypeSchema, RiskLevelSchema),
});

export const GateConfigSchema = z.object({
  typecheck: z.boolean(),
  lint: z.boolean(),
  build: z.boolean(),
  test: z.boolean(),
  blockUnprovenDone: z.boolean(),
});

export const CortexCommandsSchema = z.object({
  typecheck: z.string().optional(),
  lint: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
});

export const CortexConfigSchema = z.object({
  schemaVersion: z.number(),
  mode: OperatingModeSchema,
  privacy: PrivacyModeSchema,
  risk: RiskPolicySchema,
  gates: GateConfigSchema,
  stackPacks: z.array(z.string()),
  commands: CortexCommandsSchema,
});

// --- compile-time drift guard -----------------------------------------------
// If a schema and its interface ever diverge (a field is added, renamed, or
// retyped on one side only), one of these assertions stops compiling — turning
// a silent runtime mismatch into a build error. Mutual assignability is used
// rather than strict identity so zod's optional-field representation does not
// produce pedantic false positives.

type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : false) : false;

function assertMatch<_T extends true>(): void {
  /* compile-time only */
}

assertMatch<MutuallyAssignable<z.infer<typeof DetectedStackSchema>, DetectedStack>>();
assertMatch<MutuallyAssignable<z.infer<typeof FileNodeSchema>, FileNode>>();
assertMatch<MutuallyAssignable<z.infer<typeof RouteNodeSchema>, RouteNode>>();
assertMatch<MutuallyAssignable<z.infer<typeof EnvVarSchema>, EnvVar>>();
assertMatch<MutuallyAssignable<z.infer<typeof GraphStatsSchema>, GraphStats>>();
assertMatch<MutuallyAssignable<z.infer<typeof ProjectGraphSchema>, ProjectGraph>>();
assertMatch<MutuallyAssignable<z.infer<typeof EvidenceRefSchema>, EvidenceRef>>();
assertMatch<MutuallyAssignable<z.infer<typeof EvidenceItemSchema>, EvidenceItem>>();
assertMatch<MutuallyAssignable<z.infer<typeof MemoryItemSchema>, MemoryItem>>();
assertMatch<MutuallyAssignable<z.infer<typeof FeatureRecordSchema>, FeatureRecord>>();
assertMatch<MutuallyAssignable<z.infer<typeof DecisionRecordSchema>, DecisionRecord>>();
assertMatch<MutuallyAssignable<z.infer<typeof CortexConfigSchema>, CortexConfig>>();
