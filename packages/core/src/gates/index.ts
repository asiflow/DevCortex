/**
 * Quality gates + ship report. Runs REAL commands (typecheck / lint / build /
 * test) plus route/env checks, collecting EvidenceItems, then synthesizes a
 * ShipReport (READY / READY_WITH_WARNINGS / NOT_READY) with a suggested
 * next-prompt when blocked. Never reports a pass it cannot back with evidence.
 *
 * Public API (Wave 1 — general code gate + ship report):
 *   runQualityGate(root, config, graph): Promise<{ result: GateResult; evidence: EvidenceItem[] }>
 *   generateShipReport(root, config, graph, ledgers): Promise<ShipReport>
 *
 * Deep quality gates (sub-project #4, spec §7.12-7.13 + §7.21) — tokenless,
 * deterministic heuristics over the ProjectGraph + real file reads. Each gate
 * returns findings as CheckResults and only throws on internal error:
 *   runUiGate(root, graph, config):       Promise<{ result: GateResult; evidence: EvidenceItem[] }>
 *   runSecurityGate(root, graph, config): Promise<{ result: GateResult; evidence: EvidenceItem[] }>
 *   runDevopsGate(root, graph, config):   Promise<{ result: GateResult; evidence: EvidenceItem[] }>
 *   runProductGate(root, graph, config):  Promise<{ result: GateResult; evidence: EvidenceItem[] }>
 *   runPremiumUiGate(root, graph):        Promise<UiQualityScore>
 *
 * DevOps Commander (read-only diagnostics + aggregate readiness):
 *   diagnoseDocker / diagnoseVercel / diagnoseGithubActions / diagnoseK8s
 *   productionConfigCheck / secretsExposureCheck / ciHealth
 *   deploymentReadiness(root, graph, config): Promise<DeploymentReadiness>
 */
export { runQualityGate, generateShipReport } from './gates';
export type { ShipLedgers } from './gates';

export { runUiGate } from './ui';
export { runSecurityGate } from './security';
export { runDevopsGate } from './devops';
export { runProductGate } from './product';
export { runPremiumUiGate } from './premium-ui';

export {
  diagnoseDocker,
  diagnoseVercel,
  diagnoseGithubActions,
  diagnoseK8s,
  productionConfigCheck,
  secretsExposureCheck,
  ciHealth,
  deploymentReadiness,
  DEPLOYMENT_READINESS_LEVELS,
} from './commander';
export type {
  Diagnostic,
  DiagnosticFinding,
  DiagnosticSeverity,
  DeploymentReadiness,
  DeploymentReadinessLevel,
} from './commander';
