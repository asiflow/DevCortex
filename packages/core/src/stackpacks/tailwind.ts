/**
 * Tailwind CSS reference stack pack.
 *
 * Real, current (2026) guidance for Tailwind CSS v4: the CSS-first configuration
 * (`@import "tailwindcss"` + `@theme`, no mandatory tailwind.config.js), the new
 * first-party build integrations (@tailwindcss/vite, @tailwindcss/postcss), the
 * cn() clsx + tailwind-merge pattern, design tokens over arbitrary values, and
 * the ever-present "dynamic class strings get compiled away" pitfall. Applies to
 * the frontend frameworks that render markup (Next.js, React, Vite).
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// Tailwind is a styling layer for markup-rendering frameworks. Match the
// frontend frameworks, or an explicit "tailwind" deployment/target hint.
const TAILWIND_FRAMEWORKS = ['nextjs', 'react', 'vite'];

const bestPractices: Rule[] = [
  {
    id: 'tailwind.v4-css-first-config',
    title: 'Configure Tailwind v4 in CSS with @import and @theme',
    detail:
      'Tailwind v4 replaces the JS config with a single `@import "tailwindcss"` and a `@theme { --color-brand: ...; }` block in your main stylesheet. Define colors, spacing, fonts, and breakpoints as theme variables there; a tailwind.config.js is now optional and only needed for JS-based customisation via @config.',
    severity: 'medium',
    appliesTo: ['style', 'config'],
  },
  {
    id: 'tailwind.first-party-build-plugin',
    title: 'Use the v4 first-party build integration for your bundler',
    detail:
      'Wire Tailwind v4 through @tailwindcss/vite (Vite) or @tailwindcss/postcss (PostCSS/Next.js). In v4 tailwindcss is no longer a direct PostCSS plugin, and autoprefixer/postcss-import are built in, so the old three-plugin postcss.config is obsolete.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'tailwind.design-tokens-over-arbitrary',
    title: 'Style with theme tokens, not one-off arbitrary values',
    detail:
      'Prefer scale utilities (p-4, text-lg, text-brand) backed by @theme tokens over arbitrary values like p-[17px] or text-[#3b82f6]. Tokens keep spacing/typography/colour consistent and themeable; arbitrary values scatter magic numbers that drift from the design system.',
    severity: 'low',
    appliesTo: ['component', 'style'],
  },
  {
    id: 'tailwind.static-class-strings',
    title: 'Write class names as complete static strings the compiler can see',
    detail:
      'Tailwind generates CSS by scanning source for full class name substrings. Keep every utility as a complete literal (use conditionals that pick whole class strings), because the compiler cannot see a name assembled at runtime from fragments.',
    severity: 'high',
    appliesTo: ['component', 'style'],
  },
  {
    id: 'tailwind.cn-merge-helper',
    title: 'Compose conditional classes with clsx + tailwind-merge (cn)',
    detail:
      'Use a cn(...) helper (clsx for conditionals, tailwind-merge to resolve conflicts) when combining base classes with variant/override classes. tailwind-merge ensures the last conflicting utility wins (px-2 then px-4 → px-4) instead of both landing in the class list with undefined precedence.',
    severity: 'medium',
    appliesTo: ['component', 'lib'],
  },
  {
    id: 'tailwind.extract-components-not-apply',
    title: 'Extract repetition into components, not @apply mega-classes',
    detail:
      'When a utility cluster repeats, extract a React/JSX component (or a data-driven variant with CVA) rather than recreating Bootstrap-style .btn classes with @apply. Component extraction keeps a single source of truth; heavy @apply reintroduces the specificity and dead-CSS problems Tailwind avoids.',
    severity: 'low',
    appliesTo: ['component', 'style'],
  },
  {
    id: 'tailwind.mobile-first-responsive',
    title: 'Design mobile-first and layer breakpoints upward',
    detail:
      'Unprefixed utilities apply at all sizes; sm:/md:/lg:/xl: apply at that breakpoint and up. Style the small screen first, then add larger-breakpoint overrides — do not write desktop styles and try to claw them back with max-* prefixes.',
    severity: 'low',
    appliesTo: ['component', 'style'],
  },
  {
    id: 'tailwind.dark-mode-strategy',
    title: 'Pick one dark-mode strategy and drive it from tokens',
    detail:
      'Use the class/data-attribute dark strategy (dark:) toggled on <html>, or a prefers-color-scheme custom variant, and express colours as theme variables that switch per mode. Do not hand-maintain parallel light/dark colour literals across components.',
    severity: 'low',
    appliesTo: ['style', 'component'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'tailwind.anti.dynamic-class-names',
    title: 'Building class names by string concatenation',
    detail:
      '`text-${color}-500` or `p-${size}` produce class names the compiler never sees in source, so the CSS is never generated and the style silently vanishes in the build. Map inputs to complete static class strings (a lookup object of full class names) or, as a last resort, safelist them.',
    severity: 'high',
    appliesTo: ['component'],
  },
  {
    id: 'tailwind.anti.apply-everything',
    title: 'Recreating component frameworks with @apply',
    detail:
      'Wrapping large utility sets in .card/.btn via @apply rebuilds the semantic-CSS model Tailwind exists to replace, grows the stylesheet, and reintroduces specificity wars. Extract a component instead and keep utilities in the markup.',
    severity: 'medium',
    appliesTo: ['style'],
  },
  {
    id: 'tailwind.anti.arbitrary-value-spam',
    title: 'Filling markup with arbitrary values',
    detail:
      'p-[13px], top-[37%], and text-[#1a2b3c] everywhere bypass the design scale, so nothing is consistent or themeable. Add the value to the @theme scale once and reference the token; keep arbitrary values for rare true one-offs.',
    severity: 'low',
    appliesTo: ['component', 'style'],
  },
  {
    id: 'tailwind.anti.important-override',
    title: 'Fighting cascade issues with ! (important) utilities',
    detail:
      'Prefixing utilities with ! to force them to win papers over an ordering/merge problem and makes later overrides impossible. Resolve conflicts with tailwind-merge (cn) and correct source order instead of escalating to important.',
    severity: 'low',
    appliesTo: ['component'],
  },
  {
    id: 'tailwind.anti.conflicting-utilities',
    title: 'Passing conflicting utilities without merging them',
    detail:
      'className={`px-2 ${props.className}`} where props.className is px-4 leaves both in the list; which wins depends on generated CSS order, not the caller\'s intent. Run combined class names through tailwind-merge so the intended override deterministically wins.',
    severity: 'medium',
    appliesTo: ['component', 'lib'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'tailwindcss',
    supported: '^4',
    note: 'Tailwind CSS v4: CSS-first config (@import "tailwindcss" + @theme), a new high-performance engine, and built-in import/vendor-prefixing. The v3 tailwind.config.js/PostCSS-plugin setup is superseded — read the v4 upgrade guide before migrating.',
  },
  {
    pkg: '@tailwindcss/vite',
    supported: '^4',
    note: 'The first-party Vite plugin for Tailwind v4 — add it to vite.config plugins instead of the PostCSS pipeline for the fastest builds.',
  },
  {
    pkg: '@tailwindcss/postcss',
    supported: '^4',
    note: 'The v4 PostCSS plugin (used by Next.js and other PostCSS setups). In v4 you reference this, not `tailwindcss`, as the PostCSS plugin.',
  },
  {
    pkg: 'tailwind-merge',
    supported: '^2',
    note: 'tailwind-merge resolves conflicting Tailwind utilities so the last one wins; pair it with clsx in a cn() helper. Keep its version aligned with your Tailwind major.',
  },
  {
    pkg: 'clsx',
    supported: '^2',
    note: 'clsx builds conditional class strings ergonomically; combine with tailwind-merge for conflict resolution.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'tailwind.fail.v4-postcss-plugin-moved',
    signature:
      'Error: It looks like you\'re trying to use `tailwindcss` directly as a PostCSS plugin. The PostCSS plugin has moved to a separate package',
    cause: 'A Tailwind v4 project still lists `tailwindcss` as the PostCSS plugin (the v3 setup) in postcss.config.',
    fix: 'Install @tailwindcss/postcss and reference it as the PostCSS plugin (or switch to @tailwindcss/vite for Vite). Remove the now-built-in autoprefixer/postcss-import entries.',
  },
  {
    id: 'tailwind.fail.styles-not-applied',
    signature: 'Tailwind utility classes have no effect / the page renders unstyled',
    cause: 'The stylesheet does not @import "tailwindcss" (v4) or the content/source globs miss the files that use the classes, so no CSS is generated for them.',
    fix: 'Ensure the entry CSS does `@import "tailwindcss"` and is actually imported by the app; in v4 add `@source "../path"` if template files live outside the auto-detected roots.',
  },
  {
    id: 'tailwind.fail.dynamic-class-purged',
    signature: 'A class works in dev but disappears in the production build',
    cause: 'The class name was assembled dynamically (string interpolation), so the compiler could not find it as a literal substring and never emitted its CSS.',
    fix: 'Replace interpolation with a lookup of complete static class strings, or add the class to the safelist. Never build utility names from fragments.',
  },
  {
    id: 'tailwind.fail.conflicting-utility-order',
    signature: 'An override utility (e.g. px-4) is ignored and the base (px-2) still shows',
    cause: 'Two conflicting utilities are both present and the winner is decided by generated CSS source order, not by which one was passed last.',
    fix: 'Merge combined class names with tailwind-merge (via cn()) so the intended override wins deterministically.',
  },
  {
    id: 'tailwind.fail.v3-config-migration',
    signature: 'After upgrading to v4 the tailwind.config.js theme/customisations are no longer applied',
    cause: 'Tailwind v4 moved configuration into CSS (@theme) and does not auto-load tailwind.config.js unless it is referenced.',
    fix: 'Port theme customisations into an @theme block in your CSS, or explicitly load the JS config with `@config "./tailwind.config.js"` if you must keep it.',
  },
];

/**
 * The Tailwind CSS reference pack. Matches a markup-rendering frontend stack
 * (Next.js / React / Vite) or an explicit "tailwind" deployment-target hint.
 */
