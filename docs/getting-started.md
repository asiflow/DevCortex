# Getting started with DevCortex

DevCortex is a **local-first, tokenless cognition layer** for AI coding agents. It
gives any repo a persistent brain (`remember`), warns before risky changes
(`protect`), and refuses to let an agent claim "done" without proof (`verify` →
`ship`).

This guide walks the complete, verified loop against the bundled
`fixtures/sample-next-app` fixture: **build → init → scan → preflight → verify →
ship**, plus the MCP server and the Claude Code integration.

Every command below has been run end-to-end; the output excerpts are real.

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | `>= 20` | tested on v20.17.0 |
| pnpm | `10.x` | the repo pins `pnpm@10.33.0` via `packageManager` |

```bash
node --version   # v20.x or newer
pnpm --version   # 10.x
```

---

## 2. Install dependencies and build

DevCortex is a pnpm + turborepo monorepo. Build all packages in topological
order (`@devcortex/core` → `@devcortex/mcp-server` + `@devcortex/claude-code` →
`devcortex` CLI):

```bash
pnpm install
pnpm -r build
```

Expected: all four workspace packages build successfully, producing `dist/` in
each. The CLI binary is emitted to `apps/cli/dist/cli.js` and the MCP server to
`packages/mcp-server/dist/server.js`.

Run the test suite and linter to confirm a clean tree:

```bash
pnpm -r test    # 322 tests across core / cli / mcp-server / claude-code
pnpm lint       # turbo lint across all packages
```

### Invoking the CLI

The published binary name is **`devcortex`** (and **`devcortex-mcp`** for the
server). Until you install the package globally, run the built CLI directly:

```bash
# From the repo root, against the current directory:
node ./apps/cli/dist/cli.js --version      # -> 0.1.0

# Against any target repo with --cwd:
node ./apps/cli/dist/cli.js doctor --cwd /path/to/your/repo
```

> The examples below use `node ./apps/cli/dist/cli.js`. If you `npm install -g`
> the built `apps/cli` package (or publish it), the same commands become plain
> `devcortex …`.

Global flags available on every command:

- `--cwd <dir>` — run as if invoked from `<dir>`.
- `--json` — emit machine-readable JSON (used by the Claude Code hooks).

Exit codes (so CI and agent hooks can gate):

| Code | Meaning |
|---|---|
| `0` | OK |
| `1` | internal error (rendered as a clean message, never a raw stack) |
| `2` | ship/verify reports **NOT_READY** |

---

## 3. The cognition loop (live, against the fixture)

Copy the bundled fixture to a scratch directory so you don't mutate the repo:

```bash
DEMO=$(mktemp -d)
cp -R fixtures/sample-next-app/. "$DEMO/"
CLI="$PWD/apps/cli/dist/cli.js"
```

### 3.1 `init` — create the `.cortex/` workspace

```bash
node "$CLI" init --cwd "$DEMO"
```

`init` does a **passive** scan and writes the project brain:

```
CORTEX INIT
────────────────────────────────────────────────────────
Stack        nextjs 15.3.0 · typescript · unknown
Files        12 scanned

Created (12)
  • .cortex/config.yaml
  • .cortex/project.md
  • .cortex/architecture.md
  • .cortex/quality-constitution.md
  • .cortex/graph.json
  • .cortex/memory  · features · decisions · evidence · ship-reports · runs · cache
```

### 3.2 `scan` — refresh the cached project graph

```bash
node "$CLI" scan --cwd "$DEMO"
```

```
CORTEX SCAN
────────────────────────────────────────────────────────
Stack        nextjs 15.3.0 · typescript · unknown
Files        12
Routes       4 (1 api)
Tests        0
Risky        6
Env vars     4
Scripts      dev, build, start, lint, typecheck
```

### 3.3 `preflight` — compile risk + blast radius + intent + context

```bash
node "$CLI" preflight "add subscription billing" --cwd "$DEMO"
```

Preflight classifies the task, projects its blast radius onto the existing graph,
and emits a definition-of-done plus a compressed, stack-aware context pack:

```
CORTEX PREFLIGHT
────────────────────────────────────────────────────────
Task         add subscription billing
Type · Risk  billing · HIGH
Signals      keyword: payment/billing flow
Goal         add subscription billing

Blast radius  severity LOW
  routes — · components — · api — · tables — · auth — · billing — · env vars —

Definition of done
  • `npm run typecheck` passes.
  • `npm run lint` passes.
  • `npm run build` succeeds.
  • `test` is green.
  • Evidence is recorded for each required check (unproven "done" is blocked).

Acceptance criteria
  • Typecheck / Lint / Production build / Tests all pass.

Context pack  deep · ~1013 tok
## DevCortex context — billing · high risk · deep
### Do NOT  (e.g. never prefix a secret with NEXT_PUBLIC_, verify Stripe webhooks against the raw body…)
### Constraints / Patterns to follow / Tests to run …
```

