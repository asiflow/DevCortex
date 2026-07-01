/**
 * Blast-radius engine — given changed files + the graph, compute what could
 * break (routes, components, api, tables, auth, billing, env, tests, fragile
 * areas) and the required checks to prove it did not.
 *
 * Public API (Wave 1):
 *   analyzeBlastRadius(graph: ProjectGraph, changedFiles: string[], config: CortexConfig): BlastRadius
 */
export { analyzeBlastRadius } from './analyze';
