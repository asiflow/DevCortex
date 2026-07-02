// ============================================================================
// Unit tests for command implementations in commands.ts.
//
// These tests call command functions directly (bypassing CLI parsing) and pass
// GlobalOptions objects directly — `readGlobals` is never invoked here, so
// we never touch the filesystem for option resolution.
// ============================================================================

import { generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, DevCortexError } from '@devcortex/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as commands from '../src/commands';
import { canonicalJson } from '../src/premium/license';
import type { LicenseFile, LicensePayload } from '../src/premium/license';
import { installedManifestPath, licensePath, readLicenseFile } from '../src/premium/store';

// The transcript-basic.jsonl fixture from Task 4 (packages/core/src/runs/__fixtures__/).
const FIXTURE_JSONL = fileURLToPath(
  new URL(
    '../../../packages/core/src/runs/__fixtures__/transcript-basic.jsonl',
    import.meta.url,
  ),
);

/**
 * Creates a temp directory, copies the Task 4 transcript fixture in as t.jsonl,
 * and initializes the workspace (.cortex/ scaffold) so commands that require an
 * initialized workspace (e.g. cmdPreflight) work without a live repo.
 */
async function makeFixtureWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'devcortex-cli-'));
  await copyFile(FIXTURE_JSONL, path.join(root, 't.jsonl'));
  await commands.cmdInit({ root, json: false }, { force: false });
  return root;
}

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------

describe('cmdBrief', () => {
  it('cmdBrief returns the brief text and ok:true even when uninitialized', async () => {
    const result = await commands.cmdBrief({ root: '/tmp/not-a-workspace-xyz', json: false });
    expect(result.data).toMatchObject({ ok: true });
    expect(result.human).toContain('devcortex init');
  });
});

// ---------------------------------------------------------------------------

