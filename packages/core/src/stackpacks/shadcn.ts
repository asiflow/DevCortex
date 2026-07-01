/**
 * shadcn/ui reference stack pack.
 *
 * Real, current (2026) guidance for shadcn/ui: it is a code-distribution model,
 * not an installed component dependency — the CLI (`shadcn@latest`, the package
 * renamed from shadcn-ui) copies Radix-based, Tailwind-styled, CVA-variant
 * components into your repo, which you then own and edit. Covers components.json
 * aliases, the cn() utility, CSS-variable theming, deliberate manual updates,
 * preserving Radix accessibility, and React 19 / Tailwind v4 support. Applies to
 * the React-based frontend frameworks (Next.js, React, Vite).
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// shadcn/ui targets React apps built with Tailwind. Match the React-based
// frontend frameworks, or an explicit "shadcn" hint.
const SHADCN_FRAMEWORKS = ['nextjs', 'react', 'vite'];

const bestPractices: Rule[] = [
  {
    id: 'shadcn.own-the-code',
    title: 'Treat shadcn components as your source code, not a dependency',
    detail:
      'The CLI copies component source into your repo (e.g. components/ui). You own, read, and edit these files directly — that is the point of the model. Commit them, review them, and adapt them to your design system instead of treating them as an opaque npm package.',
    severity: 'medium',
    appliesTo: ['component', 'lib'],
  },
  {
    id: 'shadcn.add-via-cli',
    title: 'Add and scaffold components with the shadcn CLI',
    detail:
      'Use `pnpm dlx shadcn@latest add <component>` (and `init` once) so imports, the cn() util, Tailwind theme variables, and peer primitives are wired consistently against your components.json. Hand-copying from the docs drifts from your alias/style configuration.',
    severity: 'low',
    appliesTo: ['component'],
  },
  {
    id: 'shadcn.cn-utility',
    title: 'Compose className with the generated cn() helper',
    detail:
      'shadcn generates cn() (clsx + tailwind-merge) in lib/utils. Use it to combine base, variant, and caller-supplied classes so conflicting Tailwind utilities resolve predictably (the caller can override) instead of both landing in the class list.',
    severity: 'medium',
    appliesTo: ['component', 'lib'],
  },
  {
    id: 'shadcn.cva-variants',
    title: 'Model component variants with class-variance-authority',
    detail:
      'Define visual variants (variant, size, etc.) with cva() and expose them as typed props via VariantProps. This keeps variant class logic in one declarative table and gives consumers autocomplete instead of ad-hoc conditional className strings.',
    severity: 'low',
    appliesTo: ['component'],
  },
  {
    id: 'shadcn.preserve-radix-a11y',
    title: 'Keep the Radix primitives and their accessibility wiring intact',
    detail:
      'shadcn components are thin styled wrappers over Radix UI primitives that provide focus management, keyboard interaction, and ARIA. Keep the asChild pattern, Portal/Overlay structure, and aria props when editing; do not replace a Radix primitive with a plain div and lose the a11y behaviour.',
    severity: 'high',
    appliesTo: ['component'],
  },
  {
    id: 'shadcn.theme-css-variables',
    title: 'Theme through CSS variables, not per-component colour edits',
    detail:
      'shadcn drives colour via CSS custom properties (background, foreground, primary, etc.) defined in your global stylesheet and referenced by the components. Retheme by editing those variables (and the dark selector) once, rather than hard-coding colours across individual components.',
    severity: 'medium',
    appliesTo: ['style', 'component'],
  },
  {
    id: 'shadcn.components-json-consistency',
    title: 'Keep components.json aliases aligned with tsconfig paths',
    detail:
      'components.json records your style, base colour, and import aliases (@/components, @/lib/utils). Keep those aliases in sync with tsconfig paths and the bundler resolver so generated imports resolve; the CLI relies on this file to place and wire new components.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'shadcn.update-deliberately',
    title: 'Update components deliberately by diffing, not auto-upgrading',
    detail:
      'Because the code lives in your repo, upstream fixes are not delivered by a version bump. Re-run the CLI for a component (or use the diff workflow) when you want an upstream change, and reconcile it against your local edits in a reviewed commit.',
    severity: 'low',
    appliesTo: ['component'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'shadcn.anti.treat-as-dependency',
    title: 'Trying to "upgrade shadcn" like an npm package',
    detail:
      'There is no single shadcn/ui runtime package to bump for your components — they are copied source. Expecting `pnpm update` to patch a Button bug is a category error; pull upstream changes via the CLI/diff and merge them into your files.',
    severity: 'low',
    appliesTo: ['component'],
  },
  {
    id: 'shadcn.anti.strip-radix-a11y',
    title: 'Replacing Radix primitives with plain elements',
    detail:
      'Swapping <DialogPrimitive.Content> for a <div> (or dropping asChild/aria wiring) to "simplify" a component silently removes focus trapping, escape handling, and screen-reader semantics, producing an inaccessible control that looks fine visually.',
    severity: 'high',
    appliesTo: ['component'],
  },
  {
    id: 'shadcn.anti.bypass-cn',
    title: 'Concatenating className strings instead of using cn()',
    detail:
      '`className={base + " " + props.className}` bypasses tailwind-merge, so a caller\'s override and the base can both apply with undefined precedence. Route all className composition through cn() so overrides win deterministically.',
    severity: 'medium',
    appliesTo: ['component'],
  },
  {
    id: 'shadcn.anti.duplicate-utils',
    title: 'Multiple divergent copies of cn()/utils',
    detail:
      'Copy-pasting components with their own local utils creates several cn() implementations that drift (different tailwind-merge configs), causing inconsistent conflict resolution. Keep one lib/utils cn() and import it everywhere.',
    severity: 'low',
    appliesTo: ['lib', 'component'],
  },
  {
    id: 'shadcn.anti.important-theme-override',
    title: 'Overriding shadcn styles with ! important instead of tokens/cn',
    detail:
      'Forcing colours/spacing with ! utilities on top of a shadcn component fights the variant system and CSS variables. Retheme via the CSS custom properties or pass overriding classes through cn(); reserve edits to the component source for structural changes.',
    severity: 'low',
    appliesTo: ['component', 'style'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'shadcn',
    supported: 'latest',
    note: 'The CLI package is `shadcn` (renamed from shadcn-ui). Always invoke `shadcn@latest` so init/add support the current Tailwind v4 + React 19 output; the old shadcn-ui package is deprecated.',
  },
  {
    pkg: 'class-variance-authority',
    supported: '^0.7',
    note: 'CVA powers the variant tables in shadcn components (cva + VariantProps). Keep it installed and aligned with the version the generated components expect.',
  },
  {
    pkg: 'tailwind-merge',
    supported: '^2',
    note: 'Used inside cn() to resolve conflicting Tailwind utilities so caller overrides win. Must be present for shadcn components to compose correctly.',
  },
  {
    pkg: 'clsx',
    supported: '^2',
    note: 'The conditional-classname half of cn(); shadcn generates lib/utils around clsx + tailwind-merge.',
  },
  {
    pkg: 'tailwindcss',
    supported: '^4',
    note: 'Current shadcn output targets Tailwind v4 (CSS variables + @theme). Use shadcn@latest so init writes v4-compatible tokens rather than a v3 tailwind.config.',
  },
  {
    pkg: 'lucide-react',
    supported: '^0.4',
    note: 'lucide-react is the default icon set referenced by shadcn components; install it so generated components resolve their icon imports.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'shadcn.fail.cn-import-missing',
    signature: "Module not found / Cannot find module '@/lib/utils' (or cn is not exported) after adding a component",
    cause: 'The cn() utility was not generated (init skipped) or the @/lib/utils path alias does not resolve to the file the components import.',
    fix: 'Run `shadcn@latest init` to generate lib/utils, and align the @/* alias in components.json with tsconfig paths and the bundler resolver.',
  },
  {
    id: 'shadcn.fail.alias-mismatch',
    signature: 'Generated component imports (e.g. @/components/ui/button) fail to resolve at build time',
    cause: 'components.json aliases (components, utils) do not match the tsconfig path mappings or the actual folder layout.',
    fix: 'Reconcile components.json aliases with tsconfig "paths" (and the src-dir setting) so the CLI writes imports that the compiler and bundler can resolve.',
  },
  {
    id: 'shadcn.fail.tailwind4-init',
    signature: 'shadcn init errors or writes a v3-style config on a Tailwind v4 project',
    cause: 'An older shadcn/shadcn-ui CLI was used that predates Tailwind v4 CSS-first configuration.',
    fix: 'Use `pnpm dlx shadcn@latest init`; ensure Tailwind v4 (@import "tailwindcss") is set up first so init writes CSS-variable theme tokens rather than a tailwind.config theme.',
  },
  {
    id: 'shadcn.fail.style-override-ignored',
    signature: 'A className override on a shadcn component is ignored and the default styling wins',
    cause: 'The component composed classes without cn()/tailwind-merge, so the base utility and the override collide and source order decides the winner.',
    fix: 'Ensure the component uses cn() to merge className, and that a single tailwind-merge-based cn() is shared repo-wide.',
  },
  {
    id: 'shadcn.fail.react19-peer-deps',
    signature: 'npm install fails with ERESOLVE peer dependency conflicts on React 19 when adding components',
    cause: 'A transitive UI dependency still declares a React 18 peer range, which npm treats as a hard conflict under React 19.',
    fix: 'Use pnpm (which is more permissive) or npm install --legacy-peer-deps, and prefer the shadcn@latest components which target React 19; upgrade the offending primitive when a React 19-compatible release exists.',
  },
];

/**
 * The shadcn/ui reference pack. Matches a React-based frontend stack
 * (Next.js / React / Vite) or an explicit "shadcn" deployment-target hint.
 */
