/**
 * Senior Engineer Council (§7.14) — deterministic, risk-triggered selection of
 * reviewer lenses (a mixture of reviewers) for a given task. Tokenless and
 * side-effect-free (the OSS layer): a low-risk chore convenes almost no one,
 * while a critical change draws a broad review regardless of its nominal type.
 * The lens set is deduped and returned in canonical order so it is stable and
 * testable.
 *
 * Public API:
 *   convene(taskType, risk): ReviewerLens[]    — the lenses that fire for a task/risk
 *   canonicalizeLenses(lenses): ReviewerLens[] — dedupe + stable canonical ordering
 *   review(root, graph, config, lenses): Promise<CouncilReport>
 *                                              — run the convened lenses' concrete,
 *                                                evidence-backed checks over the graph + files
 */
export { convene, canonicalizeLenses } from './convene';
export { review } from './review';
