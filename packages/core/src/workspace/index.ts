/**
 * Workspace layer — owns the `.cortex/` directory: path resolution, typed
 * read/write of config + the cached graph (validated via zod schemas), and
 * initialization of the full workspace tree.
 *
 * Public API:
 *   workspacePaths(root: string): WorkspacePaths
 *   isInitialized(root: string): Promise<boolean>
 *   initWorkspace(root: string, opts: InitOptions): Promise<{ created: string[] }>
 *   defaultConfig(stack?: DetectedStack): CortexConfig
 *   loadConfig(root: string): Promise<CortexConfig>
 *   saveConfig(root: string, config: CortexConfig): Promise<void>   // atomic
 *   loadGraph(root: string): Promise<ProjectGraph | null>
 *   saveGraph(root: string, graph: ProjectGraph): Promise<void>
 */
export { workspacePaths } from './paths';
export type { WorkspacePaths, InitOptions } from './paths';

export { defaultConfig, loadConfig, saveConfig, CONFIG_SCHEMA_VERSION } from './config';

export { loadGraph, saveGraph } from './graph-store';

export { initWorkspace, isInitialized } from './init';
