# devcortex

**The cognitive layer for AI coding agents.** Your agent writes code — DevCortex
makes it *ship*: evidence-backed ship reports that refuse to let an agent claim
"done" without proof, blast-radius protection for risky edits, and persistent
project memory. Works alongside Claude Code, Codex, Cursor, VS Code agent mode,
and any MCP client.

```bash
npx devcortex init                 # scan your repo, create .cortex/
npx devcortex preflight "add billing"   # risk + blast radius + context, before you touch code
npx devcortex ship                 # evidence-backed ship report (exit 2 when NOT_READY)
```

`devcortex ship` runs your repo's own gates (typecheck / lint / build / test)
and produces a verdict:

```
CORTEX SHIP STATUS
Status       NOT_READY
Blocked (1)
  ✗ test — Command exited with code 1
Unproven "done" is blocked
  ✗ Required check failed: test
```

The agent said "done." The gate said otherwise — with evidence.

**Full documentation, integrations, and the MCP server:**
https://github.com/asiflow/DevCortex

Apache-2.0.
