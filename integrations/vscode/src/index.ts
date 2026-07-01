// Public API of @devcortex/vscode.
//
// The installer (`installVscode`) plus the deterministic tasks / MCP / settings
// builders it is composed from. Surfaces (the `devcortex install vscode` CLI
// command, tests, other tooling) consume these directly.

export * from './templates';
export * from './install';
