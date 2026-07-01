<div align="center">

# DevCortex

**The cognitive layer for production-grade AI coding agents.**

*Keep using your favorite AI coding agent. DevCortex makes it remember, research, protect, verify, and improve like an elite engineering team.*

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

</div>

---

DevCortex is **not another AI coding agent**. It is a **local-first cognitive engineering layer** that sits on top of the AI coding environments you already use — Claude Code, Codex CLI, Cursor, VS Code agent mode, and any MCP-compatible client.

Your AI agent writes code. **DevCortex makes it ship.**

## Why

Today's AI coding agents generate impressive code but behave nothing like an elite senior engineer. They forget what they built, break existing features, hallucinate "done" without evidence, and never learn from repeated failures. DevCortex closes that gap with a persistent, local, **tokenless-by-default** cognition layer:

- **Remember** — a durable project brain (memory, feature, and decision ledgers).
- **Protect** — blast-radius analysis warns before a change breaks auth, billing, routes, or data.
- **Verify** — an evidence ledger refuses to let an agent claim "done" without proof (build passed, route exists, test green).
- **Compress** — deep cognition happens *outside* your agent's context; only a tiny, actionable instruction comes back, so it doesn't burn your tokens.

## The Cognition Spine (this release)

This repository currently ships **DevCortex Core — the Cognition Spine**: the complete local `remember → protect → verify → ship` loop.

| Surface | What it does |
|---|---|
| **`@devcortex/core`** | The pure engine: project graph, ledgers, intent/context compilers, blast-radius, quality gates, policy. |
| **`devcortex` CLI** | `init · doctor · scan · preflight · context · verify · ship · memory · feature · install`. |
| **`@devcortex/mcp-server`** | Exposes the engine to any MCP client as `cortex.*` tools (stdio). |
| **Claude Code integration** | Lifecycle hooks that inject preflight context, protect risky edits, record evidence, and gate "done". |

## Quick start

DevCortex is a pnpm + turborepo monorepo. The workspace binaries (`devcortex`,
`devcortex-mcp`) are **not yet published to npm**, so run the CLI from source:
build once, then invoke the built entrypoint directly.

```bash
pnpm install
pnpm -r build                                  # @devcortex/core → mcp-server + claude-code → CLI

CLI=./apps/cli/dist/cli.js
node "$CLI" init --cwd /path/to/your/repo            # scan the repo, create .cortex/, pick a mode
node "$CLI" install claude --cwd /path/to/your/repo  # wire up Claude Code hooks + MCP
node "$CLI" preflight "add subscription billing" --cwd /path/to/your/repo
node "$CLI" ship --cwd /path/to/your/repo            # evidence-backed ship report
```

> **(after `npm publish`)** Once the `devcortex` package is published (or
> `npm install -g`'d), its bin is on your `PATH` and the same loop becomes:
>
> ```bash
> npx devcortex init          # scan the repo, create .cortex/, pick a mode
> devcortex install claude    # wire up Claude Code hooks + MCP
> devcortex preflight "add subscription billing"
> devcortex ship              # evidence-backed ship report
> ```

See [`docs/getting-started.md`](./docs/getting-started.md) for the full, verified
loop run end-to-end against the bundled `fixtures/sample-next-app`.

## Security & trust model

DevCortex reads files and **runs commands inside the repository you point it at** —
treat it like any tool with shell access to that repo:

- **Run DevCortex only on repositories you trust.** The quality gate (`verify` /
  `ship`) runs the *target repo's own configured commands* — its `typecheck` /
  `lint` / `build` / `test` scripts. `cortex.verify_command` runs
  *caller-supplied* shell commands inside the target root. Both spawn real
  processes, so a hostile repo's scripts (or a hostile command) are hostile code.
- **Verifiers are read-only and root-contained.** The file / route / symbol /
  import verifiers never write, and any path that escapes the project root — `../`
  traversal or an absolute path pointing outside the root — is refused without
  ever being read.
- **Guarded mode protects your configured `protectedPaths`.** In `guarded` mode,
  edits to high-risk or `protectedPaths`-matched files (e.g. `**/auth/**`,
  `middleware.ts`, `.env*`, migrations) are blocked *with an explanation* — never
  silently.

## A note on zod versions

The monorepo intentionally spans two zod majors, and the two **never cross**:

- **`@devcortex/core`** (and the `devcortex` CLI, which is thin over it) use
  **zod 3** for core's drift-guarded domain schemas.
- **`@devcortex/mcp-server`** and **`@devcortex/claude-code`** use **zod 4** to
  align with the MCP toolchain. `@modelcontextprotocol/sdk`'s zod peer range is
  `^3.25 || ^4.0`, so zod 4 is fully supported there.

Core's zod-3 schemas and the MCP packages' zod-4 schemas live in separate
packages and share no zod value across the boundary, so the major split is safe.

## Status

DevCortex is built as a **monorepo** (pnpm + turborepo). It is being developed **production-grade from day one** — no MVP placeholders. See [`docs/spec`](./docs/spec) for the living design.

## License

[Apache-2.0](./LICENSE). Contributions of stack packs, skills, workflows, quality gates, and adapters are welcome.
