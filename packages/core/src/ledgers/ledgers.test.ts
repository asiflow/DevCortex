/**
 * Ledger tests — real filesystem CRUD against a freshly mkdtemp'd repo root.
 *
 * Each ledger is self-initializing (it creates its own `.cortex/` subdir on the
 * first write), so these tests exercise the production path directly: no mocks,
 * real JSON files on disk, real zod validation on every read and write.
 *
 * Note on setup: the Wave-1 workspace barrel (`../workspace`) is still being
 * assembled in parallel, so `initWorkspace` is not yet exported. The ledgers do
 * not depend on it — `add` mkdir's its backing directory on demand — so the
 * fixtures only need a temp root. We still assert the on-disk layout matches
 * `workspacePaths(root)` to prove the ledgers write under the canonical
 * `.cortex/<kind>/` directories `initWorkspace` will later pre-create.
 */
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workspacePaths } from '../workspace/paths';
import { LedgerError, SchemaValidationError, isDevCortexError } from '../domain/index';
import type {
  DecisionRecord,
  EvidenceItem,
  EvidenceRef,
  FeatureRecord,
  MemoryItem,
} from '../domain/index';

import { DecisionLedger } from './decision-ledger';
import { EvidenceLedger } from './evidence-ledger';
import { FeatureLedger } from './feature-ledger';
import { MemoryLedger } from './memory-ledger';
import type { DecisionInput, FeatureInput, MemoryInput } from './index';
import type { EvidenceInput } from './evidence-ledger';

// --- fixtures ----------------------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-ledgers-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sampleEvidenceRef: EvidenceRef = {
  id: 'ev-ref-1',
  claim: 'typecheck passes',
  status: 'verified',
};

function memoryInput(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    type: 'decision',
    title: 'Use RS256 for service JWTs',
    summary: 'All inter-service tokens are signed with RS256.',
    source: 'architecture-review',
    confidence: 0.9,
    evidence: [sampleEvidenceRef],
    relatedFiles: ['src/auth/jwt.ts'],
    relatedFeatures: [],
    riskLevel: 'high',
    ...overrides,
  };
}

function featureInput(overrides: Partial<FeatureInput> = {}): FeatureInput {
  return {
    feature: 'Subscription billing',
    status: 'planned',
    purpose: 'Let teams pay for the product.',
    userValue: 'Self-serve upgrades.',
    routes: ['/billing'],
    components: ['BillingPanel'],
    apiEndpoints: ['/api/billing/checkout'],
    databaseTables: ['subscriptions'],
    envVars: ['STRIPE_SECRET_KEY'],
    dependencies: ['stripe'],
    protectedBehaviors: ['webhook signature verification'],
    acceptanceCriteria: ['checkout creates a subscription'],
    tests: ['billing.e2e.ts'],
    evidence: [],
    knownRisks: ['double-charge on retry'],
    relatedDecisions: [],
    regressionChecks: ['existing free plan unaffected'],
    ...overrides,
  };
}

function decisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    decision: 'Adopt Apollo Federation v2',
    context: 'We need composable subgraphs.',
    optionsConsidered: ['Federation v1', 'Federation v2', 'schema stitching'],
    chosenOption: 'Federation v2',
    reason: '@link-based composition and @shareable opt-in.',
    tradeoffs: ['router migration effort'],
    affectedFiles: ['src/graphql/schema.ts'],
    status: 'accepted',
    ...overrides,
  };
}

function evidenceInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    claim: 'build succeeds',
    status: 'verified',
    kind: 'build',
    detail: 'tsc --noEmit exited 0',
    command: 'pnpm build',
    exitCode: 0,
    output: 'Build complete.',
    ...overrides,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// --- MemoryLedger ------------------------------------------------------------