describe('cmdDistill', () => {
  it('cmdDistill never blocks and reports the outcome', async () => {
    const root = await makeFixtureWorkspace();
    tmpRoots.push(root);
    const transcript = path.join(root, 't.jsonl');
    const outcome = await commands.cmdDistill({ root, json: true }, { transcriptPath: transcript });
    expect(outcome.blocked).toBe(false);
    expect(outcome.data).toMatchObject({ ok: true });
  });

  it('cmdDistill with no transcript resolves passively', async () => {
    const outcome = await commands.cmdDistill({ root: '/tmp/nowhere-xyz', json: true }, {});
    expect(outcome.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Premium commands. Signing uses an ephemeral runtime keypair (same idiom as
// premium-license.test.ts) — no key material exists in the repo. Every test
// points DEVCORTEX_HOME at a mkdtemp dir so the real ~/.devcortex is never
// touched, and injects the ephemeral public key via the test-only `opts`
// seam (the embedded PREMIUM_PUBKEYS list ships empty until the prod key).

let pubPem: string;
let privKey: import('node:crypto').KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  pubPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  privKey = pair.privateKey;
});

function makeLicense(overrides: Partial<LicensePayload> = {}): LicenseFile {
  const payload: LicensePayload = {
    v: 1,
    kid: 'kid-1',
    sub: 'acme',
    plan: 'premium',
    seats: 5,
    exp: new Date(Date.now() + 30 * 86400_000).toISOString(),
    graceDays: 14,
    durationDays: 30,
    features: ['prediction'],
    ...overrides,
  };
  const sig = sign(null, Buffer.from(canonicalJson(payload)), privKey).toString('base64');
  return { payload, sig };
}

describe('premium commands', () => {
  let home: string;
  let savedHome: string | undefined;
  const g = (): { root: string; json: boolean } => ({ root: home, json: false });

  beforeEach(async () => {
    savedHome = process.env.DEVCORTEX_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'devcortex-premium-'));
    process.env.DEVCORTEX_HOME = home;
    tmpRoots.push(home);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DEVCORTEX_HOME;
    else process.env.DEVCORTEX_HOME = savedHome;
  });

  async function writeLicenseJson(license: LicenseFile): Promise<string> {
    const file = path.join(home, 'license-to-activate.json');
    await writeFile(file, JSON.stringify(license), 'utf8');
    return file;
  }

  it('cmdPremiumActivate stores a valid license and reports state + daysLeft', async () => {
    const license = makeLicense();
    const file = await writeLicenseJson(license);
    const result = await commands.cmdPremiumActivate(g(), file, { publicKeysPem: [pubPem] });
    expect(result.data).toMatchObject({ ok: true, state: 'valid' });
    expect((result.data as { daysLeft: number }).daysLeft).toBeGreaterThan(30);
    await expect(readLicenseFile()).resolves.toEqual(license);
  });

  it('cmdPremiumActivate refuses a tampered license with the verification reason', async () => {
    const tampered = makeLicense();
    tampered.payload.seats = 500;
    const file = await writeLicenseJson(tampered);
    const err = await commands
      .cmdPremiumActivate(g(), file, { publicKeysPem: [pubPem] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevCortexError);
    expect((err as DevCortexError).message).toMatch(/signature/i);
    await expect(readLicenseFile()).resolves.toBeNull(); // nothing stored on refusal
  });

  it('cmdPremiumActivate wraps unparseable license JSON in ConfigError', async () => {
    const file = path.join(home, 'broken.json');
    await writeFile(file, 'not json {', 'utf8');
    await expect(
      commands.cmdPremiumActivate(g(), file, { publicKeysPem: [pubPem] }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('cmdPremiumActivate refuses a hard-expired license (fail loud, nothing stored)', async () => {
    const dead = makeLicense({ exp: new Date(Date.now() - 20 * 86400_000).toISOString() });
    const file = await writeLicenseJson(dead);
    await expect(
      commands.cmdPremiumActivate(g(), file, { publicKeysPem: [pubPem] }),
    ).rejects.toThrow(/expired/i);
    await expect(readLicenseFile()).resolves.toBeNull();
  });

  it('cmdPremiumActivate accepts a grace-window license and surfaces the warning', async () => {
    const grace = makeLicense({ exp: new Date(Date.now() - 5 * 86400_000).toISOString() });
    const file = await writeLicenseJson(grace);
    const result = await commands.cmdPremiumActivate(g(), file, { publicKeysPem: [pubPem] });
    expect(result.data).toMatchObject({ ok: true, state: 'grace' });
    expect(result.human).toMatch(/expired/i);
    await expect(readLicenseFile()).resolves.toEqual(grace);
  });

  it('cmdPremiumStatus on an empty home reports the exact none/not-installed shape', async () => {
    const result = await commands.cmdPremiumStatus(g());
    expect(result.data).toEqual({
      ok: true,
      license: { state: 'none' },
      bundle: { installed: false },
    });
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('cmdPremiumStatus after activate reports the verified state, plan, and sub', async () => {
    const file = await writeLicenseJson(makeLicense());
    await commands.cmdPremiumActivate(g(), file, { publicKeysPem: [pubPem] });
    const result = await commands.cmdPremiumStatus(g(), { publicKeysPem: [pubPem] });
    expect(result.data).toMatchObject({
      ok: true,
      license: { state: 'valid', plan: 'premium', sub: 'acme' },
      bundle: { installed: false },
    });
    expect((result.data as { license: { daysLeft: number } }).license.daysLeft).toBeGreaterThan(30);
  });

  it('cmdPremiumStatus never throws on a corrupt store — reports the state instead', async () => {
    // Valid JSON, garbage shape → verification says invalid.
    await mkdir(home, { recursive: true });
    await writeFile(licensePath(), JSON.stringify({ hello: 'world' }), 'utf8');
    const invalid = await commands.cmdPremiumStatus(g(), { publicKeysPem: [pubPem] });
    expect(invalid.data).toMatchObject({ ok: true, license: { state: 'invalid' } });

    // Not JSON at all → the reader yields null → state 'none'.
    await writeFile(licensePath(), 'not json {', 'utf8');
    const none = await commands.cmdPremiumStatus(g(), { publicKeysPem: [pubPem] });
    expect(none.data).toMatchObject({ ok: true, license: { state: 'none' } });
  });

  it('cmdPremiumStatus reports the installed bundle version from the manifest', async () => {
    await mkdir(path.dirname(installedManifestPath()), { recursive: true });
    await writeFile(installedManifestPath(), JSON.stringify({ version: '1.2.3' }), 'utf8');
    const result = await commands.cmdPremiumStatus(g());
    expect(result.data).toMatchObject({ bundle: { installed: true, version: '1.2.3' } });
  });
});

// ---------------------------------------------------------------------------

describe('cmdPreflight', () => {
  it('cmdPreflight degrades under an impossible budget instead of blowing it', async () => {
    const root = await makeFixtureWorkspace();
    tmpRoots.push(root);
    process.env.DEVCORTEX_PREFLIGHT_BUDGET_MS = '1';
    try {
      const result = await commands.cmdPreflight({ root, json: true }, 'change the date parser');
      expect(result.data).toMatchObject({ ok: true, degraded: true });
      expect((result.data as { blastRadius: unknown }).blastRadius).toBeNull();
    } finally {
      delete process.env.DEVCORTEX_PREFLIGHT_BUDGET_MS;
    }
  });

  it('cmdPreflight reports degraded:false under a generous budget', async () => {
    const root = await makeFixtureWorkspace();
    tmpRoots.push(root);
    const result = await commands.cmdPreflight({ root, json: true }, 'change the date parser');
    expect(result.data).toMatchObject({ degraded: false });
  });
});
