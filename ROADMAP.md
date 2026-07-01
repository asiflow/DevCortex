# Roadmap

DevCortex is built **production-grade from day one** — the items under "Works now"
are shipped, tested, and in this repository today, not aspirations. This document
draws a hard line between what works, what's next, and what belongs to the paid
tiers (which are *not* in this open-source repo).

---

## ✅ Works now — DevCortex Core (this repo, Apache-2.0)

The complete local **remember → protect → verify → ship** loop.

**Ship & verify**
- `devcortex ship` — evidence-backed ship report; blocks unproven "done"; exits `2`
  on `NOT_READY` so it drops into CI / pre-commit.
- `devcortex verify` — the quality gate: runs the repo's own typecheck / lint /
  build / test, plus route and env checks.
- `devcortex gate [code|ui|security|devops|product|premium-ui]` — deep,
  stack-aware quality gates.
- Evidence ledger + read-only, root-contained verifiers (file / route / symbol /
  import / command).

**Remember (project brain)**
- `.cortex/` workspace with memory, feature, and decision ledgers.
- `devcortex init` / `scan` / `doctor` — build and maintain the project graph.

**Protect**
- `devcortex preflight "<task>"` — risk + blast radius + intent + minimal context.
- `devcortex context` / `plan` — minimum-complete context pack; risk-scaled plans.
- Guarded mode + `guard` / `record-evidence` hooks — block edits to protected paths
  with an explanation.

**Integrations**
- Claude Code lifecycle hooks (`devcortex install claude`).
- `@devcortex/mcp-server` — the engine as `cortex.*` tools for any MCP client (stdio).
- Adapters for **Codex**, **Cursor**, **VS Code** agent mode, and a **GitHub Action**.

**MCP governance & privacy**
- `devcortex mcp` — safe MCP manager (recommend / install read-only / audit).
- `devcortex firewall` — allow / deny / require-approval policy for tool calls.
- `devcortex privacy` / `redact` — privacy modes and secret redaction.

**Learn & operate**
- `devcortex learn` — turn recurring failures into durable remedies (skills, notes,
  memory).
- `devcortex daemon` / `dashboard` — optional local daemon + web dashboard on
  `127.0.0.1`.

_829 tests green · strict TypeScript · pnpm + turborepo monorepo._

---

## 🔜 Next (open-source)

- **`npx devcortex`** — the CLI is packaged as a self-contained npm binary;
  publish to the registry is the remaining step.
- **More stack packs** — Next.js ships today; Python/FastAPI, Go, and generic
  Node/Vite packs are next.
- **Richer demo + docs site** — the 30–60s terminal demo (`demo/demo.tape`) and a
  hosted docs site.
- **Prospective blast radius** — compute the radius of a *planned* change from the
  relevant-files set, before the first edit.
- **Broader MCP contract tests** across every exposed tool.

---

## 💠 Paid tiers (separate — not in this repo)

These are commercial products built on top of Core; they live outside this
open-source repository.

- **Premium Brain** — frontier-model reasoning, live best-practice research,
  cross-project learning, premium stack packs, and advanced UI / DevOps / security
  review, without burning your agent's tokens.
- **DevCortex Cloud (Team / Enterprise)** — hosted dashboards, shared team memory,
  org-wide gate policies enforced in pull requests, RBAC, audit logs, SSO, and a
  self-host option.

The open-source Core stays fully functional and local-first forever. The paid tiers
add higher-order intelligence and team/enterprise governance — they never gate the
local loop.
