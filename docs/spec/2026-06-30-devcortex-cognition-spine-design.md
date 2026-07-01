# DevCortex Core — Cognition Spine (Design Spec)

**Status:** approved · **Date:** 2026-06-30 · **Sub-project:** #1 of the DevCortex program
**Runtime:** TypeScript / Node 20+ · pnpm + turborepo · **License:** Apache-2.0
**Runtime architecture:** Approach A — stateless `@devcortex/core` library + thin CLI + stdio MCP + Claude Code hooks (no long-running daemon in this slice; the daemon is a later additive optimization that simply becomes another caller of `core`).

---

## 1. What this slice is

The Cognition Spine is the complete **local, tokenless** `remember → protect → verify → ship` loop. It is a genuinely useful, OSS-publishable tool on its own and the foundation every later sub-project (stack-pack library, skill engine, premium brain, dashboards, other integrations) layers onto.

**Out of scope for this slice (later sub-projects):** persistent daemon, Codex/Cursor/VS Code adapters, GitHub Action, DevOps/Security/Premium-UI deep gates, research engine, skill engine, MCP-manager/firewall, cloud/premium brain, dashboards.

## 2. Philosophy (binding)

- **Tokenless by default** — value comes from local deterministic analysis, not LLM calls.
- **Compressed context, not giant reports** — return tiny, actionable instructions.
- **Passive first** — default mode observes/records/suggests; never blocks normal work.
- **Risk-based depth** — low-risk tasks stay light; high-risk tasks trigger deeper analysis.
- **Evidence over opinions** — every claim resolves to verified/partial/refuted/unverified.
- **Never block without explanation** — what risk, what evidence, what could break, how to fix, how to override.
- **Fail-safe** — any internal error in a host hook degrades to passive; DevCortex never breaks the user's agent.

## 3. Repository layout

```
devcortex/
  apps/cli/                  # `devcortex` binary (commander) — thin over core
  packages/core/             # @devcortex/core — the engine (modules below)
  packages/mcp-server/       # @devcortex/mcp-server — stdio MCP, cortex.* tools
  integrations/claude-code/  # @devcortex/claude-code — hooks + `install claude`
  fixtures/sample-next-app/  # a real tiny Next.js-shaped repo for E2E truth
  docs/spec/                 # this document
```

### `@devcortex/core` modules

| Module | Responsibility |
|---|---|
| `domain/` | Shared types (`types.ts`), error hierarchy (`errors.ts`), zod validators (`schemas.ts`). **Frozen — do not change without updating both.** |
| `workspace/` | Owns `.cortex/`: path resolution, init, typed read/write of config + cached graph. |
| `graph/` | Scans a repo into a `ProjectGraph` (stack detection, file classification, import graph, routes, env, scripts, risky files). |
| `ledgers/` | File-backed, schema-validated CRUD: `MemoryLedger`, `FeatureLedger`, `DecisionLedger`, `EvidenceLedger`. |
| `policy/` | Modes + risk classification + protected-path checks + risk→depth mapping. |
| `stackpacks/` | `StackPack` registry + the Next.js/TypeScript reference pack. |
| `blast-radius/` | Changed-files → affected surfaces + required checks. |
| `compilers/` | `compileIntent` (task → engineering contract) + `compileContext` (minimum context pack). |
| `evidence/` | Claim verifiers + `blockUnprovenDone`. |
| `gates/` | Runs real typecheck/lint/build/test + route/env checks → `GateResult` + `ShipReport`. |

