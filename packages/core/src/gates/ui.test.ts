import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DevCortexError } from '../domain/index';
import type { CortexConfig, FileKind, FileNode, ProjectGraph } from '../domain/index';

import { runUiGate } from './ui';

// --- fixtures ---------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-ui-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    schemaVersion: 1,
    mode: 'guarded',
    privacy: 'local-only',
    risk: { protectedPaths: [], floors: {} },
    gates: { typecheck: true, lint: true, build: true, test: true, blockUnprovenDone: true },
    stackPacks: [],
    commands: {},
    ...overrides,
  };
}

function fileNode(relPath: string, kind: FileKind, tags: string[] = []): FileNode {
  return { path: relPath, kind, imports: [], importedBy: [], symbols: [], risky: false, tags };
}

function baseGraph(files: FileNode[] = []): ProjectGraph {
  return {
    schemaVersion: 1,
    root: tmp,
    generatedAt: new Date().toISOString(),
    stack: {
      framework: 'nextjs',
      language: 'typescript',
      packageManager: 'pnpm',
      monorepo: false,
      deploymentTargets: [],
    },
    files,
    routes: [],
    envVars: [],
    scripts: {},
    riskyFiles: [],
    stats: {
      fileCount: files.length,
      routeCount: 0,
      apiCount: 0,
      testCount: 0,
      riskyCount: 0,
    },
  };
}

