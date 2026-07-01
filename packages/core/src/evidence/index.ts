/**
 * Evidence verifiers — turn claims into verified/partial/refuted/unverified
 * EvidenceItems against source truth. The anti-hallucination core: no claim is
 * trusted without evidence, and "done" can be blocked when evidence is missing.
 *
 * Public API (Wave 1):
 *   verifyFileExists(root: string, relPath: string): Promise<EvidenceItem>
 *   verifyRouteExists(graph: ProjectGraph, routePath: string): EvidenceItem
 *   verifySymbolExists(root: string, relPath: string, symbol: string): Promise<EvidenceItem>
 *   verifyImportPath(root: string, fromFile: string, importPath: string): Promise<EvidenceItem>
 *   verifyCommandResult(cmd: string, opts: { cwd: string; timeoutMs?: number }): Promise<EvidenceItem>
 *   verifyBuildEvidence(root: string, config: CortexConfig): Promise<EvidenceItem>
 *   blockUnprovenDone(report: ShipReport): { blocked: boolean; reasons: string[] }
 */

export {
  verifyFileExists,
  verifyRouteExists,
  verifySymbolExists,
  verifyImportPath,
  verifyCommandResult,
  verifyBuildEvidence,
} from './verifiers';
export type { CommandOptions } from './verifiers';

export { blockUnprovenDone } from './block';
export type { BlockDecision } from './block';
