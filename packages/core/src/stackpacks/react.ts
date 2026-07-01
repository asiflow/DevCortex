/**
 * React (SPA) + TypeScript reference stack pack.
 *
 * Real, current (2026) guidance for a client-rendered React 19 app scaffolded
 * with Vite — the non-Next.js React case (Next.js has its own pack). Covers the
 * Rules of Hooks, deriving state instead of syncing it with effects, React 19
 * form actions (useActionState / useTransition / the `use` hook), Suspense-based
 * data loading with TanStack Query, error boundaries, and the Vite client-bundle
 * secret rule (import.meta.env.VITE_*). Versions are anchored to the shipping
 * APIs: React 19.x, Vite 6.x, React Router 7.x, TanStack Query 5.x.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// A React SPA pack applies to a plain React app or a Vite app (Vite in this
// context is overwhelmingly a React/TS SPA). Next.js is served by its own pack.
const REACT_FRAMEWORKS = ['react', 'vite'];

const bestPractices: Rule[] = [
  {
    id: 'react.rules-of-hooks',
    title: 'Call hooks unconditionally at the top level of a component or custom hook',
    detail:
      'Never call a hook inside a condition, loop, early return, or nested function. React identifies hook state by call order, so a conditional hook shifts every subsequent hook and corrupts state. Put the condition inside the hook (e.g. pass enabled: false) rather than around it.',
    severity: 'high',
    appliesTo: ['component', 'lib'],
  },
  {
    id: 'react.derive-dont-sync',
    title: 'Derive state during render; do not mirror props/state into useState',
    detail:
      'Anything computable from existing props or state should be calculated during render (optionally memoised), not copied into a second useState and kept in sync with an effect. Duplicated state drifts, and the extra effect causes a second render pass. Reserve state for values that cannot be derived.',
    severity: 'medium',
    appliesTo: ['component'],
  },
  {
    id: 'react.effects-for-external-only',
    title: 'Use useEffect only to synchronise with an external system',
    detail:
      'Effects are for subscriptions, timers, imperative DOM APIs, and non-React widgets. Transforming data for rendering, resetting state on prop change, or handling user events do not need effects — do them during render or in the event handler. Fewer effects means fewer render cascades and stale-closure bugs.',
    severity: 'medium',
    appliesTo: ['component', 'lib'],
  },
  {
    id: 'react.stable-list-keys',
    title: 'Give list items a stable, identity-based key',
    detail:
      'Use a stable id (record.id) as the key for rendered lists. The array index is only safe for static, never-reordered lists; using it for sortable/filterable/insertable lists makes React reuse the wrong DOM and component state, producing swapped inputs and lost focus.',
    severity: 'medium',
    appliesTo: ['component'],
  },
  {
    id: 'react.suspense-data-lib',
    title: 'Load async data with a caching library + Suspense, not hand-rolled effects',
    detail:
      'Use TanStack Query (or Router loaders) for server state: it dedupes requests, caches, retries, and integrates with Suspense/error boundaries. Manual useEffect + useState fetching leaks race conditions (a slow response overwriting a newer one) and re-implements caching badly.',
    severity: 'medium',
    appliesTo: ['component', 'service'],
  },
  {
    id: 'react.split-context-by-frequency',
    title: 'Split context by change frequency and pass narrow values',
    detail:
      'Every consumer of a context re-renders when its value changes. Separate rarely-changing config from frequently-changing state into different providers, memoise the provider value, and prefer a state manager with selectors (Zustand/Redux Toolkit) for hot, widely-read state to avoid whole-subtree re-renders.',
    severity: 'medium',
    appliesTo: ['component', 'lib'],
  },
  {
    id: 'react.controlled-inputs',
    title: 'Keep form inputs controlled with a single source of truth',
    detail:
      'Bind inputs to state (value + onChange) or use React Hook Form as the single owner of the field value; do not mix a controlled value with uncontrolled defaultValue. Switching an input between controlled and undefined values triggers React\'s controlled/uncontrolled warning and loses edits.',
    severity: 'low',
    appliesTo: ['component'],
  },
  {
    id: 'react.error-boundaries',
    title: 'Wrap route and feature boundaries in error boundaries',
    detail:
      'A render error unmounts the whole tree unless an error boundary catches it. Place boundaries around routes and independent features (paired with Suspense fallbacks) so one failing widget degrades locally instead of blanking the app. Boundaries catch render/lifecycle errors, not event-handler errors — handle those explicitly.',
    severity: 'medium',
    appliesTo: ['component', 'page'],
  },
  {
    id: 'react.react19-actions',
    title: 'Use React 19 actions: useActionState, useTransition, and the use() hook',
    detail:
      'React 19 provides useActionState for async form submissions with pending/error state, useTransition for non-blocking updates, useOptimistic for optimistic UI, and the use() hook to read promises/context conditionally. Prefer these over manual isLoading/isError booleans for async flows.',
    severity: 'low',
    appliesTo: ['component'],
  },
  {
    id: 'react.memoise-by-measurement',
    title: 'Add memoisation based on measurement; let the React Compiler do the rest',
    detail:
      'Reach for useMemo/useCallback/React.memo when a profiled render is actually expensive or an unstable prop breaks a memoised child — not reflexively. The React Compiler (React 19) auto-memoises correct components; premature manual memoisation adds noise and can hide dependency bugs.',
    severity: 'low',
    appliesTo: ['component'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'react.anti.effect-derived-state',
    title: 'Syncing derived state into useState via useEffect',
    detail:
      'const [full, setFull] = useState(); useEffect(() => setFull(first + last), [first, last]) renders twice and can flash stale data. Compute const full = first + last during render instead; only store it in state if it is genuinely independent user-editable state.',
    severity: 'medium',
    appliesTo: ['component'],
  },
  {
    id: 'react.anti.index-key',
    title: 'Using the array index as the key for a dynamic list',
    detail:
      'key={index} on a list that can reorder, filter, or splice makes React associate state with position instead of identity, so deleting the first row visually deletes the last, and inputs keep the wrong values. Key by a stable record id.',
    severity: 'medium',
    appliesTo: ['component'],
  },
  {
    id: 'react.anti.conditional-hook',
    title: 'Calling a hook conditionally or inside a loop',
    detail:
      'if (open) useEffect(...) or a hook after an early return changes the number/order of hooks between renders and throws "Rendered fewer/more hooks than expected". Move the hook above the branch and make the condition an argument.',
    severity: 'high',
    appliesTo: ['component', 'lib'],
  },
  {
    id: 'react.anti.giant-context',
    title: 'One monolithic context that re-renders the whole tree',
    detail:
      'Stuffing all app state into a single Context provider means any change re-renders every consumer. Split contexts, memoise the value, or move hot state into a selector-based store so components only re-render on the slice they read.',
    severity: 'medium',
    appliesTo: ['component', 'lib'],
  },
  {
    id: 'react.anti.fetch-waterfall',
    title: 'Sequential fetch-in-useEffect waterfalls',
    detail:
      'Awaiting one request in an effect, then triggering the next from its result, serialises independent network calls and shows nested spinners. Fetch in parallel (Promise.all / independent queries) and hoist loading to a Suspense boundary.',
    severity: 'medium',
    appliesTo: ['component', 'service'],
  },
  {
    id: 'react.anti.direct-dom-mutation',
    title: 'Mutating the DOM directly or reading refs during render',
    detail:
      'document.querySelector(...).style = ... or reading ref.current during render fights React\'s reconciliation and breaks on re-render. Express UI as state, and confine imperative DOM work to a ref callback or an effect that runs after commit.',
    severity: 'medium',
    appliesTo: ['component'],
  },
  {
    id: 'react.anti.setstate-in-render',
    title: 'Calling setState unconditionally during render',
    detail:
      'setState in the render body (not in an event handler or effect, and without a guard) causes "Too many re-renders" as React re-runs render, sets state, and loops. Move the update into an event handler or guard it so it only fires on a real change.',
    severity: 'high',
    appliesTo: ['component'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'react',
    supported: '^19',
    note: 'React 19: stable Actions, useActionState/useOptimistic, the use() hook, ref-as-a-prop, and the React Compiler. react and react-dom must share the exact same major.',
  },
  {
    pkg: 'react-dom',
    supported: '^19',
    note: 'Must match the react major exactly; a react/react-dom skew is the classic cause of invalid-hook-call and hydration errors.',
  },
  {
    pkg: 'vite',
    supported: '^6',
    note: 'Vite 6.x with @vitejs/plugin-react (or plugin-react-swc). Client env vars must be prefixed VITE_ to be exposed to the bundle — everything else stays server/build-only.',
  },
  {
    pkg: 'react-router',
    supported: '^7',
    note: 'React Router 7 (the merged Remix core) — use route loaders/actions for data where possible instead of effect-based fetching.',
  },
  {
    pkg: '@tanstack/react-query',
    supported: '^5',
    note: 'TanStack Query 5 for server-state caching, dedupe, retries, and Suspense integration; the object-form useQuery({ queryKey, queryFn }) API.',
  },
  {
    pkg: 'typescript',
    supported: '^5',
    note: 'TypeScript 5.x for satisfies, const type parameters, and the strict flags (noUncheckedIndexedAccess, verbatimModuleSyntax) this stack assumes.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'react.fail.invalid-hook-call',
    signature: 'Error: Invalid hook call. Hooks can only be called inside the body of a function component',
    cause:
      'Usually two copies of React in the bundle (a mismatched react/react-dom or a duplicated dependency), a hook called outside a component, or breaking the Rules of Hooks.',
    fix: 'Ensure a single react/react-dom of the same major (dedupe the lockfile), call hooks only at the top level of components/custom hooks, and check that a library peer-depends on your React rather than bundling its own.',
  },
  {
    id: 'react.fail.max-update-depth',
    signature: 'Warning: Maximum update depth exceeded / "Too many re-renders. React limits the number of renders"',
    cause: 'setState is called during render, or an effect updates state on every run because its dependency is a new object/array each render.',
    fix: 'Move the update into an event handler, guard it so it only runs on a real change, and stabilise effect dependencies (memoise objects/arrays or depend on primitive values).',
  },
  {
    id: 'react.fail.stale-closure',
    signature: 'An effect or event handler reads an old value of state/props after it has changed',
    cause: 'A useEffect/useCallback closed over a value but omitted it from the dependency array, so it captured the value from the render it was created in.',
    fix: 'List every reactive value the callback reads in the dependency array (let the react-hooks/exhaustive-deps lint rule enforce it), or use a functional updater setX(prev => ...) / a ref for values you intentionally read latest.',
  },
  {
    id: 'react.fail.hydration-mismatch',
    signature: 'Warning: Text content did not match / "Hydration failed because the server rendered HTML didn\'t match the client"',
    cause: 'Render output depends on non-deterministic or client-only values (Date.now(), Math.random(), locale, window/localStorage) that differ between the server and the first client render.',
    fix: 'Render deterministically on first paint and move client-only values into an effect (or a mounted flag), so the initial client render matches the server HTML.',
  },
  {
    id: 'react.fail.missing-key-warning',
    signature: 'Warning: Each child in a list should have a unique "key" prop',
    cause: 'A mapped array rendered elements without a key, so React cannot track identity across renders and re-mounts items (losing input state and focus).',
    fix: 'Add key={item.id} using a stable identifier on the outermost element of each iteration; do not fall back to the index for reorderable lists.',
  },
  {
    id: 'react.fail.act-warning',
    signature: 'Warning: An update to Component inside a test was not wrapped in act(...)',
    cause: 'A test triggered an async state update (a resolved promise/timer) that settled after the assertion, outside React\'s act() batching.',
    fix: 'Use @testing-library/react\'s async utilities (findBy*, await waitFor, userEvent) so updates are flushed inside act, and await all pending promises before asserting.',
  },
];

/**
 * The React (SPA) + TypeScript reference pack. Matches a plain React or Vite
 * detected stack (Next.js is served by nextjsPack).
 */