describe('MemoryLedger', () => {
  it('add generates id + timestamps, validates, persists, and returns the record', async () => {
    const ledger = new MemoryLedger(root);
    const created = await ledger.add(memoryInput());

    expect(created.id).toMatch(UUID_RE);
    expect(created.createdAt).toMatch(ISO_RE);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(created.title).toBe('Use RS256 for service JWTs');

    // one JSON file per entry, under the canonical .cortex/memory dir
    const file = path.join(workspacePaths(root).memoryDir, `${created.id}.json`);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as MemoryItem;
    expect(onDisk).toEqual(created);
  });

  it('get returns a stored item and undefined for an unknown id', async () => {
    const ledger = new MemoryLedger(root);
    const created = await ledger.add(memoryInput());

    expect(await ledger.get(created.id)).toEqual(created);
    expect(await ledger.get(crypto.randomUUID())).toBeUndefined();
  });

  it('list/all return every entry and list applies a predicate', async () => {
    const ledger = new MemoryLedger(root);
    const a = await ledger.add(memoryInput({ type: 'risk', riskLevel: 'critical' }));
    const b = await ledger.add(memoryInput({ type: 'fact', riskLevel: 'low' }));

    const all = await ledger.all();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());

    const risks = await ledger.list((m) => m.type === 'risk');
    expect(risks).toHaveLength(1);
    expect(risks[0]?.id).toBe(a.id);
  });

  it('update applies a patch, bumps updatedAt, and preserves id + createdAt', async () => {
    const ledger = new MemoryLedger(root);
    const created = await ledger.add(memoryInput({ confidence: 0.5 }));

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await ledger.update(created.id, { confidence: 0.95, riskLevel: 'critical' });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(updated.confidence).toBe(0.95);
    expect(updated.riskLevel).toBe('critical');
    expect(await ledger.get(created.id)).toEqual(updated);
  });

  it('update throws LedgerError for a non-existent id', async () => {
    const ledger = new MemoryLedger(root);
    await expect(ledger.update(crypto.randomUUID(), { confidence: 0.1 })).rejects.toBeInstanceOf(
      LedgerError,
    );
  });

  it('rejects schema-invalid input with SchemaValidationError before writing', async () => {
    const ledger = new MemoryLedger(root);
    // confidence is typed as number but the schema bounds it to 0..1.
    await expect(ledger.add(memoryInput({ confidence: 5 }))).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    // nothing should have been written
    expect(await ledger.all()).toHaveLength(0);
  });

  it('throws LedgerError when a stored file contains invalid JSON', async () => {
    const ledger = new MemoryLedger(root);
    const dir = workspacePaths(root).memoryDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'broken.json'), '{ this is not json', 'utf8');

    await expect(ledger.all()).rejects.toBeInstanceOf(LedgerError);
    await expect(ledger.get('broken')).rejects.toBeInstanceOf(LedgerError);
  });

  it('throws LedgerError when a stored file is valid JSON but fails the schema', async () => {
    const ledger = new MemoryLedger(root);
    const dir = workspacePaths(root).memoryDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'wrong-shape.json'), JSON.stringify({ id: 'x' }), 'utf8');

    let caught: unknown;
    try {
      await ledger.all();
    } catch (err) {
      caught = err;
    }
    expect(isDevCortexError(caught)).toBe(true);
    expect((caught as LedgerError).code).toBe('LEDGER_CORRUPT');
  });

  it('rejects unsafe ids that could escape the ledger directory', async () => {
    const ledger = new MemoryLedger(root);
    await expect(ledger.get('../escape')).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(ledger.get('')).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('persists writes atomically: temp-file + rename leaves no partial or temp files', async () => {
    const ledger = new MemoryLedger(root);
    const created = await ledger.add(memoryInput());
    const dir = workspacePaths(root).memoryDir;

    // after add: exactly the one entry file, no temp/dotfile leftovers
    let names = await readdir(dir);
    expect(names).toEqual([`${created.id}.json`]);
    expect(await ledger.get(created.id)).toEqual(created);

    // update overwrites in place, still atomically, still exactly one file
    const updated = await ledger.update(created.id, { confidence: 0.99 });
    names = await readdir(dir);
    expect(names).toEqual([`${created.id}.json`]);
    expect(names.some((n) => n.endsWith('.tmp') || n.startsWith('.'))).toBe(false);
    expect(await ledger.get(created.id)).toEqual(updated);
  });
});

// --- FeatureLedger -----------------------------------------------------------