**Why is risk HIGH but the blast radius LOW?** They measure different things, on
purpose:

- **Risk** is the inherent danger of the task *type* — "billing" floors to HIGH.
- **Blast radius** is what *existing* code the task touches. `add subscription
  billing` is net-new for this fixture (no billing files exist yet), so there is
  no existing surface to break. DevCortex is **tokenless and never fabricates** a
  surface it cannot prove from the graph — an honest empty radius beats a guessed
  one.

When you point the same analysis at files that *do* exist, the radius fills in.
For example, changing `lib/auth.ts` + `middleware.ts` yields `severity=high`,
`affectsAuth=true`, and required checks including an auth regression test (see the
MCP example in §4).

Use `--json` to feed preflight into tooling:

```bash
node "$CLI" preflight "add subscription billing" --cwd "$DEMO" --json
# -> { risk:{riskLevel:"high",taskType:"billing"}, blastRadius:{…}, intent:{…}, context:{…} }
```

### 3.4 `verify` — run the real quality gate

```bash
node "$CLI" verify --cwd "$DEMO"
```

`verify` runs the project's own `typecheck` / `lint` / `build` scripts plus
deterministic route and env checks, and records evidence for each:

```
CORTEX VERIFY
────────────────────────────────────────────────────────
Gate         quality
Result       FAIL

Checks (11)
  ✗ typecheck — Command exited with code 127
  ✗ lint — Command exited with code 127
  ✗ build — Command exited with code 127
  ✓ route:/ · /api/user · /dashboard  — all resolve to real files
  ✓ env:DATABASE_URL · NEXT_PUBLIC_APP_URL · SESSION_SECRET — documented
  ✗ env:SESSION_MAX_AGE — used in 1 file(s) but not documented
```

> The fixture is committed **test data and is intentionally never `npm install`ed**,
> so `typecheck` / `lint` / `build` exit `127` (command not found). That is a
> faithful result — the deterministic route/env checks still pass. In a real repo
> with dependencies installed, these gates run your actual scripts. `verify`
> returns exit code **2** when the gate does not fully pass.

### 3.5 `ship` — evidence-backed ship report

```bash
node "$CLI" ship --cwd "$DEMO"
```

```
CORTEX SHIP STATUS
────────────────────────────────────────────────────────
Status       NOT_READY

Passed (7)   route + env checks …
Blocked (3)  typecheck / lint / build (required) …
Warnings (2) undocumented env var; test gate enabled but unconfigured

Unproven "done" is blocked
  ✗ Ship status is NOT_READY — required checks have not all passed.

Report       .cortex/ship-reports/2026-…-….md
```

`ship` writes a durable, fully evidence-backed markdown report under
`.cortex/ship-reports/`. Every check links to an immutable evidence item
(`[verified]` / `[refuted]`) recording the exact command, exit code, file, or env
var. It returns exit code **2** when `NOT_READY`, so a `Stop` hook or CI step can
block the agent from claiming "done". When every required check passes, status
becomes `READY` (or `READY_WITH_WARNINGS`) and the exit code is `0`.

---

## 4. MCP server

`@devcortex/mcp-server` exposes the engine to any MCP client over stdio as 19
`cortex.*` tools. The target repo root is resolved from `--root <dir>`, then the
`DEVCORTEX_ROOT` env var, then the current directory.

```bash
# Run directly (stdio transport — a client speaks JSON-RPC over stdin/stdout):
node ./packages/mcp-server/dist/server.js --root /path/to/your/repo
```

Tools mirror the engine 1:1, e.g.:

- `cortex.classify_task_risk`, `cortex.compile_intent`, `cortex.compile_context`
- `cortex.analyze_blast_radius`, `cortex.run_quality_gate`, `cortex.generate_ship_report`
- `cortex.verify_file` / `verify_route` / `verify_symbol` / `verify_import` / `verify_command` / `verify_build`
- `cortex.get_project_brief` / `get_architecture_map` / `get_quality_constitution` / `get_feature_ledger`
- `cortex.update_memory`, `cortex.record_evidence`, `cortex.block_unproven_done`

Smoke-test with the official SDK client (`@modelcontextprotocol/sdk`):

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['packages/mcp-server/dist/server.js', '--root', process.cwd()],
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();          // 19 cortex.* tools

const risk = await client.callTool({
  name: 'cortex.classify_task_risk',
  arguments: { task: 'add subscription billing' },
});
// -> { riskLevel: "high", taskType: "billing", signals: [...] }

