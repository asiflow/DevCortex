import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DevCortexError } from '../domain/index';
import type { CortexConfig, FileKind, FileNode, ProjectGraph } from '../domain/index';
import { FeatureLedger } from '../ledgers';
import type { FeatureInput } from '../ledgers';

import { runProductGate } from './product';

// --- fixtures ---------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-product-'));
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
    stats: { fileCount: files.length, routeCount: 0, apiCount: 0, testCount: 0, riskyCount: 0 },
  };
}

/** Write a real file under the tmp repo so the gate can read it. */
async function seed(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmp, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

/** A fully-formed feature input with sensible empty defaults. */
function featureInput(overrides: Partial<FeatureInput>): FeatureInput {
  return {
    feature: 'Untitled',
    status: 'shipped',
    purpose: 'p',
    userValue: 'v',
    routes: [],
    components: [],
    apiEndpoints: [],
    databaseTables: [],
    envVars: [],
    dependencies: [],
    protectedBehaviors: [],
    acceptanceCriteria: [],
    tests: [],
    evidence: [],
    knownRisks: [],
    relatedDecisions: [],
    regressionChecks: [],
    ...overrides,
  };
}

// A finished page: renders real content, links to a real route, and its button
// submits inside a form.
const GOOD_PAGE = `export default function AboutPage() {
  return (
    <main>
      <h1>About ASIFlow</h1>
      <p>We build enterprise AGI infrastructure for regulated industries.</p>
      <a href="/contact">Contact us</a>
      <form action="/subscribe">
        <input name="email" />
        <button type="submit">Subscribe</button>
      </form>
    </main>
  );
}
`;

// A placeholder page: renders only a "Coming soon" stub.
const PLACEHOLDER_PAGE = `export default function PricingPage() {
  return <div className="p-8">Coming soon</div>;
}
`;

// A component with a fake button (no onClick / type / form) and a dead link.
const BAD_NAV = `export function Nav() {
  return (
    <nav>
      <a href="/home">Home</a>
      <a href="#">Docs</a>
      <button>Menu</button>
    </nav>
  );
}
`;

// --- the required scenario: placeholder page + fake button + dead link -------

describe('runProductGate — flags a placeholder page, a fake button, and a dead link', () => {
  it('fails the placeholder-pages, fake-buttons, and dead-links checks with backing evidence', async () => {
    await seed('app/pricing/page.tsx', PLACEHOLDER_PAGE);
    await seed('src/components/Nav.tsx', BAD_NAV);
    await seed('app/about/page.tsx', GOOD_PAGE);

    const graph = baseGraph([
      fileNode('app/pricing/page.tsx', 'page'),
      fileNode('src/components/Nav.tsx', 'component'),
      fileNode('app/about/page.tsx', 'page'),
    ]);

    const { result, evidence } = await runProductGate(tmp, graph, baseConfig());

    expect(result.gate).toBe('product');
    expect(result.passed).toBe(false);

    // One evidence item per check, and every check links to a real evidence item.
    expect(evidence).toHaveLength(result.checks.length);
    for (const check of result.checks) {
      expect(check.evidenceId).toBeDefined();
      expect(evidence.some((e) => e.id === check.evidenceId)).toBe(true);
    }

    // placeholder-pages: the "Coming soon" page fails; the finished page does not.
    const placeholder = result.checks.find((c) => c.name === 'placeholder-pages');
    expect(placeholder?.passed).toBe(false);
    expect(placeholder?.detail).toContain('app/pricing/page.tsx');
    expect(placeholder?.detail).not.toContain('app/about/page.tsx');
    const placeholderEvidence = evidence.find((e) => e.id === placeholder?.evidenceId);
    expect(placeholderEvidence?.status).toBe('refuted');

    // fake-buttons: the bare <button>Menu</button> fails; the form submit does not.
    const buttons = result.checks.find((c) => c.name === 'fake-buttons');
    expect(buttons?.passed).toBe(false);
    expect(buttons?.detail).toContain('src/components/Nav.tsx');
    expect(buttons?.detail).not.toContain('app/about/page.tsx');
    const buttonsEvidence = evidence.find((e) => e.id === buttons?.evidenceId);
    expect(buttonsEvidence?.status).toBe('refuted');

    // dead-links: the href="#" fails; the real /home and /contact links do not.
    const links = result.checks.find((c) => c.name === 'dead-links');
    expect(links?.passed).toBe(false);
    expect(links?.detail).toContain('src/components/Nav.tsx');
    expect(links?.detail).toContain('#');
    // exactly one dead link (Docs) — Home and Contact are real.
    expect(links?.detail).toContain('1 dead link finding(s)');
    const linksEvidence = evidence.find((e) => e.id === links?.evidenceId);
    expect(linksEvidence?.status).toBe('refuted');
  });
});

// --- a clean surface passes every required check ----------------------------

describe('runProductGate — a finished surface passes', () => {
  it('passes all required checks when pages and controls are real', async () => {
    await seed('app/about/page.tsx', GOOD_PAGE);
    const graph = baseGraph([fileNode('app/about/page.tsx', 'page')]);

    const { result, evidence } = await runProductGate(tmp, graph, baseConfig());

    expect(result.gate).toBe('product');
    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    for (const check of result.checks) {
      const item = evidence.find((e) => e.id === check.evidenceId);
      expect(item?.status).toBe('verified');
    }
  });
});

// --- detector coverage ------------------------------------------------------

describe('runProductGate — missing-states + placeholder detector coverage', () => {
  it('flags a client data page that shows neither loading nor error, but not a handled one', async () => {
    await seed(
      'app/feed/page.tsx',
      [
        "'use client';",
        "import { useQuery } from '@tanstack/react-query';",
        'export default function Feed() {',
        "  const { data } = useQuery({ queryKey: ['feed'], queryFn: fetchFeed });",
        '  return <ul>{data?.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;',
        '}',
        '',
      ].join('\n'),
    );
    await seed(
      'app/safe/page.tsx',
      [
        "'use client';",
        "import { useQuery } from '@tanstack/react-query';",
        'export default function Safe() {',
        "  const { data, isLoading, isError } = useQuery({ queryKey: ['s'], queryFn: fetchS });",
        '  if (isLoading) return <p>Loading…</p>;',
        '  if (isError) return <p role="alert">Failed</p>;',
        '  return <ul>{data.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;',
        '}',
        '',
      ].join('\n'),
    );
    const graph = baseGraph([
      fileNode('app/feed/page.tsx', 'page'),
      fileNode('app/safe/page.tsx', 'page'),
    ]);

    const { result } = await runProductGate(tmp, graph, baseConfig());

    const states = result.checks.find((c) => c.name === 'missing-states');
    expect(states?.passed).toBe(false);
    expect(states?.detail).toContain('app/feed/page.tsx');
    expect(states?.detail).not.toContain('app/safe/page.tsx');
  });

  it('flags an empty page that returns null', async () => {
    await seed('app/empty/page.tsx', 'export default function Empty() {\n  return null;\n}\n');
    const graph = baseGraph([fileNode('app/empty/page.tsx', 'page')]);

    const { result } = await runProductGate(tmp, graph, baseConfig());
    const placeholder = result.checks.find((c) => c.name === 'placeholder-pages');
    expect(placeholder?.passed).toBe(false);
    expect(placeholder?.detail).toContain('renders no elements');
  });

  it('does not choke on arrow-function handlers when scanning tags', async () => {
    // A `>` inside `() => a > b` must not prematurely close the tag; this button
    // has a real onClick so it must NOT be flagged as fake.
    await seed(
      'src/components/Cmp.tsx',
      'export const Cmp = () => <button onClick={() => (a > b ? x() : y())}>Go</button>;\n',
    );
    const graph = baseGraph([fileNode('src/components/Cmp.tsx', 'component')]);

    const { result } = await runProductGate(tmp, graph, baseConfig());
    const buttons = result.checks.find((c) => c.name === 'fake-buttons');
    expect(buttons?.passed).toBe(true);
  });
});

// --- acceptance criteria (FeatureLedger) ------------------------------------

describe('runProductGate — acceptance-criteria check over the FeatureLedger', () => {
  it('flags a shipped feature with no evidence but not a fully-verified one', async () => {
    const ledger = new FeatureLedger(tmp);
    await ledger.add(
      featureInput({
        feature: 'Unproven Billing',
        status: 'shipped',
        acceptanceCriteria: ['User can subscribe', 'Webhook updates status'],
        evidence: [],
      }),
    );
    await ledger.add(
      featureInput({
        feature: 'Proven Auth',
        status: 'shipped',
        acceptanceCriteria: ['User can log in'],
        evidence: [{ id: 'e1', claim: 'Login works', status: 'verified' }],
      }),
    );

    const { result } = await runProductGate(tmp, baseGraph(), baseConfig());

    const ac = result.checks.find((c) => c.name === 'acceptance-criteria');
    expect(ac?.passed).toBe(false);
    expect(ac?.detail).toContain('Unproven Billing');
    expect(ac?.detail).toContain('no backing evidence');
    expect(ac?.detail).not.toContain('Proven Auth');
  });

  it('passes when there are no feature records to check', async () => {
    const { result } = await runProductGate(tmp, baseGraph(), baseConfig());
    const ac = result.checks.find((c) => c.name === 'acceptance-criteria');
    expect(ac?.passed).toBe(true);
  });
});

// --- input validation of the gate itself ------------------------------------

describe('runProductGate — input validation', () => {
  it('throws a DevCortexError on an empty root', async () => {
    await expect(runProductGate('', baseGraph(), baseConfig())).rejects.toBeInstanceOf(
      DevCortexError,
    );
  });

  it('throws a DevCortexError on a malformed graph', async () => {
    const bad = { ...baseGraph(), files: undefined } as unknown as ProjectGraph;
    await expect(runProductGate(tmp, bad, baseConfig())).rejects.toBeInstanceOf(DevCortexError);
  });
});