export const shadcnPack: StackPack = {
  id: 'shadcn-ui',
  name: 'shadcn/ui (Radix + Tailwind)',
  matches: (stack) =>
    SHADCN_FRAMEWORKS.includes(stack.framework) || stack.deploymentTargets.includes('shadcn'),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'shadcn@latest',
    'class-variance-authority@^0.7',
    'tailwind-merge@^2',
    'clsx@^2',
    'tailwindcss@^4',
    'lucide-react@^0.4',
    'tailwindcss-animate@^1',
    '@radix-ui/react-slot@^1',
  ],
  versionChecks,
  setupCommands: [
    'pnpm dlx shadcn@latest init',
    'pnpm dlx shadcn@latest add button input dialog form',
    'pnpm add class-variance-authority tailwind-merge clsx lucide-react',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec eslint .',
    'pnpm exec vitest run',
  ],
  qualityGates: [
    'components.json aliases resolve against tsconfig paths; generated `@/components/ui/*` and `@/lib/utils` imports build.',
    'A single cn() (clsx + tailwind-merge) lives in lib/utils and every component composes className through it.',
    'Radix primitives and their accessibility props (asChild, aria-*, focus/escape handling) are preserved in any edited component.',
    'Theming is driven by CSS variables in the global stylesheet, not per-component hard-coded colours.',
    'Components were added via `shadcn@latest` (Tailwind v4 + React 19 output), not hand-copied.',
    'Typecheck and lint pass; interactive components (dialog, popover, form) keep keyboard/focus behaviour.',
  ],
  securityNotes: [
    'shadcn components are your own source code — review the copied files like any dependency you vendor; do not blindly paste component code from untrusted forks/registries, which can execute arbitrary code in your app.',
    'When pointing the CLI at a custom/remote registry, trust it as you would any code source — a malicious registry can inject scripts into generated components.',
    'Form components are presentation only: always re-validate submitted data on the server (Zod) — the shadcn/react-hook-form wiring is client-side UX, not a security boundary.',
    'Preserve the Radix accessibility wiring; an inaccessible control is both a usability and a compliance (WCAG) risk, and stripping it to "simplify" is a silent regression.',
  ],
  deploymentNotes: [
    'Because component code is committed to your repo, deployments need no shadcn runtime — the components build as ordinary React + Tailwind source.',
    'Ensure the peer primitives (Radix packages, lucide-react, cva) are in dependencies so CI installs and builds them; a missing peer only surfaces at build time.',
    'When upgrading a component from upstream, do it in a dedicated reviewed commit so the diff against your local edits is visible before it ships.',
    'Keep the Tailwind v4 theme tokens the components rely on defined in the deployed CSS; a missing --color-* variable renders components unstyled in production.',
  ],
  commonFailures,
};