describe('FeatureLedger', () => {
  it('add generates id + updatedAt and persists under .cortex/features', async () => {
    const ledger = new FeatureLedger(root);
    const created = await ledger.add(featureInput());

    expect(created.id).toMatch(UUID_RE);
    expect(created.updatedAt).toMatch(ISO_RE);
    expect(created.feature).toBe('Subscription billing');

    const file = path.join(workspacePaths(root).featuresDir, `${created.id}.json`);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as FeatureRecord;
    expect(onDisk).toEqual(created);
  });

  it('supports get/list/all and update', async () => {
    const ledger = new FeatureLedger(root);
    const planned = await ledger.add(featureInput({ status: 'planned' }));
    await ledger.add(featureInput({ feature: 'SSO', status: 'shipped' }));

    expect(await ledger.get(planned.id)).toEqual(planned);
    expect(await ledger.all()).toHaveLength(2);

    const shipped = await ledger.list((f) => f.status === 'shipped');
    expect(shipped).toHaveLength(1);
    expect(shipped[0]?.feature).toBe('SSO');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await ledger.update(planned.id, {
      status: 'building',
      builtAt: '2026-06-30T12:00:00.000Z',
    });
    expect(updated.id).toBe(planned.id);
    expect(updated.status).toBe('building');
    expect(updated.builtAt).toBe('2026-06-30T12:00:00.000Z');
    expect(updated.updatedAt > planned.updatedAt).toBe(true);
  });

  it('rejects schema-invalid input with SchemaValidationError', async () => {
    const ledger = new FeatureLedger(root);
    const bad = featureInput({ status: 'bogus' as FeatureRecord['status'] });
    await expect(ledger.add(bad)).rejects.toBeInstanceOf(SchemaValidationError);
    expect(await ledger.all()).toHaveLength(0);
  });

  it('throws LedgerError on a corrupt stored file', async () => {
    const ledger = new FeatureLedger(root);
    const dir = workspacePaths(root).featuresDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'corrupt.json'), 'not-json-at-all', 'utf8');
    await expect(ledger.all()).rejects.toBeInstanceOf(LedgerError);
  });
});

// --- DecisionLedger ----------------------------------------------------------

describe('DecisionLedger', () => {
  it('add generates id, defaults date to now, validates, and persists', async () => {
    const ledger = new DecisionLedger(root);
    const created = await ledger.add(decisionInput());

    expect(created.id).toMatch(UUID_RE);
    expect(created.date).toMatch(ISO_RE);
    expect(created.chosenOption).toBe('Federation v2');

    const file = path.join(workspacePaths(root).decisionsDir, `${created.id}.json`);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as DecisionRecord;
    expect(onDisk).toEqual(created);
  });

  it('honours a caller-supplied date and keeps it immutable across update', async () => {
    const ledger = new DecisionLedger(root);
    const created = await ledger.add(decisionInput({ date: '2025-01-02T03:04:05.000Z' }));
    expect(created.date).toBe('2025-01-02T03:04:05.000Z');

    const updated = await ledger.update(created.id, { status: 'superseded' });
    expect(updated.id).toBe(created.id);
    expect(updated.date).toBe('2025-01-02T03:04:05.000Z');
    expect(updated.status).toBe('superseded');
    expect(await ledger.get(created.id)).toEqual(updated);
  });

  it('list filters by status and all returns everything', async () => {
    const ledger = new DecisionLedger(root);
    await ledger.add(decisionInput({ status: 'accepted' }));
    await ledger.add(decisionInput({ decision: 'Drop REST gateway', status: 'proposed' }));

    expect(await ledger.all()).toHaveLength(2);
    const proposed = await ledger.list((d) => d.status === 'proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.decision).toBe('Drop REST gateway');
  });

  it('rejects schema-invalid input with SchemaValidationError', async () => {
    const ledger = new DecisionLedger(root);
    const bad = decisionInput({ status: 'nope' as DecisionRecord['status'] });
    await expect(ledger.add(bad)).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('throws LedgerError on a corrupt stored file', async () => {
    const ledger = new DecisionLedger(root);
    const dir = workspacePaths(root).decisionsDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'bad.json'), '{bad', 'utf8');
    await expect(ledger.all()).rejects.toBeInstanceOf(LedgerError);
  });
});

// --- EvidenceLedger (append-only) -------------------------------------------

describe('EvidenceLedger', () => {
  it('add generates id + createdAt, validates, and persists under .cortex/evidence', async () => {
    const ledger = new EvidenceLedger(root);
    const created = await ledger.add(evidenceInput());

    expect(created.id).toMatch(UUID_RE);
    expect(created.createdAt).toMatch(ISO_RE);
    expect(created.kind).toBe('build');
    expect(created.exitCode).toBe(0);

    const file = path.join(workspacePaths(root).evidenceDir, `${created.id}.json`);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as EvidenceItem;
    expect(onDisk).toEqual(created);
  });

  it('supports get/list/all but is append-only (no update method)', async () => {
    const ledger = new EvidenceLedger(root);
    const a = await ledger.add(evidenceInput({ kind: 'test', claim: 'tests green' }));
    await ledger.add(evidenceInput({ kind: 'lint', status: 'refuted', claim: 'lint clean' }));

    expect(await ledger.get(a.id)).toEqual(a);
    expect(await ledger.all()).toHaveLength(2);
    const refuted = await ledger.list((e) => e.status === 'refuted');
    expect(refuted).toHaveLength(1);
    expect(refuted[0]?.kind).toBe('lint');

    // append-only: there must be no update method on the evidence ledger.
    const maybeUpdate = (ledger as unknown as { update?: unknown }).update;
    expect(maybeUpdate).toBeUndefined();
  });

  it('omits optional fields cleanly when not provided', async () => {
    const ledger = new EvidenceLedger(root);
    const created = await ledger.add({
      claim: 'route /health exists',
      status: 'verified',
      kind: 'route',
      detail: 'GET /health returns 200',
    });
    expect(created.command).toBeUndefined();
    expect(created.exitCode).toBeUndefined();
    const fetched = await ledger.get(created.id);
    expect(fetched?.claim).toBe('route /health exists');
  });

  it('rejects schema-invalid input with SchemaValidationError', async () => {
    const ledger = new EvidenceLedger(root);
    const bad = evidenceInput({ status: 'maybe' as EvidenceItem['status'] });
    await expect(ledger.add(bad)).rejects.toBeInstanceOf(SchemaValidationError);
    expect(await ledger.all()).toHaveLength(0);
  });

  it('throws LedgerError on a corrupt stored file', async () => {
    const ledger = new EvidenceLedger(root);
    const dir = workspacePaths(root).evidenceDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'broken.json'), 'def not json', 'utf8');
    await expect(ledger.get('broken')).rejects.toBeInstanceOf(LedgerError);
  });
});

