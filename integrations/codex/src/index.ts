// Public API of @devcortex/codex.
//
// The installer (`installCodex`) plus the deterministic AGENTS.md / config.toml
// block builders and delimited-block merge it is composed from. Surfaces (the
// `devcortex install codex` CLI command, tests, other tooling) consume these
// directly.

export * from './templates';
export * from './install';
