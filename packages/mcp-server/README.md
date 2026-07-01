# @devcortex/mcp-server

The **DevCortex MCP server** — exposes the local, tokenless `cortex.*` engineering
tools to any MCP client (Claude Code, Cursor, Codex CLI, VS Code agent mode, …):
preflight context, blast-radius analysis, protected-path policy, the evidence ledger,
and the ship gate.

Register it in your client's MCP config — no install needed:

```json
{
  "mcpServers": {
    "devcortex-mcp": {
      "command": "npx",
      "args": ["-y", "@devcortex/mcp-server"]
    }
  }
}
```

Or install it globally so the `devcortex-mcp` binary is on your `PATH`:

```bash
npm install -g @devcortex/mcp-server
```

The server resolves the repository root from `--root <dir>`, then `DEVCORTEX_ROOT`,
then the current working directory. Everything runs **locally** — the tools scan and
analyze your repo; no model calls, no tokens.

Part of **[DevCortex](https://github.com/asiflow/DevCortex)** — the cognitive layer
for AI coding agents. Apache-2.0.