// --- I/O failure handling ----------------------------------------------------

describe('JsonLedger I/O failures', () => {
  it('wraps a write failure as LedgerError', async () => {
    // Place a regular file where the ledger expects its directory, so the
    // on-write `mkdir`/`writeFile` fails with a real OS error (EEXIST/ENOTDIR).
    const paths = workspacePaths(root);
    await mkdir(paths.cortexDir, { recursive: true });
    await writeFile(paths.memoryDir, 'i am a file, not a directory', 'utf8');

    const ledger = new MemoryLedger(root);
    await expect(ledger.add(memoryInput())).rejects.toBeInstanceOf(LedgerError);
  });

  it('wraps a non-ENOENT listing failure as LedgerError', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.cortexDir, { recursive: true });
    await writeFile(paths.featuresDir, 'not a directory', 'utf8');

    const ledger = new FeatureLedger(root);
    // readdir on a file => ENOTDIR (not ENOENT) => surfaced as LedgerError.
    await expect(ledger.all()).rejects.toBeInstanceOf(LedgerError);
  });

  it('wraps a non-ENOENT read failure on get as LedgerError', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.evidenceDir, { recursive: true });
    // Make the entry path a directory so readFile fails with EISDIR, not ENOENT.
    await mkdir(path.join(paths.evidenceDir, 'busy.json'), { recursive: true });

    const ledger = new EvidenceLedger(root);
    await expect(ledger.get('busy')).rejects.toBeInstanceOf(LedgerError);
  });
});

// --- cross-ledger isolation --------------------------------------------------

describe('ledger isolation', () => {
  it('keeps each record kind in its own .cortex subdirectory', async () => {
    const memory = new MemoryLedger(root);
    const feature = new FeatureLedger(root);
    const decision = new DecisionLedger(root);
    const evidence = new EvidenceLedger(root);

    await memory.add(memoryInput());
    await feature.add(featureInput());
    await decision.add(decisionInput());
    await evidence.add(evidenceInput());

    const paths = workspacePaths(root);
    for (const dir of [paths.memoryDir, paths.featuresDir, paths.decisionsDir, paths.evidenceDir]) {
      const s = await stat(dir);
      expect(s.isDirectory()).toBe(true);
    }

    // each ledger only sees its own entries
    expect(await memory.all()).toHaveLength(1);
    expect(await feature.all()).toHaveLength(1);
    expect(await decision.all()).toHaveLength(1);
    expect(await evidence.all()).toHaveLength(1);
  });
});