/** Write a real file under the tmp repo so the gate can read it. */
async function seed(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmp, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

// A well-built component: responsive, handles loading/empty/error, accessible,
// keyboard-safe, and dark-mode consistent.
const GOOD = `'use client';
import { useQuery } from '@tanstack/react-query';
import { RefreshIcon } from './icons';

export function GoodPanel() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['items'], queryFn: fetchItems });

  if (isLoading) return <div role="status" aria-busy="true">Loading…</div>;
  if (isError) return <div role="alert">Something went wrong</div>;
  if (!data || data.length === 0) return <p>No items yet</p>;

  return (
    <section className="flex flex-col gap-4 sm:flex-row md:gap-6 bg-white dark:bg-black text-black dark:text-white">
      <img src="/logo.png" alt="Company logo" />
      <button type="button" onClick={() => refresh()} aria-label="Refresh list">
        <RefreshIcon />
      </button>
      <ul>
        {data.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </section>
  );
}
`;

// A poorly-built component: fixed-width non-responsive layout, no loading/empty/
// error handling, an <img> with no alt, and a clickable <div> with neither role
// nor keyboard handler. Sets colours but ships no dark: variant.
const BAD = `'use client';
import { useQuery } from '@tanstack/react-query';

export function BadPanel() {
  const { data } = useQuery({ queryKey: ['items'], queryFn: fetchItems });

  return (
    <div className="flex bg-white text-black p-4" style={{ width: 640 }}>
      <img src="/logo.png" />
      <div onClick={() => open()}>Open</div>
      {data.map((r) => (
        <span key={r.id}>{r.name}</span>
      ))}
    </div>
  );
}
`;

// --- a repo with one good and one bad component -----------------------------

describe('runUiGate — flags a badly-built component and not a well-built one', () => {
  it('fails the required checks against the bad component, backed by evidence', async () => {
    await seed('src/components/GoodPanel.tsx', GOOD);
    await seed('src/components/BadPanel.tsx', BAD);

    const graph = baseGraph([
      fileNode('src/components/GoodPanel.tsx', 'component'),
      fileNode('src/components/BadPanel.tsx', 'component'),
    ]);

    const { result, evidence } = await runUiGate(tmp, graph, baseConfig());

    expect(result.gate).toBe('ui');
    expect(result.passed).toBe(false);

    // One evidence item per check, and every check links to a real evidence item.
    expect(evidence).toHaveLength(result.checks.length);
    for (const check of result.checks) {
      expect(check.evidenceId).toBeDefined();
      expect(evidence.some((e) => e.id === check.evidenceId)).toBe(true);
    }

    // responsive: fixed 640px width + no breakpoints → fails, names the bad file.
    const responsive = result.checks.find((c) => c.name === 'responsive');
    expect(responsive?.passed).toBe(false);
    expect(responsive?.detail).toContain('src/components/BadPanel.tsx');
    expect(responsive?.detail).toContain('640px');
    const responsiveEvidence = evidence.find((e) => e.id === responsive?.evidenceId);
    expect(responsiveEvidence?.status).toBe('refuted');

    // data-states: fetches but handles none of loading/empty/error → fails.
    const states = result.checks.find((c) => c.name === 'data-states');
    expect(states?.passed).toBe(false);
    expect(states?.detail).toContain('src/components/BadPanel.tsx');
    expect(states?.detail).toContain('loading');

    // accessibility: <img> with no alt + clickable div with no role → fails.
    const a11y = result.checks.find((c) => c.name === 'accessibility');
    expect(a11y?.passed).toBe(false);
    expect(a11y?.detail).toContain('src/components/BadPanel.tsx');
    expect(a11y?.detail).toContain('alt');

    // keyboard-nav: clickable div with no keyboard handler → fails.
    const keyboard = result.checks.find((c) => c.name === 'keyboard-nav');
    expect(keyboard?.passed).toBe(false);
    expect(keyboard?.detail).toContain('src/components/BadPanel.tsx');

    // dark-mode (soft): project uses dark: (good file) so the bad file is flagged.
    const dark = result.checks.find((c) => c.name === 'dark-mode');
    expect(dark?.passed).toBe(false);
    expect(dark?.detail).toContain('src/components/BadPanel.tsx');

    // The well-built component must not appear in ANY failing check's detail.
    for (const check of result.checks) {
      if (!check.passed) {
        expect(check.detail).not.toContain('src/components/GoodPanel.tsx');
      }
    }
  });
});

// --- a repo with only the good component passes -----------------------------

describe('runUiGate — a clean surface passes every required check', () => {
  it('passes all required checks when the only component is well-built', async () => {
    await seed('src/components/GoodPanel.tsx', GOOD);
    const graph = baseGraph([fileNode('src/components/GoodPanel.tsx', 'component')]);

    const { result, evidence } = await runUiGate(tmp, graph, baseConfig());

    expect(result.gate).toBe('ui');
    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    for (const check of result.checks) {
      const item = evidence.find((e) => e.id === check.evidenceId);
      expect(item?.status).toBe('verified');
    }
  });
});

// --- detector coverage ------------------------------------------------------

describe('runUiGate — accessibility detector coverage', () => {
  it('flags an icon-only button and an unlabeled input, but not accessible ones', async () => {
    await seed(
      'src/components/Controls.tsx',
      [
        'export function Controls() {',
        '  return (',
        '    <form>',
        '      <button onClick={() => save()}><SaveIcon /></button>',
        '      <button onClick={() => close()} aria-label="Close">',
        '        <CloseIcon />',
        '      </button>',
        '      <input name="email" type="email" />',
        '      <label htmlFor="q">Query</label>',
        '      <input id="q" type="text" />',
        '    </form>',
        '  );',
        '}',
        '',
      ].join('\n'),
    );
    const graph = baseGraph([fileNode('src/components/Controls.tsx', 'component')]);

    const { result } = await runUiGate(tmp, graph, baseConfig());

    const a11y = result.checks.find((c) => c.name === 'accessibility');
    expect(a11y?.passed).toBe(false);
    // The icon-only button with no aria-label is flagged.
    expect(a11y?.detail).toContain('accessible text or aria-label');
    // The unlabeled email input is flagged; the htmlFor-associated one is not.
    expect(a11y?.detail).toContain('associated label');
    // Exactly two findings: the icon button + the unlabeled input (Close button
    // and the labeled input are accessible).
    expect(a11y?.detail).toContain('2 accessibility finding(s)');
  });

  it('does not choke on arrow-function handlers when scanning tags', async () => {
    // A `>` inside `() => a > b` must not prematurely close the tag.
    await seed(
      'src/components/Cmp.tsx',
      'export const Cmp = () => <button aria-label="go" onClick={() => (a > b ? x() : y())}>Go</button>;\n',
    );
    const graph = baseGraph([fileNode('src/components/Cmp.tsx', 'component')]);

    const { result } = await runUiGate(tmp, graph, baseConfig());
    const a11y = result.checks.find((c) => c.name === 'accessibility');
    expect(a11y?.passed).toBe(true);
  });
});

// --- input validation of the gate itself ------------------------------------

describe('runUiGate — input validation', () => {
  it('throws a DevCortexError on an empty root', async () => {
    await expect(runUiGate('', baseGraph(), baseConfig())).rejects.toBeInstanceOf(DevCortexError);
  });

  it('throws a DevCortexError on a malformed graph', async () => {
    const bad = { ...baseGraph(), files: undefined } as unknown as ProjectGraph;
    await expect(runUiGate(tmp, bad, baseConfig())).rejects.toBeInstanceOf(DevCortexError);
  });
});
