/**
 * Senior Engineer Council tests (§7.14) — no mocks.
 *
 * `convene` is exercised as a deterministic mapping table (task/risk -> lenses),
 * and `review` is run end-to-end against a freshly `mkdtemp`'d repository that is
 * really scanned into a ProjectGraph. Findings are asserted against seeded,
 * concrete issues (a committed secret, an untested risky file, a layering
 * inversion, an inaccessible image, placeholder copy, …) and a deliberately clean
 * repo proves the council stays silent when there is nothing to say.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DevCortexError, REVIEWER_LENSES } from '../domain/index';
import type { CortexConfig, CouncilFinding, ProjectGraph, ReviewerLens } from '../domain/index';
import { scanProject } from '../graph/index';
import { defaultConfig } from '../workspace/index';

import { canonicalizeLenses, convene, review } from './index';

// --- convene: deterministic mapping table ------------------------------------

describe('convene', () => {
  it('maps task type + risk to the expected lenses (billing draws security + devops)', () => {
    const table: ReadonlyArray<{ task: Parameters<typeof convene>[0]; risk: Parameters<typeof convene>[1]; lenses: ReviewerLens[] }> = [
      { task: 'billing', risk: 'low', lenses: ['architect', 'security', 'qa', 'devops'] },
      { task: 'ui', risk: 'low', lenses: ['frontend', 'ui-ux'] },
      { task: 'auth', risk: 'low', lenses: ['architect', 'security', 'qa'] },
      { task: 'docs', risk: 'low', lenses: ['documentation'] },
      { task: 'chore', risk: 'low', lenses: [] },
      // Risk escalation is additive and independent of task type.
      { task: 'chore', risk: 'critical', lenses: ['architect', 'security', 'qa', 'devops', 'documentation'] },
      { task: 'bugfix', risk: 'high', lenses: ['security', 'qa', 'devops'] },
    ];

    for (const row of table) {
      expect(convene(row.task, row.risk)).toEqual(row.lenses);
    }

    // The design's worked example, spelled out explicitly.
    const billing = convene('billing', 'low');
    expect(billing).toContain('security');
    expect(billing).toContain('devops');
  });

  it('is deduped and returned in canonical order', () => {
    expect(canonicalizeLenses(['qa', 'architect', 'qa', 'security', 'architect'])).toEqual([
      'architect',
      'security',
      'qa',
    ]);
  });

  it('throws INTERNAL on an unknown task type or risk level', () => {
    expect(() => convene('nope' as Parameters<typeof convene>[0], 'low')).toThrow(DevCortexError);
    expect(() => convene('billing', 'apocalyptic' as Parameters<typeof convene>[1])).toThrow(
      DevCortexError,
    );
  });
});

// --- review: end-to-end over a real scanned repo -----------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-council-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

/** 600 harmless lines / ~40 KB — trips both the oversized and large-module checks. */
function bigModule(): string {
  return Array.from(
    { length: 600 },
    (_, i) => `export const value_${i} = ${i}; // ${'padding-'.repeat(6)}`,
  ).join('\n');
}

/** Seed a repo containing one instance of every issue the council can find. */
async function seedIssueRepo(): Promise<{ graph: ProjectGraph; config: CortexConfig }> {
  await seed({
    'package.json': JSON.stringify({ name: 'seed', version: '1.0.0', scripts: { test: 'vitest' } }),
    // security: a committed Stripe secret in a risky (billing) file.
    'src/lib/stripe.ts':
      'export const stripeKey = "sk_' + 'live_ABCDEFGHIJKLMNOPQRSTUVWX0123";\nexport function charge() {\n  return stripeKey;\n}\n',
    // stripe.ts is covered by a test, so qa must NOT flag it.
    'src/lib/stripe.test.ts': "import { charge } from './stripe';\nit('charges', () => charge());\n",
    // qa: a risky (auth) file with no test.
    'src/auth/session.ts':
      'export function createSession(userId: string) {\n  return { userId, issuedAt: Date.now() };\n}\n',
    // security: a secret exposed through a NEXT_PUBLIC_ var.
    'src/config/public-config.ts': 'export const apiSecret = process.env.NEXT_PUBLIC_API_SECRET;\n',
    // security: a server secret read inside a client component.
    'src/components/Dashboard.tsx':
      "'use client';\nexport function Dashboard() {\n  const token = process.env.DATABASE_PASSWORD;\n  return <div>{token}</div>;\n}\n",
    // frontend: unsafe raw HTML.
    'src/components/RichText.tsx':
      'export function RichText({ html }: { html: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}\n',
    // ui-ux: an image without alt text.
    'src/components/Avatar.tsx':
      'export function Avatar({ src }: { src: string }) {\n  return <img src={src} />;\n}\n',
    // product: placeholder copy + a dead link.
    'src/components/Landing.tsx':
      'export function Landing() {\n  return (\n    <section>\n      <p>Lorem ipsum dolor sit amet.</p>\n      <a href="#">Learn more</a>\n    </section>\n  );\n}\n',
    // architecture + performance: an oversized, large module.
    'src/lib/huge.ts': bigModule(),
    // architecture: a lib file importing the UI layer (layering inversion).
    'src/lib/widget-helper.ts':
      "import { Avatar } from '../components/Avatar';\nexport function render() {\n  return Avatar;\n}\n",
    // (no README, no Dockerfile, no CI — documentation + devops findings)
  });

  const graph = await scanProject(root);
  return { graph, config: defaultConfig(graph.stack) };
}

