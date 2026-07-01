/**
 * TypeScript (language-level) reference stack pack.
 *
 * Real, current (2026) guidance that applies to any TypeScript project
 * regardless of framework: strict compiler configuration (including
 * noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax),
 * parse-don't-validate at boundaries with Zod, discriminated unions with
 * exhaustive never checks, unknown-over-any, and the ESM/NodeNext resolution
 * rules. Anchored to TypeScript 5.x, ESLint 9 flat config + typescript-eslint 8.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

const bestPractices: Rule[] = [
  {
    id: 'ts.strict-all',
    title: 'Enable strict plus the extra soundness flags',
    detail:
      'Turn on "strict": true and additionally noUncheckedIndexedAccess (array/record access yields T | undefined), exactOptionalPropertyTypes, noImplicitOverride, and noFallthroughCasesInSwitch. Strict alone still lets arr[i] pretend to be defined; the extra flags close the gaps that cause runtime undefined-access crashes.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'ts.unknown-over-any',
    title: 'Prefer unknown to any and narrow before use',
    detail:
      'any disables type checking for everything it touches and silently spreads. Use unknown for genuinely-unknown values and narrow with typeof/instanceof/a Zod parse before use. Reserve any for rare, isolated, commented escape hatches — never as the default for "I\'ll type it later".',
    severity: 'high',
    appliesTo: ['lib', 'service'],
  },
  {
    id: 'ts.parse-dont-validate',
    title: 'Parse external input at the boundary and infer the type from the schema',
    detail:
      'Every value crossing a trust boundary (HTTP body, env, JSON file, third-party API) is unknown at runtime regardless of its declared type. Validate it once at the edge with Zod (or Valibot) and derive the static type with z.infer, so the compiler and the runtime agree instead of the type being an unchecked assertion.',
    severity: 'high',
    appliesTo: ['service', 'api', 'schema'],
  },
  {
    id: 'ts.discriminated-unions-exhaustive',
    title: 'Model states as discriminated unions with an exhaustive never check',
    detail:
      'Represent mutually-exclusive states as a union with a literal discriminant ({ status: "loading" } | { status: "error"; error } | { status: "ok"; data }) instead of a bag of optional fields. Switch on the discriminant and add a default: const _exhaustive: never = state so adding a new variant becomes a compile error.',
    severity: 'medium',
    appliesTo: ['lib', 'service'],
  },
  {
    id: 'ts.readonly-immutability',
    title: 'Default to readonly and as const for data you do not mutate',
    detail:
      'Mark function parameters and returned data structures readonly / ReadonlyArray, and use as const for literal config so it keeps its narrow literal type. Immutable-by-default signatures document intent and stop accidental mutation of shared objects.',
    severity: 'low',
    appliesTo: ['lib', 'service'],
  },
  {
    id: 'ts.satisfies-operator',
    title: 'Use satisfies to check a value against a type without widening it',
    detail:
      'const config = {...} satisfies Config verifies the object matches Config while preserving the exact literal types of its members (so keys stay specific and unions stay narrow). Prefer it to an "as Config" annotation, which both checks and widens and can hide missing keys.',
    severity: 'low',
    appliesTo: ['config', 'lib'],
  },
  {
    id: 'ts.union-over-enum',
    title: 'Prefer const string-literal unions to enums',
    detail:
      'type Mode = "on" | "off" (optionally with an as const array as the runtime source of truth) is fully erasable, has no runtime cost, and plays well with isolatedModules/verbatimModuleSyntax. TypeScript enums emit runtime code and numeric enums are unsound; avoid them in new code.',
    severity: 'low',
    appliesTo: ['lib'],
  },
  {
    id: 'ts.import-type',
    title: 'Use `import type` for type-only imports (verbatimModuleSyntax)',
    detail:
      'With verbatimModuleSyntax the compiler emits imports verbatim, so a value import used only for its type stays in the output and can cause runtime/cycle errors. Import types with `import type { X }` (or inline `import { type X }`) and re-export them with `export type` so they are fully elided.',
    severity: 'medium',
    appliesTo: ['lib', 'service'],
  },
  {
    id: 'ts.catch-unknown',
    title: 'Treat catch bindings as unknown and narrow before use',
    detail:
      'Under useUnknownInCatchVariables (part of strict) a catch (err) binds err as unknown. Narrow it (err instanceof Error ? err.message : String(err)) before reading .message, and define typed error classes for domain errors so callers can discriminate them.',
    severity: 'medium',
    appliesTo: ['service', 'lib'],
  },
  {
    id: 'ts.esm-resolution',
    title: 'Pick one module resolution strategy and honour its import rules',
    detail:
      'Use moduleResolution "Bundler" for bundled apps (extensionless relative imports) or "NodeNext" for code Node runs directly (relative imports must include the .js extension). Do not mix the two expectations; the wrong choice yields either editor errors or ERR_MODULE_NOT_FOUND at runtime.',
    severity: 'medium',
    appliesTo: ['config'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'ts.anti.any-escape',
    title: 'Reaching for any (or `as any`) to silence an error',
    detail:
      'any and as any switch off checking for that value and everything derived from it, so real bugs (typos, wrong shapes, null access) sail through. Model the type, narrow from unknown, or use a Zod parse; if an escape hatch is truly unavoidable, isolate it and comment why.',
    severity: 'high',
    appliesTo: ['lib', 'service'],
  },
  {
    id: 'ts.anti.non-null-assertion',
    title: 'Sprinkling the non-null assertion (!) to dismiss nullability',
    detail:
      'value!.foo tells the compiler "trust me, not null" — when it is null you get a runtime TypeError the types promised could not happen. Narrow with a real check, provide a default, or fix the type so the value genuinely cannot be null.',
    severity: 'medium',
    appliesTo: ['lib', 'service'],
  },
  {
    id: 'ts.anti.assertion-lie',
    title: 'Using `as SomeType` to force a value into a shape it does not have',
    detail:
      'A type assertion is an unchecked claim, not a conversion. Asserting an API response `as User` when it was never validated means the "User" can be missing fields at runtime. Validate with a schema and let inference produce the type instead of asserting.',
    severity: 'high',
    appliesTo: ['service', 'api'],
  },
  {
    id: 'ts.anti.ts-ignore',
    title: 'Suppressing errors with @ts-ignore',
    detail:
      '@ts-ignore silences whatever error appears on the next line, including new errors introduced later, and rots silently. If a suppression is truly required use @ts-expect-error with a comment — it errors if the underlying problem is ever fixed, so it cannot go stale.',
    severity: 'medium',
    appliesTo: ['lib', 'service'],
  },
  {
    id: 'ts.anti.enum-runtime',
    title: 'Introducing enums (especially const enums) in new code',
    detail:
      'const enum breaks under isolatedModules/verbatimModuleSyntax and single-file transpilers (esbuild/SWC); regular enums emit runtime objects and numeric enums accept any number. Use string-literal unions or an as const object instead.',
    severity: 'low',
    appliesTo: ['lib'],
  },
  {
    id: 'ts.anti.trust-external-as-typed',
    title: 'Treating JSON.parse / fetch().json() results as already typed',
    detail:
      'const user: User = await res.json() is a lie: json() returns any, so the annotation is an unchecked assertion and no validation happens. Parse the response through a schema before using it as a typed value.',
    severity: 'high',
    appliesTo: ['service', 'api'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'typescript',
    supported: '^5',
    note: 'TypeScript 5.x: satisfies, const type parameters, verbatimModuleSyntax, isolatedDeclarations, and the strict flag set this pack assumes. Bump majors deliberately and read the release notes for new errors under strict.',
  },
  {
    pkg: '@types/node',
    supported: '^22',
    note: 'Match @types/node to the Node major you run (22 LTS / 24). A mismatched types package hides or invents Node API signatures.',
  },
  {
    pkg: 'eslint',
    supported: '^9',
    note: 'ESLint 9 uses the flat config (eslint.config.js). Older .eslintrc examples will not load without the compatibility shim.',
  },
  {
    pkg: 'typescript-eslint',
    supported: '^8',
    note: 'typescript-eslint 8 provides the flat-config helper (tseslint.config) and type-aware rules; enable the recommended-type-checked set for the no-floating-promises / no-unsafe-* rules.',
  },
  {
    pkg: 'vitest',
    supported: '^2',
    note: 'Vitest 2.x runs ESM/TS natively with no separate transform config; align its tsconfig types with the project.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'ts.fail.erasable-syntax',
    signature:
      'error TS1286: ESM syntax is not allowed in a CommonJS module / TS1287 / "This syntax is not allowed when erasableSyntaxOnly is enabled" / enum or namespace flagged under verbatimModuleSyntax',
    cause: 'Non-erasable TypeScript constructs (enum, namespace, parameter properties) or a value import used only as a type conflict with verbatimModuleSyntax / a type-stripping runtime.',
    fix: 'Replace enums with const unions and namespaces with modules, avoid parameter properties, and use `import type` for type-only imports so the syntax is fully erasable.',
  },
  {
    id: 'ts.fail.no-unchecked-indexed',
    signature: "error TS2532/TS18048: Object is possibly 'undefined' after indexing an array or record",
    cause: 'noUncheckedIndexedAccess makes arr[i] and record[key] yield T | undefined, so accessing a property on the result without a guard errors.',
    fix: 'Guard the access (const item = arr[i]; if (!item) return ...), use .at()/optional chaining, or iterate with for...of / .map so the element is non-nullable — do not disable the flag.',
  },
  {
    id: 'ts.fail.catch-unknown',
    signature: "error TS18046: 'error' is of type 'unknown' when reading error.message in a catch block",
    cause: 'useUnknownInCatchVariables (part of strict) types the catch binding as unknown, so property access is rejected.',
    fix: 'Narrow first: `const message = error instanceof Error ? error.message : String(error)`, or route through a typed error class before reading fields.',
  },
  {
    id: 'ts.fail.esm-missing-extension',
    signature: "ERR_MODULE_NOT_FOUND: Cannot find module '.../foo' at runtime (Node ESM / NodeNext)",
    cause: 'Under NodeNext, Node requires the explicit file extension in relative import specifiers, but the source omitted it (e.g. import "./foo" instead of "./foo.js").',
    fix: 'Add the .js extension to relative imports when targeting Node ESM directly, or switch to moduleResolution "Bundler" and let a bundler resolve extensionless imports.',
  },
  {
    id: 'ts.fail.isolated-modules-reexport',
    signature: "error TS1205/TS1448: Re-exporting a type when 'isolatedModules'/'verbatimModuleSyntax' is enabled",
    cause: 'A type was re-exported with a value re-export (export { Foo }) under isolatedModules/verbatimModuleSyntax, which cannot tell it is type-only.',
    fix: 'Use `export type { Foo }` (or `export { type Foo }`) so the compiler and single-file transpilers know to erase it.',
  },
];

/**
 * The TypeScript language-level reference pack. Matches any detected stack whose
 * primary language is TypeScript, regardless of framework.
 */
