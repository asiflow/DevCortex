/**
 * Policy engine — operating modes + risk classification + protected-path checks.
 * Encodes the risk-based-depth philosophy: low-risk tasks stay light, high-risk
 * tasks trigger deeper planning/verification.
 *
 * Public API (Wave 1):
 *   classifyRisk(task, graph, config): RiskClassification
 *   isProtected(path, config): boolean
 *   depthForRisk(risk): ContextDepth
 *   shouldBlock(mode, risk): boolean
 */
export { classifyRisk } from './classify';
export { isProtected } from './protected';
export { depthForRisk } from './depth';
export { shouldBlock } from './mode';
