# Setup & integrations

DevCortex works alongside the AI coding agent you already use. Setup is two steps:
initialize it in your project, then wire it into your agent (one command per host).

---

## 1. In your project

Install the CLI (this puts the `devcortex` command on your `PATH`), then from your
repository root:

```bash
npm install -g @asiflow/devcortex
devcortex init
```

This scans the repo and creates a `.cortex/` **project brain** — the project graph
plus memory, feature, decision, and evidence ledgers — and a `.cortex/config.yaml`
you can tune. Pick an operating **mode**:

| Mode | Behavior |
|---|---|
| `passive` (default) | Observes and reports. Nothing is ever blocked. |
| `guarded` | Blocks edits to `protectedPaths` (auth, billing, `.env*`, migrations) *with an explanation*, and blocks unproven "done." |
| `autopilot` | Guarded, plus applies low-risk fixes automatically. |

Then the core loop:

```bash
devcortex preflight "add subscription billing"   # risk + blast radius + context, before you edit
devcortex ship                                   # evidence-backed ship report; exit 2 on NOT_READY
```

> Commit `.cortex/` to share the project brain with your team. Add `.cortex/cache/`
> to `.gitignore` (it's machine-local).

---

## 2. In your AI coding agent

One command wires DevCortex into a host. Each is idempotent and reversible
(re-run with `--force` to regenerate; delete the generated files/blocks to remove).

```bash
devcortex install claude     # Claude Code
devcortex install codex      # Codex CLI
devcortex install cursor     # Cursor
devcortex install vscode     # VS Code agent mode
devcortex install github     # GitHub Actions PR checks
devcortex install --all      # everything at once
```

### Claude Code

```bash
devcortex install claude
```

Writes `.claude/settings.json` (lifecycle hooks) + `.mcp.json` (the MCP server) +
`.claude/hooks/*.sh`. The hooks make the loop automatic:

| Claude Code event | Hook | What it does |
|---|---|---|
| `UserPromptSubmit` | `devcortex-preflight.sh` | Injects blast radius + context for the task before the agent starts. |
| `PreToolUse` (Edit/Write/Bash) | `devcortex-guard.sh` | Blocks edits to protected paths in guarded mode, with an explanation. |
| `PostToolUse` (Edit/Write/Bash) | `devcortex-postuse.sh` | Records evidence of the action to the ledger. |
| `Stop` | `devcortex-ship.sh` | Runs the ship gate so the agent can't stop on an unproven "done." |

### Codex CLI

```bash
devcortex install codex
```

Writes `AGENTS.md` (the DevCortex discipline Codex reads on every task) and
`.codex/config.toml` (registers the `devcortex-mcp` MCP server, so Codex can call
DevCortex tools). Both use a managed `DEVCORTEX:BEGIN … DEVCORTEX:END` block, so
your own content around them is preserved.

### Cursor

```bash
devcortex install cursor
```

Writes `.cursor/mcp.json` (the MCP server) and `.cursor/rules/devcortex.mdc` — a
Cursor rule with `alwaysApply: true` that tells the agent to preflight before risky
edits, honor protected paths, and gate "done" on evidence.

### VS Code (agent mode)

```bash
devcortex install vscode
```

Writes `.vscode/mcp.json` (the MCP server), `.vscode/settings.json`, and
`.vscode/tasks.json` (DevCortex: Init / Scan / Preflight / Verify / Ship as tasks).

### GitHub Actions (PR checks)

```bash
devcortex install github
```

Writes `.github/workflows/devcortex.yml` and a composite
`.github/actions/devcortex-ship-check/action.yml` that enforce the DevCortex gate on
pull requests. Add `@asiflow/devcortex` as a devDependency so `npx devcortex` resolves
in CI:

```bash
npm install --save-dev @asiflow/devcortex     # (or pnpm add -D @asiflow/devcortex)
```

---

## 3. Any MCP client

DevCortex ships a stdio MCP server (`devcortex-mcp`) that exposes the engine as
`cortex.*` tools (preflight, context, blast radius, protected-path policy, evidence,
ship gate). Register it in your client's MCP config:

```json
{
  "mcpServers": {
    "devcortex-mcp": {
      "command": "npx",
      "args": ["-y", "@asiflow/devcortex-mcp"]
    }
  }
}
```

The server resolves the repo root from `--root <dir>`, then `DEVCORTEX_ROOT`, then
the current working directory — so no path config is needed in the common case.
(`devcortex install` writes the equivalent config using the `devcortex-mcp` binary;
see below.)

**Getting the `devcortex-mcp` server.** It ships as the **`@asiflow/devcortex-mcp`**
npm package — self-contained, no build step. The `npx` config above needs nothing
installed. If you'd rather have the `devcortex-mcp` binary on your `PATH` (which is
what `devcortex install` writes into `.mcp.json` / `.codex/config.toml`), install it
globally:

```bash
npm install -g @asiflow/devcortex-mcp
```

> Building from source instead? After `pnpm install && pnpm -r build`, point your
> client at `node /absolute/path/to/DevCortex/packages/mcp-server/dist/server.js
> --root /absolute/path/to/your/project`.

---

## Uninstalling

Every integration writes a clearly-marked, DevCortex-owned block or set of files.
To remove one, delete its generated files (`.claude/`, `.codex/config.toml`,
`.cursor/rules/devcortex.mdc`, `.vscode/*`, `.github/workflows/devcortex.yml`) or the
`DEVCORTEX:BEGIN … DEVCORTEX:END` block inside a shared file (`AGENTS.md`,
`.codex/config.toml`). Deleting `.cortex/` removes the project brain entirely.

---

## Host capability matrix

| Capability | Claude Code | Cursor | Codex | VS Code agent | GitHub Action |
|---|---|---|---|---|---|
| Context injection (brief/preflight) | ✅ SessionStart + UserPromptSubmit hooks | ✅ project rule | ✅ AGENTS.md block | ✅ instructions | — |
| MCP tools (`cortex.*`) | ✅ `.mcp.json` | ✅ `.cursor/mcp.json` | ✅ `config.toml` | ✅ | — |
| Blocking gates (guard / ship exit 2) | ✅ PreToolUse + Stop hooks | ⚠️ advisory only (no lifecycle hooks) | ⚠️ advisory only | ⚠️ advisory only | ✅ required PR checks |
| Transcript distillation (auto-memory) | ✅ Stop hook | — | — | — | — |

DevCortex never overclaims: where a host has no lifecycle hooks, gates are advisory (the agent is instructed to run them) and CI remains the enforcement backstop.

### Ship-status badge

The generated workflow's `ship-check` job doubles as a README badge:
`![DevCortex ship](https://github.com/<owner>/<repo>/actions/workflows/devcortex.yml/badge.svg)`