export const typescriptPack: StackPack = {
  id: 'typescript',
  name: 'TypeScript (strict, language-level)',
  matches: (stack) => stack.language === 'typescript',
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'typescript@^5',
    '@types/node@^22',
    'zod@^3',
    'eslint@^9',
    'typescript-eslint@^8',
    'prettier@^3',
    'vitest@^2',
    'tsx@^4',
    'tsup@^8',
  ],
  versionChecks,
  setupCommands: [
    'pnpm add -D typescript @types/node',
    'pnpm exec tsc --init',
    'pnpm add zod',
    'pnpm add -D eslint typescript-eslint prettier',
    'pnpm add -D vitest tsx',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec eslint .',
    'pnpm exec prettier --check .',
    'pnpm exec vitest run',
  ],
  qualityGates: [
    'tsconfig has "strict": true plus noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, and verbatimModuleSyntax.',
    '`tsc --noEmit` reports zero errors — no @ts-ignore/@ts-expect-error suppressions left in place without justification.',
    'ESLint (typescript-eslint recommended-type-checked) passes; no-floating-promises and no-explicit-any are enforced.',
    'No `any` or unchecked `as` assertion at a trust boundary — external input is parsed with a schema.',
    'Every discriminated union switch has a `never` exhaustiveness check.',
    'Unit tests are green under Vitest.',
  ],
  securityNotes: [
    'Static types are erased at runtime — they are not a security control. Every value from the network, the filesystem, env, or a third-party API must be validated at runtime (Zod) before it is trusted.',
    'An `as` assertion or a non-null `!` is an unchecked claim; using it on untrusted data lets malformed/malicious input flow through as if it were valid.',
    'Never use eval() or new Function() to interpret data — they execute arbitrary code and defeat the type system entirely.',
    'Validate and parse environment variables at startup with a schema so a missing/mis-typed secret fails fast instead of surfacing as undefined deep in a request.',
    'Enable typescript-eslint\'s no-floating-promises: an unhandled rejected promise can crash a Node process or silently swallow an error.',
  ],
  deploymentNotes: [
    'Type-check in CI (`tsc --noEmit`) as a gate independent of the bundler — a passing bundle does not imply a passing type-check.',
    'Compile/transpile for the target: tsup/tsc for libraries (emit declaration files), a bundler for apps; do not ship raw .ts to production.',
    'Keep source maps out of public production bundles (or restrict access) so internal source is not exposed to clients.',
    'Pin the TypeScript version in devDependencies; a minor bump can introduce new errors under strict and should be an intentional change.',
    'Emit and publish .d.ts declaration files for shared packages so consumers get types without re-compiling the source.',
  ],
  commonFailures,
};
