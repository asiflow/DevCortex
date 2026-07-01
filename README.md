<div align="center">

# DevCortex

**Your AI agent said "done." DevCortex proves whether it actually shipped.**

Evidence-backed **ship reports**, an **evidence ledger** that blocks unproven "done,"
and persistent **project memory** — for Claude Code, Codex, Cursor, VS Code agent
mode, and any MCP client.

[![CI](https://github.com/asiflow/DevCortex/actions/workflows/ci.yml/badge.svg)](https://github.com/asiflow/DevCortex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/devcortex?color=00c853&label=npm)](https://www.npmjs.com/package/devcortex)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

</div>

---

## The problem, in one screen

AI coding agents generate impressive code — then hallucinate "done" without proof.
DevCortex runs the gate. Same command, before and after:

**Before** — the agent "fixed" the tax bug and declared it done:

```console
$ devcortex ship
CORTEX SHIP STATUS
────────────────────────────────────────────────────────
Status       NOT_READY

Blocked (1)
  ✗ test — Command exited with code 1

Unproven "done" is blocked
  ✗ Required check failed: test — Command exited with code 1
```

**After** — you fix the root cause and ship for real:

```console
$ devcortex ship
CORTEX SHIP STATUS
────────────────────────────────────────────────────────
Status       READY

Passed (1)
  ✓ test — Command exited 0
```

The difference is **evidence**. `devcortex ship` exits non-zero on `NOT_READY`, so it
drops straight into CI, pre-commit, and your agent's "am I done?" check.

> Run it yourself: `bash demo/demo.sh` (the exact NOT_READY → READY story above, live).

## What it does today

DevCortex is **not another AI coding agent**. It's a local-first cognitive layer on
top of the agent you already use. Three things, working now:

- **Ship reports with evidence.** `devcortex ship` runs your repo's *own* gates
  (typecheck / lint / build / test) plus route/env checks, and refuses to mark work
  "done" until every required check passes — with the proof attached.
- **Project memory.** A durable `.cortex/` brain (memory, feature, and decision
  ledgers) so your agent stops forgetting what it built, why, and what not to break.
- **Blast-radius protection.** `devcortex preflight "<task>"` shows what a change
  touches (auth, billing, routes, data) *before* you write it; guarded mode blocks
  edits to protected paths — with an explanation, never silently.

Everything runs **locally and tokenless-by-default**: the heavy analysis happens
*outside* your agent's context, so only a small, actionable instruction comes back
and it doesn't burn your tokens.

## Install

```bash
npx devcortex init                       # scan the repo, create .cortex/, pick a mode
devcortex preflight "add subscription billing"   # risk + blast radius + context, up front
devcortex ship                           # evidence-backed ship report (exit 2 when NOT_READY)
```

Wire it into your agent so the loop is automatic:

```bash
devcortex install claude   # Claude Code hooks + MCP: inject context, protect edits, gate "done"
```

DevCortex also exposes the engine to any MCP client (`@devcortex/mcp-server`, stdio)
as `cortex.*` tools, and ships adapters for Codex, Cursor, VS Code, and GitHub Actions.

## Try it from source

```bash
git clone https://github.com/asiflow/DevCortex && cd DevCortex
pnpm install && pnpm -r build
bash demo/demo.sh                        # the live NOT_READY → READY demo
```

See [`docs/getting-started.md`](./docs/getting-started.md) for the full loop run
end-to-end against the bundled `fixtures/sample-next-app`.

## What works now vs. what's planned

See **[ROADMAP.md](./ROADMAP.md)** — it separates the shipping Core (this repo) from
the deeper gates, learning loop, and the paid Premium Brain / hosted tier that are on
the way. DevCortex is built **production-grade from day one** — no MVP placeholders.

## Security & trust model

DevCortex reads files and **runs commands inside the repository you point it at** —
treat it like any tool with shell access to that repo:

- **Run DevCortex only on repositories you trust.** The quality gate (`verify` /
  `ship`) runs the *target repo's own configured commands* — its `typecheck` /
  `lint` / `build` / `test` scripts. Both spawn real processes, so a hostile repo's
  scripts are hostile code.
- **Verifiers are read-only and root-contained.** The file / route / symbol / import
  verifiers never write, and any path that escapes the project root (`../` traversal
  or an absolute path outside the root) is refused without being read.
- **Guarded mode protects your `protectedPaths`.** Edits to high-risk or
  `protectedPaths`-matched files (`**/auth/**`, `middleware.ts`, `.env*`, migrations)
  are blocked *with an explanation* — never silently.

## License

[Apache-2.0](./LICENSE). Contributions of stack packs, skills, workflows, quality
gates, and adapters are welcome.