export const reactPack: StackPack = {
  id: 'react-typescript',
  name: 'React 19 + TypeScript (Vite SPA)',
  matches: (stack) => REACT_FRAMEWORKS.includes(stack.framework),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'react@^19',
    'react-dom@^19',
    'typescript@^5',
    'vite@^6',
    '@vitejs/plugin-react@^4',
    'react-router@^7',
    '@tanstack/react-query@^5',
    'zod@^3',
    'react-hook-form@^7',
    '@hookform/resolvers@^3',
    'zustand@^5',
    'vitest@^2',
    '@testing-library/react@^16',
    '@testing-library/user-event@^14',
    '@playwright/test@^1',
  ],
  versionChecks,
  setupCommands: [
    'pnpm create vite@latest my-app --template react-ts',
    'pnpm add react-router @tanstack/react-query',
    'pnpm add zod react-hook-form @hookform/resolvers zustand',
    'pnpm add -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom',
    'pnpm add -D @playwright/test',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec eslint .',
    'pnpm exec vitest run',
    'pnpm exec playwright test',
  ],
  qualityGates: [
    'Typecheck passes under strict TS: `tsc --noEmit` reports zero errors.',
    'ESLint passes, including react-hooks/rules-of-hooks and react-hooks/exhaustive-deps with no errors.',
    '`vite build` completes with no unresolved imports and no duplicate React in the bundle.',
    'No secret is exposed through a VITE_-prefixed env var (audit the built assets).',
    'Every rendered list uses a stable identity key; no index keys on dynamic lists.',
    'Async data flows go through TanStack Query / router loaders with error + loading states, not bare useEffect fetches.',
    'Unit + component tests are green; critical user flows are covered by Playwright E2E.',
  ],
  securityNotes: [
    'Vite inlines every import.meta.env.VITE_-prefixed variable into the client bundle at build time — never put an API secret, service key, or private token behind the VITE_ prefix.',
    'A React SPA runs entirely in the browser: it has no trusted server boundary of its own, so all real authorization must be enforced by the API it calls, never by hiding UI.',
    'Avoid dangerouslySetInnerHTML; if you must render HTML, sanitise it (e.g. DOMPurify) to prevent XSS. Never inject unsanitised user content into innerHTML.',
    'Do not build href/src from untrusted input without validating the scheme — javascript: and data: URLs enable script execution.',
    'Keep access tokens out of localStorage where practical (XSS-readable); prefer httpOnly cookies set by the backend for session credentials.',
    'Pin and audit dependencies (a compromised transitive dep runs in every user\'s browser); enable a Content-Security-Policy at the hosting layer.',
  ],
  deploymentNotes: [
    'Build to static assets (`vite build` → dist/) and serve from a CDN; the app is fully client-rendered with no Node server required.',
    'Configure a SPA history fallback (rewrite unknown paths to /index.html) so client-side routes deep-link correctly.',
    'VITE_ env vars are baked in at build time per environment — rebuild to change them; they are not runtime-configurable.',
    'Set long-lived immutable cache headers on hashed asset filenames and a short/no-cache header on index.html so new deploys are picked up.',
    'Serve over HTTPS with a Content-Security-Policy and standard security headers (X-Content-Type-Options, Referrer-Policy) at the CDN/host.',
  ],
  commonFailures,
};