export const tailwindPack: StackPack = {
  id: 'tailwind',
  name: 'Tailwind CSS v4',
  matches: (stack) =>
    TAILWIND_FRAMEWORKS.includes(stack.framework) || stack.deploymentTargets.includes('tailwind'),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'tailwindcss@^4',
    '@tailwindcss/vite@^4',
    '@tailwindcss/postcss@^4',
    'tailwind-merge@^2',
    'clsx@^2',
    'class-variance-authority@^0.7',
    'prettier-plugin-tailwindcss@^0.6',
    'tailwindcss-animate@^1',
  ],
  versionChecks,
  setupCommands: [
    'pnpm add tailwindcss @tailwindcss/vite',
    'pnpm add tailwind-merge clsx class-variance-authority',
    'pnpm add -D prettier prettier-plugin-tailwindcss',
    'printf \'@import "tailwindcss";\\n\' > src/index.css',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec prettier --check .',
    'pnpm exec vite build',
  ],
  qualityGates: [
    'The entry CSS uses `@import "tailwindcss"` (v4) and is imported by the app.',
    'Tailwind is wired via @tailwindcss/vite or @tailwindcss/postcss — `tailwindcss` is not used directly as a PostCSS plugin.',
    'No class names are assembled by string interpolation (grep for backtick class templates); dynamic styling maps to complete static strings or a safelist.',
    'Conditional/merged class names go through tailwind-merge (a cn() helper).',
    'prettier-plugin-tailwindcss sorts utilities; `prettier --check` passes.',
    'The production build renders fully styled (no purged classes) — verify a built preview, not just dev.',
  ],
  securityNotes: [
    'Tailwind is compile-time CSS with no runtime and no direct security surface, but never build class names from unsanitised user input — a value that reaches the generated CSS or an arbitrary-value bracket can inject unexpected styles.',
    'Avoid arbitrary-value utilities fed by user data (e.g. content-[...] or url() backgrounds from user input); validate and constrain any user-driven styling to a fixed allowlist of classes.',
    'Keep the safelist small and explicit — a broad safelist ships unused CSS and can surface classes you meant to gate.',
  ],
  deploymentNotes: [
    'The v4 engine tree-shakes unused utilities automatically; verify the production CSS is small and that no dynamically-referenced classes were dropped.',
    'Serve the generated CSS with long-lived immutable cache headers on hashed filenames; it changes only when source classes change.',
    'Run the Tailwind build as part of the app bundler build (Vite/Next) — there is no separate CLI step needed in the standard integrations.',
    'If you rely on @source directives for template files outside the default roots, confirm those paths are correct in the CI build environment, not just locally.',
  ],
  commonFailures,
};
