// ============================================================================
// Failure diagnosis (§7.17) — deterministic root-cause categorization.
//
// Given a failure signature, decide *why* it keeps happening. The mapping is a
// small, ordered keyword rule set (first match wins) plus a fallback, so the
// same signature always yields the same category — no heuristics that drift and
// no LLM calls. The category then selects the remedy the learning engine will
// create (`remedyForCategory`).
// ============================================================================

import type {
  FailureCategory,
  FailureDiagnosis,
  LearnedFailure,
  LearningRemedy,
} from '../domain/index';

/** One ordered diagnosis rule: a predicate over the lowercased signature. */
interface DiagnosisRule {
  category: FailureCategory;
  /** true when this rule claims the signature. */
  matches: (signature: string, kind: string) => boolean;
}

/** Extract the `<kind>` prefix a signature always carries (see `evidenceSignature`). */
function signatureKind(signature: string): string {
  const idx = signature.indexOf(':');
  return idx === -1 ? '' : signature.slice(0, idx);
}

/** Whole-word-ish containment test over the lowercased signature. */
function has(signature: string, needle: string): boolean {
  return signature.includes(needle);
}

// Ordered most-specific → most-general. The first matching rule wins; anything
// that matches nothing falls through to `weak-agent`.
const RULES: readonly DiagnosisRule[] = [
  {
    category: 'missing-mcp',
    matches: (s) =>
      has(s, 'mcp') ||
      has(s, 'tool not') ||
      has(s, 'no such tool') ||
      has(s, 'tool unavailable') ||
      has(s, 'unknown tool'),
  },
  {
    category: 'wrong-package',
    matches: (s, kind) =>
      kind === 'import' ||
      has(s, 'cannot find module') ||
      has(s, 'module not found') ||
      has(s, 'err_module_not_found') ||
      has(s, 'is not a function') ||
      has(s, 'has no exported member'),
  },
  {
    category: 'outdated-docs',
    matches: (s) =>
      has(s, 'deprecat') ||
      has(s, 'outdated') ||
      has(s, 'no longer supported') ||
      has(s, 'removed in'),
  },
  {
    category: 'bad-rule',
    matches: (s, kind) => kind === 'lint' || has(s, 'eslint') || has(s, 'lint'),
  },
  {
    category: 'missing-test',
    matches: (s, kind) =>
      kind === 'test' || has(s, 'test failed') || has(s, 'no tests') || has(s, 'missing test'),
  },
  {
    category: 'missing-context',
    matches: (s, kind) =>
      kind === 'env' ||
      kind === 'migration' ||
      kind === 'typecheck' ||
      kind === 'build' ||
      has(s, 'environment variable') ||
      has(s, 'is not defined') ||
      has(s, 'cannot find name') ||
      has(s, 'undefined'),
  },
];

/** Human-readable cause sentence per category, parameterized by the signature. */
const CAUSE: Record<FailureCategory, (signature: string) => string> = {
  'missing-context': (s) => `The agent lacked the context needed to get this right (signature: ${s}).`,
  'missing-skill': (s) =>
    `The task needs a reusable engineering skill the project does not yet have (signature: ${s}).`,
  'outdated-docs': (s) =>
    `The approach relies on outdated or deprecated APIs (signature: ${s}).`,
  'wrong-package': (s) =>
    `The failure points at a wrong or missing package/module (signature: ${s}).`,
  'bad-rule': (s) => `A project lint/style rule keeps rejecting the change (signature: ${s}).`,
  'missing-test': (s) =>
    `The change repeatedly breaks tests, indicating missing or inadequate coverage (signature: ${s}).`,
  'weak-agent': (s) =>
    `A recurring failure with no clearer root-cause signal, indicating weak agent behavior (signature: ${s}).`,
  'missing-mcp': (s) =>
    `A required MCP/tool appears unavailable for this task (signature: ${s}).`,
};

/**
 * Category → remedy the learning engine should create. Declared as a total
 * `Record` so adding a `FailureCategory` fails the build until it is mapped.
 */
const REMEDY: Record<FailureCategory, LearningRemedy> = {
  'missing-test': 'regression-check',
  'missing-skill': 'skill',
  'weak-agent': 'skill',
  'missing-context': 'rule',
  'wrong-package': 'rule',
  'bad-rule': 'rule',
  'missing-mcp': 'rule',
  'outdated-docs': 'stack-pack',
};

/**
 * Diagnose a raw signature string. Internal: `analyzeFailures` calls this while
 * still assembling a {@link LearnedFailure}, before its `diagnosis` exists.
 */
export function diagnoseSignature(signature: string): FailureDiagnosis {
  const kind = signatureKind(signature);
  const lowered = signature.toLowerCase();
  for (const rule of RULES) {
    if (rule.matches(lowered, kind)) {
      return { category: rule.category, cause: CAUSE[rule.category](signature) };
    }
  }
  return { category: 'weak-agent', cause: CAUSE['weak-agent'](signature) };
}

/** Public: deterministic root-cause diagnosis for an observed learned failure. */
export function diagnose(failure: LearnedFailure): FailureDiagnosis {
  return diagnoseSignature(failure.signature);
}

/** The remedy kind the learning engine creates for a diagnosed category. */
export function remedyForCategory(category: FailureCategory): LearningRemedy {
  return REMEDY[category];
}
