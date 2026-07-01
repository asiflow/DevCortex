/**
 * Project Graph engine — scans a repo into a structured ProjectGraph: stack
 * detection, file classification (FileKind), an import/imported-by dependency
 * graph, routes, env vars, scripts, and risky-file flags.
 *
 * Public API (Wave 1):
 *   scanProject(root: string, opts?: ScanOptions): Promise<ProjectGraph>
 *   relevantFiles(graph: ProjectGraph, task: string): FileNode[]
 *   dependentsOf(graph: ProjectGraph, file: string): string[]
 */

export { scanProject } from './scan';
export type { ScanOptions } from './scan';
export { relevantFiles, dependentsOf } from './relevance';
