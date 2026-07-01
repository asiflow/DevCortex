// Public API of @devcortex/github-actions.
//
// The installer (`installGithubActions`) plus the deterministic workflow /
// composite-action builders it is composed from. Surfaces (the `devcortex
// install github-actions` CLI command, tests, other tooling) consume these
// directly.

export * from './templates';
export * from './install';