const blast = await client.callTool({
  name: 'cortex.analyze_blast_radius',
  arguments: { changedFiles: ['lib/auth.ts', 'middleware.ts'] },
});
// -> { severity: "high", affectsAuth: true, requiredChecks: ["auth regression test", ...] }

await client.close();
```

A tool that hits an internal error returns a structured `isError` result carrying
the stable error `code` + message rather than crashing the transport, so a host
agent can reason about and degrade past the failure.

---

## 5. Claude Code integration

Wire DevCortex into Claude Code's lifecycle in one command:

```bash
node "$CLI" install claude --cwd /path/to/your/repo
```

This writes (idempotently; pass `-f`/`--force` to overwrite):

- `.claude/settings.json` — registers four lifecycle hooks.
- `.mcp.json` — registers the `devcortex-mcp` server for the project.
- `.claude/hooks/devcortex-{preflight,guard,postuse,ship}.sh`.

The hooks turn the loop on automatically:

| Hook | Trigger | Effect |
|---|---|---|
| `UserPromptSubmit` | every prompt | inject `preflight --json` (risk + blast radius + context) |
| `PreToolUse` (Edit/Write/Bash) | before a risky edit | guarded-mode protected-path check |
| `PostToolUse` (Edit/Write/Bash) | after an edit | record evidence + graph delta |
| `Stop` | end of turn | `ship --json`; block unproven "done" when `gates.blockUnprovenDone` |

For the `devcortex-mcp` command in `.mcp.json` to resolve, install the server
binary on your `PATH` (global install/publish) or edit `.mcp.json` to point at
`node /abs/path/to/packages/mcp-server/dist/server.js`.

---

## 6. Security & trust model

DevCortex reads files and **runs commands inside the target repo** (`--cwd` /
`--root`). Treat it like any tool with shell access to that repo, and keep these
boundaries in mind:

- **Only run DevCortex on repositories you trust.** `verify` / `ship` (§3.4–3.5)
  run the *target repo's own configured commands* — the `typecheck` / `lint` /
  `build` / `test` scripts from its `package.json` (or `config.commands`). The
  `cortex.verify_command` MCP tool (§4) runs *caller-supplied* shell strings in
  the target root. Both spawn real processes with a clamped timeout, so a hostile
  repo's scripts — or a hostile command — execute as code on your machine.
- **The verifiers are read-only and root-contained.** `verify_file` /
  `verify_route` / `verify_symbol` / `verify_import` never write anything, and any
  path that escapes the project root (a `../` traversal or an absolute path
  outside the root) is *refused without ever being read* — pointing a verifier at
  `../../../../etc/passwd` comes back refused, not "verified".
- **Guarded mode protects your `protectedPaths`.** In `guarded` mode the
  `PreToolUse` hook (§5) blocks edits to high-risk or
  `config.risk.protectedPaths`-matched files (e.g. `**/auth/**`, `middleware.ts`,
  `.env*`, migrations) — always *with an explanation of what risk and how to
  override*, never a silent failure. `passive` mode (the default) only observes
  and records; it never blocks normal work.

---

## 7. Workspace layout (`.cortex/`)

`init` creates a self-contained project brain you can commit:

```
.cortex/
  config.yaml              # mode, privacy, gates, risk floors, gate commands
  project.md               # generated project brief
  architecture.md          # generated architecture map
  quality-constitution.md  # generated do/don't + gates for this stack
  graph.json               # cached project graph (files, routes, env, imports)
  memory/   features/   decisions/   evidence/   ship-reports/   runs/   cache/
```

Inspect health any time with `doctor`:

```bash
node "$CLI" doctor --cwd /path/to/your/repo
# ✓ node · ✓ workspace · ✓ mode · gates · ✓ graph · ✓ stack · ✓ stack-packs
```

---

## 8. Command reference

| Command | What it does |
|---|---|
| `init [-f]` | scan the repo and create `.cortex/` |
| `doctor` | diagnose workspace, graph cache, stack, gates |
| `scan` | re-scan and refresh the cached project graph |
| `preflight "<task>"` | compile risk + blast radius + intent + context |
| `context ["<task>"] [--level tiny\|standard\|deep]` | compile the minimum-complete context pack |
| `verify` | run the quality gate (typecheck/lint/build/test + route/env checks) |
| `ship` | generate the evidence-backed ship report (exit 2 when NOT_READY) |
| `memory <add\|list\|get>` | project memory ledger |
| `feature <add\|list\|get>` | project feature ledger |
| `install claude [-f]` | install the Claude Code hooks + MCP registration |

Add `--json` to any command for machine-readable output, and `--cwd <dir>` to run
against another directory.
