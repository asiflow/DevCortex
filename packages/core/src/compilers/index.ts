/**
 * Compilers — turn a vague task into a precise engineering contract, and
 * assemble the minimum-complete context pack. Context must be aggressively
 * compressed (tiny: 300-800 / standard: 1k-2.5k / deep: high-risk only tokens).
 *
 * Public API (Wave 1):
 *   compileIntent(task: string, graph: ProjectGraph, packs: StackPack[], config: CortexConfig): IntentContract
 *   compileContext(intent: IntentContract, graph: ProjectGraph, ledgers: ContextLedgers, depth: ContextDepth): Promise<ContextPack>
 */
export { compileIntent } from './intent';
export { compileContext } from './context';
export type { ContextLedgers } from './context';
export { composeSessionBrief } from './brief';
export type { SessionBrief } from './brief';