**Conventions:** ESM only · relative imports omit extensions (`moduleResolution: "Bundler"`) · `tsc` strict (incl. `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) · all I/O via `node:fs/promises` · all thrown errors are `DevCortexError` subclasses · vitest with `globals: true`.

## 4. Module public API contracts (what each Wave-1 agent implements)

> Types referenced below come from `@devcortex/core` `domain/types.ts`. Each module's `index.ts` already documents its required exports; this section is authoritative.

**workspace/**
```ts
interface WorkspacePaths { root; cortexDir; config; projectMd; architectureMd;
  qualityConstitution; graph; memoryDir; featuresDir; decisionsDir; evidenceDir;
  shipReportsDir; runsDir; cacheDir; }
function workspacePaths(root: string): WorkspacePaths
function isInitialized(root: string): Promise<boolean>
function defaultConfig(stack?: DetectedStack): CortexConfig
function initWorkspace(root: string, opts: { mode: OperatingMode; stack: DetectedStack; force?: boolean })
  : Promise<{ created: string[] }>           // throws WorkspaceError('WORKSPACE_EXISTS') unless force
function loadConfig(root: string): Promise<CortexConfig>   // zod-validated; ConfigError on invalid
function saveConfig(root: string, config: CortexConfig): Promise<void>
function loadGraph(root: string): Promise<ProjectGraph | null>
function saveGraph(root: string, graph: ProjectGraph): Promise<void>
```

**graph/**
```ts
interface ScanOptions { ignore?: string[]; maxFiles?: number }
function scanProject(root: string, opts?: ScanOptions): Promise<ProjectGraph>
function relevantFiles(graph: ProjectGraph, task: string): FileNode[]
function dependentsOf(graph: ProjectGraph, file: string): string[]   // transitive importedBy
```
Detection: `package.json` (framework/pm/scripts/deps), Next.js App Router (`app/**/page.tsx`, `route.ts`) + Pages Router, `middleware.ts`, env via `process.env.X` scan, file kinds by path + content heuristics, imports via `es-module-lexer` with tsconfig-path resolution best-effort. Risky = auth/billing/middleware/migration/env/config/security files.

**ledgers/** — four classes, each `new XLedger(root)`, persisting one JSON file per entry under the matching `.cortex/` subdir (id-named). Common methods: `add(input): Promise<T>` (generates id + timestamps), `get(id)`, `list(filter?)`, `update(id, patch)`, `all()`. `EvidenceLedger` is append-only (no update). Validate every read with the zod schema; `LedgerError` on corruption.

**policy/**
```ts
function classifyRisk(task: string, graph: ProjectGraph, config: CortexConfig): RiskClassification
function isProtected(path: string, config: CortexConfig): boolean        // glob match protectedPaths
function depthForRisk(risk: RiskLevel): ContextDepth                      // low/med→tiny/standard, high/critical→deep
function shouldBlock(mode: OperatingMode, risk: RiskLevel): boolean       // passive=never; guarded=high|critical; autopilot=critical
```
Risk signals: keyword + affected-file analysis (auth/billing/migration/secret/deploy → high/critical), honoring `config.risk.floors`.

**stackpacks/**
```ts
const nextjsPack: StackPack          // real 2026 guidance: App Router, server actions, RSC, env safety, no client secret leak
const allPacks: StackPack[]
function matchPacks(stack: DetectedStack): StackPack[]
```

**blast-radius/**
```ts
function analyzeBlastRadius(graph: ProjectGraph, changedFiles: string[], config: CortexConfig): BlastRadius
```
Walks `dependentsOf` for each changed file; maps to routes/components/api/tables; flags auth/billing; derives `requiredChecks` and a `severity`.

**compilers/**
```ts
function compileIntent(task: string, graph: ProjectGraph, packs: StackPack[], config: CortexConfig): IntentContract
function compileContext(intent: IntentContract, graph: ProjectGraph,
  ledgers: { memory: MemoryLedger; feature: FeatureLedger; decision: DecisionLedger },
  depth: ContextDepth): Promise<ContextPack>
```
`ContextPack.markdown` is the compact injectable block; respect token budgets (tiny 300–800, standard 1k–2.5k, deep for high-risk). `tokenEstimate` ≈ chars/4.

**evidence/** — verifiers return `EvidenceItem` (never throw on a "false" result; throw only on internal error). `verifyCommandResult` uses `node:child_process` with a timeout and captures exit code + truncated output. `blockUnprovenDone(report)` → `{ blocked, reasons }`.

**gates/**
```ts
function runQualityGate(root, config, graph): Promise<{ result: GateResult; evidence: EvidenceItem[] }>
function generateShipReport(root, config, graph, ledgers): Promise<ShipReport>
```
Runs configured commands (`config.commands` overriding stack-pack defaults), plus route-exists/env-documented checks. `ShipStatus`: NOT_READY if any required check failed; READY_WITH_WARNINGS if all required pass but soft warnings exist; READY otherwise. Always attach a `suggestedPrompt` when not READY.

## 5. `.cortex/` workspace

```
.cortex/
  config.yaml            # CortexConfig (yaml)
  project.md             # generated project brief
  architecture.md        # generated architecture map
  quality-constitution.md
  graph.json             # cached ProjectGraph (zod-validated on read)
  memory/<id>.json
  features/<id>.json
  decisions/<id>.json
  evidence/<id>.json
  ship-reports/<timestamp>.md
  runs/                  # reserved (flight recorder — later)
  cache/                 # gitignored
```
`init` writes `config.yaml`, the three markdown docs, `graph.json`, and the empty ledger dirs. It **asks before overwriting** `CLAUDE.md`/`AGENTS.md`/`.mcp.json`/`.claude/settings.json` in the target repo.

## 6. CLI surface (`apps/cli`)

`devcortex <command>` via `commander`. Commands: `init` · `doctor` · `scan` · `preflight "<task>"` · `context [--level tiny|standard|deep]` · `verify` · `ship` · `memory <add|list|get>` · `feature <add|list|get>` · `install claude`. Global `--json` for machine output (hooks use this), `--cwd <dir>`. Human output is concise and uses the CORTEX PREFLIGHT / CORTEX SHIP STATUS formats from the product spec. Exit codes: `0` ok, `1` internal error, `2` ship NOT_READY (so CI/hooks can gate).

## 7. MCP server (`packages/mcp-server`)

stdio server using `@modelcontextprotocol/sdk`. Tools map 1:1 to core: `cortex.get_project_brief`, `compile_context`, `compile_intent`, `classify_task_risk`, `analyze_blast_radius`, `get_feature_ledger`, `get_architecture_map`, `get_quality_constitution`, `run_quality_gate`, `generate_ship_report`, `update_memory`, `record_evidence`, `verify_file`, `verify_route`, `verify_symbol`, `verify_import`, `verify_command`, `verify_build`, `block_unproven_done`. Each tool validates input with zod and returns structured JSON content. The server takes the target repo root from `DEVCORTEX_ROOT` env or `--root`.

## 8. Claude Code integration (`integrations/claude-code`)

`devcortex install claude` writes (with confirmation before overwrite):
- `.claude/settings.json` hooks: `UserPromptSubmit` → `devcortex preflight --json` (inject CORTEX PREFLIGHT), `PreToolUse` (Edit|Write|Bash) → guarded-mode protected-path check, `PostToolUse` → `record_evidence` + graph delta, `Stop` → `devcortex ship --json` (emit SHIP STATUS; block unproven done when `gates.blockUnprovenDone`).
- `.mcp.json` entry registering `devcortex-mcp`.
Hooks are thin shell shims that call the CLI and **fail open** (exit 0, no block) on any non-zero internal error.

## 9. Testing strategy

vitest. Per-module unit tests (graph detection on the fixture, risk classification table, intent/context compilation, blast-radius on a known import graph, ledger CRUD + schema-rejection, evidence verifiers, gate evidence). Integration: CLI commands against `fixtures/sample-next-app`. Contract: MCP tool I/O shapes. E2E: scripted `init → preflight "add subscription billing" → verify → ship` asserting real outputs + ledger writes. **Coverage ≥85% on `@devcortex/core`.** Real assertions only — no logic mocked away.

`fixtures/sample-next-app`: a minimal but real Next.js App Router project (a couple of pages, an API route, `middleware.ts` doing auth, a `lib/`, an `.env.example`, a `package.json`) — committed, never built, used purely as scan/gate target.

## 10. Definition of Done (reported with real command output)

1. `pnpm -r build` clean under `tsc` strict.
2. `pnpm -r test` green; ≥85% core coverage; real assertions.
3. `pnpm lint` clean.
4. Scripted demo against the fixture: `init`, `preflight "add subscription billing"`, `verify`, `ship` all produce real, evidence-backed output.
5. MCP server answers `tools/list` + a sample `cortex.*` call via a client harness.
6. `install claude` writes valid `.claude/settings.json` + `.mcp.json`; hooks invoke the CLI correctly.
7. LICENSE/README/getting-started/this spec committed; clean git history.
