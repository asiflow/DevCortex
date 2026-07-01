import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { FileKind, FileNode, ProjectGraph } from '../domain/index';

import { runPremiumUiGate } from './premium-ui';

// --- harness ----------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-premium-ui-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function fileNode(relPath: string, kind: FileKind, tags: string[] = []): FileNode {
  return { path: relPath, kind, imports: [], importedBy: [], symbols: [], risky: false, tags };
}

function graphOf(files: FileNode[]): ProjectGraph {
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
    stats: { fileCount: files.length, routeCount: 0, apiCount: 0, testCount: 0, riskyCount: 0 },
  };
}

async function seed(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmp, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

// A weak page: fixed pixel width (no responsive breakpoints), an <img> with no
// alt, an unstyled default button, flat surfaces, no hover/focus/motion.
const WEAK_PAGE = `export default function WeakPage() {
  return (
    <div className="w-[720px] p-4">
      <img src="/hero.png" />
      <button onClick={() => submit()}>Go</button>
    </div>
  );
}`;

// A polished page: responsive breakpoints, semantic heading, alt text, a styled
// button with hover/focus, rounded corners + shadow + transition.
const POLISHED_PAGE = `export default function PolishedPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6 md:p-8 rounded-lg shadow-md transition hover:shadow-lg">
      <h1 className="text-2xl font-bold tracking-tight">Welcome</h1>
      <img src="/hero.png" alt="Product hero illustration" />
      <button
        type="button"
        className="rounded-md bg-blue-600 px-4 py-2 text-white transition duration-150 ease-out hover:bg-blue-700 focus-visible:ring"
        onClick={() => submit()}
      >
        Get started
      </button>
    </main>
  );
}`;

// --- tests ------------------------------------------------------------------

describe('runPremiumUiGate', () => {
  it('returns a UiQualityScore with every dimension and overall in 0..100', async () => {
    await seed('app/weak/page.tsx', WEAK_PAGE);
    const score = await runPremiumUiGate(tmp, graphOf([fileNode('app/weak/page.tsx', 'page')]));

    for (const dim of [
      score.visualHierarchy,
      score.mobileResponsiveness,
      score.spacingConsistency,
      score.accessibility,
      score.premiumFeel,
      score.overall,
    ]) {
      expect(dim).toBeGreaterThanOrEqual(0);
      expect(dim).toBeLessThanOrEqual(100);
      expect(Number.isFinite(dim)).toBe(true);
    }
    expect(Array.isArray(score.topFixes)).toBe(true);
  });

  it('scores a polished UI higher overall than a weak UI', async () => {
    await seed('app/weak/page.tsx', WEAK_PAGE);
    await seed('app/polished/page.tsx', POLISHED_PAGE);

    const weak = await runPremiumUiGate(tmp, graphOf([fileNode('app/weak/page.tsx', 'page')]));
    const polished = await runPremiumUiGate(
      tmp,
      graphOf([fileNode('app/polished/page.tsx', 'page')]),
    );

    expect(polished.overall).toBeGreaterThan(weak.overall);
    // The weak page has no responsive breakpoints; the polished one does.
    expect(polished.mobileResponsiveness).toBeGreaterThan(weak.mobileResponsiveness);
  });

  it('surfaces actionable topFixes for a weak UI', async () => {
    await seed('app/weak/page.tsx', WEAK_PAGE);
    const score = await runPremiumUiGate(tmp, graphOf([fileNode('app/weak/page.tsx', 'page')]));

    expect(score.topFixes.length).toBeGreaterThan(0);
    expect(score.topFixes.every((f) => typeof f === 'string' && f.length > 0)).toBe(true);
  });

  it('rejects an empty root with a thrown error (never a silent pass)', async () => {
    await expect(runPremiumUiGate('', graphOf([]))).rejects.toThrow();
  });
});