function forLens(findings: CouncilFinding[], lens: ReviewerLens): CouncilFinding[] {
  return findings.filter((f) => f.lens === lens);
}

describe('review — focused security + qa', () => {
  it('flags a hardcoded secret and an untested risky file, but not a tested one', async () => {
    const { graph, config } = await seedIssueRepo();

    const report = await review(root, graph, config, ['qa', 'security']);

    // Convened lenses are deduped + canonical (security before qa).
    expect(report.lenses).toEqual(['security', 'qa']);
    expect(report.task).toContain('project review');
    expect(report.generatedAt).toMatch(/\dT\d/);

    const secret = forLens(report.findings, 'security').find(
      (f) => f.title === 'Hardcoded secret in source',
    );
    expect(secret).toBeDefined();
    expect(secret?.severity).toBe('critical');
    expect(secret?.file).toBe('src/lib/stripe.ts');
    // The finding must not echo the secret value itself.
    expect(secret?.detail).not.toContain('sk_' + 'live_');

    const qa = forLens(report.findings, 'qa');
    expect(qa).toHaveLength(1);
    expect(qa[0]?.file).toBe('src/auth/session.ts');
    expect(qa[0]?.severity).toBe('high'); // default gates.test === true
    expect(qa.some((f) => f.file === 'src/lib/stripe.ts')).toBe(false);
  });
});

describe('review — full council', () => {
  it('runs every convened lens and emits each expected finding', async () => {
    const { graph, config } = await seedIssueRepo();

    const report = await review(root, graph, config, [...REVIEWER_LENSES]);

    // All lenses convened, in canonical order.
    expect(report.lenses).toEqual([...REVIEWER_LENSES]);
    // Deterministic ordering: architect (rank 0) sorts first.
    expect(report.findings[0]?.lens).toBe('architect');

    const titles = (lens: ReviewerLens): string[] => forLens(report.findings, lens).map((f) => f.title);
    const files = (lens: ReviewerLens): Array<string | undefined> =>
      forLens(report.findings, lens).map((f) => f.file);

    // security: three distinct classes of finding.
    expect(titles('security')).toEqual(
      expect.arrayContaining([
        'Hardcoded secret in source',
        'Secret exposed via NEXT_PUBLIC_ env var',
        'Server secret read in a client component',
      ]),
    );
    expect(files('security')).toEqual(expect.arrayContaining(['src/components/Dashboard.tsx']));

    // devops: undocumented env + missing Dockerfile + missing CI.
    expect(titles('devops')).toEqual(
      expect.arrayContaining([
        'Undocumented environment variables',
        'No Dockerfile found',
        'No CI configuration found',
      ]),
    );

    // architect: oversized file + layering inversion.
    expect(titles('architect')).toEqual(
      expect.arrayContaining(['Oversized source file', 'Layering inversion']),
    );
    expect(forLens(report.findings, 'architect').find((f) => f.title === 'Layering inversion')?.file).toBe(
      'src/lib/widget-helper.ts',
    );

    // frontend / ui-ux / performance / product / documentation.
    expect(files('frontend')).toEqual(['src/components/RichText.tsx']);
    expect(files('ui-ux')).toEqual(['src/components/Avatar.tsx']);
    expect(files('performance')).toEqual(['src/lib/huge.ts']);
    expect(files('product')).toEqual(['src/components/Landing.tsx']);
    expect(titles('documentation')).toEqual(['No repository README']);

    // Every finding carries a real, non-empty detail string.
    expect(report.findings.every((f) => f.detail.length > 0)).toBe(true);
  });
});

describe('review — clean repository stays silent', () => {
  it('emits no findings when nothing is wrong', async () => {
    await seed({
      'package.json': JSON.stringify({ name: 'clean', version: '1.0.0', scripts: { test: 'vitest' } }),
      'README.md': '# Clean\n\nSetup, usage, and architecture are documented here.\n',
      Dockerfile: 'FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "index.js"]\n',
      '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
      '.env.example': 'SESSION_SECRET=replace-me\n',
      'src/auth/login.ts':
        'export function login() {\n  return process.env.SESSION_SECRET;\n}\n',
      'src/auth/login.test.ts': "import { login } from './login';\nit('logs in', () => login());\n",
    });

    const graph = await scanProject(root);
    const report = await review(root, graph, defaultConfig(graph.stack), [...REVIEWER_LENSES]);

    expect(report.findings).toEqual([]);
  });
});

describe('review — validation', () => {
  it('throws INTERNAL on an unknown reviewer lens', async () => {
    const graph = await scanProject(root);
    await expect(
      review(root, graph, defaultConfig(graph.stack), ['not-a-lens' as ReviewerLens]),
    ).rejects.toBeInstanceOf(DevCortexError);
  });

  it('throws INTERNAL on a structurally invalid graph', async () => {
    await expect(
      review(root, {} as unknown as ProjectGraph, defaultConfig(), ['security']),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('throws INTERNAL on an empty root', async () => {
    const graph = await scanProject(root);
    await expect(review('', graph, defaultConfig(graph.stack), ['qa'])).rejects.toBeInstanceOf(
      DevCortexError,
    );
  });
});
