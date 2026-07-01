// Public API of @devcortex/claude-code.
//
// The installer (`installClaude`) plus the deterministic settings / MCP / hook
// shim builders it is composed from. Surfaces (the `devcortex install claude`
// CLI command, tests, other tooling) consume these directly.

export * from './templates';
export * from './install';
