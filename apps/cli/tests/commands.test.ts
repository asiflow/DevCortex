// ============================================================================
// Unit tests for command implementations in commands.ts.
//
// These tests call command functions directly (bypassing CLI parsing) and pass
// GlobalOptions objects directly — `readGlobals` is never invoked here, so
// we never touch the filesystem for option resolution.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, DevCortexError } from '@devcortex/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as commands from '../src/commands';
import type { Fetcher } from '../src/premium/client';
import { canonicalJson } from '../src/premium/license';
import type { LicenseFile, LicensePayload } from '../src/premium/license';
import { SUPPORTED_PREMIUM_CONTRACT } from '../src/premium/loader';
import {
  installedManifestPath,
  licensePath,
  premiumDir,
  readLicenseFile,
} from '../src/premium/store';

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
let otherPrivKey: import('node:crypto').KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  pubPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  privKey = pair.privateKey;
  otherPrivKey = generateKeyPairSync('ed25519').privateKey; // NOT in pubPem
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

  // --- premium install (P0 from-file path) --------------------------------

  /** Fabricate an npm-pack-shaped bundle tarball exporting the given contract. */
  async function fabricateTgz(contract: number): Promise<string> {
    const stage = await mkdtemp(path.join(tmpdir(), 'devcortex-cli-tgz-'));
    tmpRoots.push(stage);
    const dist = path.join(stage, 'package', 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(
      path.join(stage, 'package', 'package.json'),
      JSON.stringify({ name: 'devcortex-premium', version: '9.9.9', type: 'module' }),
      'utf8',
    );
    await writeFile(
      path.join(dist, 'index.js'),
      `export const PREMIUM_CONTRACT_VERSION = ${contract};\nexport const brain = () => 'premium-ok';\n`,
      'utf8',
    );
    const tgz = path.join(stage, 'bundle.tgz');
    const tar = spawnSync('tar', ['-czf', tgz, '-C', stage, 'package']);
    if (tar.status !== 0) throw new Error('test fixture: tar -czf failed');
    return tgz;
  }

  async function activate(): Promise<void> {
    const file = await writeLicenseJson(makeLicense());
    await commands.cmdPremiumActivate(g(), file, { publicKeysPem: [pubPem] });
  }

  it('cmdPremiumInstall installs a local tgz and verifies the handshake end-to-end', async () => {
    await activate();
    const tgz = await fabricateTgz(SUPPORTED_PREMIUM_CONTRACT);
    const result = await commands.cmdPremiumInstall(
      g(),
      { fromFile: tgz, version: '9.9.9' },
      { publicKeysPem: [pubPem] },
    );
    expect(result.data).toMatchObject({ ok: true, version: '9.9.9', contract: 'ok' });
    expect(existsSync(path.join(premiumDir(), '9.9.9', 'package', 'dist', 'index.js'))).toBe(true);
    const manifest: unknown = JSON.parse(await readFile(installedManifestPath(), 'utf8'));
    expect(manifest).toEqual({ version: '9.9.9', contract: SUPPORTED_PREMIUM_CONTRACT });
  });

  // --- premium install / refresh (remote path, injected fetcher — no network) --

  function recordingFetcher(makeResponse: () => Response): {
    calls: { url: string; init: RequestInit | undefined }[];
    fetcher: Fetcher;
  } {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher: Fetcher = async (input, init) => {
      calls.push({ url: String(input), init });
      return makeResponse();
    };
    return { calls, fetcher };
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('cmdPremiumInstall without --from-file downloads from the cloud and installs end-to-end', async () => {
    await activate();
    const bytes = await readFile(await fabricateTgz(SUPPORTED_PREMIUM_CONTRACT));
    const { calls, fetcher } = recordingFetcher(
      () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-type': 'application/gzip', 'x-premium-version': '9.9.9' },
        }),
    );

    const result = await commands.cmdPremiumInstall(g(), {}, { publicKeysPem: [pubPem], fetcher });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://cloud.devcortex.dev/api/v1/premium/download');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toMatch(/^Bearer /);
    expect(result.data).toMatchObject({ ok: true, version: '9.9.9', contract: 'ok' });
    expect(existsSync(path.join(premiumDir(), '9.9.9', 'package', 'dist', 'index.js'))).toBe(true);
    const manifest: unknown = JSON.parse(await readFile(installedManifestPath(), 'utf8'));
    expect(manifest).toEqual({ version: '9.9.9', contract: SUPPORTED_PREMIUM_CONTRACT });
  });

  it('cmdPremiumInstall (remote) refuses without a license — and never touches the network', async () => {
    const { calls, fetcher } = recordingFetcher(() => jsonResponse(200, {}));
    await expect(
      commands.cmdPremiumInstall(g(), {}, { publicKeysPem: [pubPem], fetcher }),
    ).rejects.toThrow(/devcortex premium activate/);
    expect(calls).toHaveLength(0);
  });

  it('cmdPremiumInstall requires --version alongside --from-file', async () => {
    await activate();
    const tgz = await fabricateTgz(SUPPORTED_PREMIUM_CONTRACT);
    await expect(
      commands.cmdPremiumInstall(g(), { fromFile: tgz }, { publicKeysPem: [pubPem] }),
    ).rejects.toThrow(/--version/);
  });

  it('cmdPremiumInstall refuses without an activated license — and extracts nothing', async () => {
    const tgz = await fabricateTgz(SUPPORTED_PREMIUM_CONTRACT);
    await expect(
      commands.cmdPremiumInstall(
        g(),
        { fromFile: tgz, version: '9.9.9' },
        { publicKeysPem: [pubPem] },
      ),
    ).rejects.toThrow(/devcortex premium activate/);
    expect(existsSync(path.join(premiumDir(), '9.9.9'))).toBe(false);
  });

  it('cmdPremiumInstall refuses a bundle that fails the post-install handshake', async () => {
    await activate();
    const tgz = await fabricateTgz(99);
    await expect(
      commands.cmdPremiumInstall(
        g(),
        { fromFile: tgz, version: '9.9.9' },
        { publicKeysPem: [pubPem] },
      ),
    ).rejects.toThrow(/contract/i);
  });

  it('cmdPremiumStatus reports the loader handshake for an installed bundle', async () => {
    await activate();
    const tgz = await fabricateTgz(SUPPORTED_PREMIUM_CONTRACT);
    await commands.cmdPremiumInstall(
      g(),
      { fromFile: tgz, version: '9.9.9' },
      { publicKeysPem: [pubPem] },
    );
    const result = await commands.cmdPremiumStatus(g(), { publicKeysPem: [pubPem] });
    expect(result.data).toMatchObject({
      ok: true,
      license: { state: 'valid' },
      bundle: { installed: true, version: '9.9.9', contract: 'ok' },
    });
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('cmdPremiumStatus surfaces a handshake refusal and still exits 0', async () => {
    // Bundle manifest present but no license — the handshake refuses.
    await mkdir(path.dirname(installedManifestPath()), { recursive: true });
    await writeFile(
      installedManifestPath(),
      JSON.stringify({ version: '1.2.3', contract: SUPPORTED_PREMIUM_CONTRACT }),
      'utf8',
    );
    const result = await commands.cmdPremiumStatus(g(), { publicKeysPem: [pubPem] });
    expect(result.data).toMatchObject({
      bundle: { installed: true, contract: 'license-invalid' },
    });
    expect(result.exitCode ?? 0).toBe(0);
  });

  // --- premium refresh -------------------------------------------------------

  function signLicense(
    payload: LicensePayload,
    key: import('node:crypto').KeyObject,
  ): LicenseFile {
    const sig = sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64');
    return { payload, sig };
  }

  it('cmdPremiumRefresh renews via the cloud, re-verifies locally, and persists', async () => {
    await activate();
    const renewed = makeLicense({ exp: new Date(Date.now() + 60 * 86400_000).toISOString() });
    const { calls, fetcher } = recordingFetcher(() =>
      jsonResponse(200, { ok: true, license: renewed }),
    );

    const result = await commands.cmdPremiumRefresh(g(), { publicKeysPem: [pubPem], fetcher });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://cloud.devcortex.dev/api/v1/licenses/refresh');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(result.data).toMatchObject({ ok: true, state: 'valid' });
    await expect(readLicenseFile()).resolves.toEqual(renewed);
  });

  it('cmdPremiumRefresh refuses without a license — and never touches the network', async () => {
    const { calls, fetcher } = recordingFetcher(() => jsonResponse(200, {}));
    await expect(
      commands.cmdPremiumRefresh(g(), { publicKeysPem: [pubPem], fetcher }),
    ).rejects.toThrow(/devcortex premium activate/);
    expect(calls).toHaveLength(0);
  });

  it('cmdPremiumRefresh rejects a returned license the trusted keys did not sign — store untouched', async () => {
    await activate();
    const before = await readLicenseFile();
    const forged = signLicense(
      { ...makeLicense().payload, exp: new Date(Date.now() + 60 * 86400_000).toISOString() },
      otherPrivKey,
    );
    const { fetcher } = recordingFetcher(() => jsonResponse(200, { ok: true, license: forged }));

    await expect(
      commands.cmdPremiumRefresh(g(), { publicKeysPem: [pubPem], fetcher }),
    ).rejects.toThrow(/verification/i);
    await expect(readLicenseFile()).resolves.toEqual(before); // forged file never stored
  });

  // --- premium status opportunistic auto-refresh ------------------------------

  it('cmdPremiumStatus auto-refreshes a grace license and reports refreshed: true', async () => {
    const grace = makeLicense({ exp: new Date(Date.now() - 5 * 86400_000).toISOString() });
    await commands.cmdPremiumActivate(g(), await writeLicenseJson(grace), {
      publicKeysPem: [pubPem],
    });
    const renewed = makeLicense({ exp: new Date(Date.now() + 30 * 86400_000).toISOString() });
    const { calls, fetcher } = recordingFetcher(() =>
      jsonResponse(200, { ok: true, license: renewed }),
    );

    const result = await commands.cmdPremiumStatus(g(), { publicKeysPem: [pubPem], fetcher });

    expect(calls).toHaveLength(1);
    expect(result.data).toMatchObject({
      ok: true,
      license: { state: 'valid', refreshed: true },
    });
    await expect(readLicenseFile()).resolves.toEqual(renewed);
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('cmdPremiumStatus stays informational when the auto-refresh cannot reach the cloud', async () => {
    const grace = makeLicense({ exp: new Date(Date.now() - 5 * 86400_000).toISOString() });
    await commands.cmdPremiumActivate(g(), await writeLicenseJson(grace), {
      publicKeysPem: [pubPem],
    });
    const fetcher: Fetcher = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await commands.cmdPremiumStatus(g(), { publicKeysPem: [pubPem], fetcher });

    expect(result.data).toMatchObject({ ok: true, license: { state: 'grace' } });
    expect((result.data as { license: { refreshed?: boolean } }).license.refreshed).toBeUndefined();
    await expect(readLicenseFile()).resolves.toEqual(grace); // store untouched
    expect(result.exitCode ?? 0).toBe(0);
  });

  it('cmdPremiumStatus does not fire the auto-refresh for a far-from-expiry license', async () => {
    await activate(); // exp = +30 days
    const { calls, fetcher } = recordingFetcher(() => jsonResponse(200, {}));
    const result = await commands.cmdPremiumStatus(g(), { publicKeysPem: [pubPem], fetcher });
    expect(calls).toHaveLength(0);
    expect(result.data).toMatchObject({ ok: true, license: { state: 'valid' } });
  });
});

// ---------------------------------------------------------------------------
// OSS-untouched guarantee (spec PB-0 acceptance, Task 8). The free product
// must behave IDENTICALLY whether or not any premium state exists on the
// machine — premium is purely additive. These tests pin that guarantee so a
// future "wire premium into an OSS command" change that alters free-tier
// behavior is a test failure, not a silent product change.

describe('OSS-untouched guarantee (spec PB-0)', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.DEVCORTEX_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'devcortex-pb0-'));
    process.env.DEVCORTEX_HOME = home;
    tmpRoots.push(home);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DEVCORTEX_HOME;
    else process.env.DEVCORTEX_HOME = savedHome;
  });

  /** Simulate an installed premium bundle under the (sandboxed) home dir. */
  async function installPremiumFixture(): Promise<void> {
    const bundleDir = path.join(premiumDir(), '0.1.0');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    await writeFile(
      installedManifestPath(),
      `${JSON.stringify({ version: '0.1.0', contract: SUPPORTED_PREMIUM_CONTRACT }, null, 2)}\n`,
      'utf8',
    );
  }

  it('with an empty DEVCORTEX_HOME, premium reports none/not-installed and leaves zero footprint', async () => {
    const result = await commands.cmdPremiumStatus({ root: home, json: false });
    expect(result.data).toEqual({
      ok: true,
      license: { state: 'none' },
      bundle: { installed: false },
    });
    expect(result.exitCode ?? 0).toBe(0);
    // "Untouched" cuts both ways: the free-tier status probe must not CREATE
    // any ~/.devcortex state as a side effect either.
    await expect(readdir(home)).resolves.toEqual([]);
  });

  it('cmdBrief and cmdShip behave identically whether or not a premium dir exists', async () => {
    // Two identical fixture workspaces: ship runs exactly once per workspace,
    // so the with/without comparison can never be polluted by a first ship
    // run's own report landing in the workspace.
    const wsBrief = await makeFixtureWorkspace();
    const wsShipWithout = await makeFixtureWorkspace();
    tmpRoots.push(wsBrief, wsShipWithout);

    const briefWithout = await commands.cmdBrief({ root: wsBrief, json: false });
    const shipWithout = await commands.cmdShip({ root: wsShipWithout, json: false });

    await installPremiumFixture();

    const briefWith = await commands.cmdBrief({ root: wsBrief, json: false });
    const shipWith = await commands.cmdShip({ root: wsBrief, json: false });

    // Brief: byte-identical output (composeSessionBrief is deterministic).
    expect(briefWith.human).toBe(briefWithout.human);
    expect(briefWith.data).toEqual(briefWithout.data);

    // Ship: compare the stable decision surface — generatedAt stamps and the
    // uuid-suffixed report path legitimately differ between any two runs.
    const shipStable = (r: { data: unknown; exitCode?: number }) => {
      const d = r.data as {
        ok: boolean;
        blocked: boolean;
        reasons: unknown;
        report: { status: string };
      };
      return {
        ok: d.ok,
        blocked: d.blocked,
        reasons: d.reasons,
        status: d.report.status,
        exitCode: r.exitCode ?? 0,
      };
    };
    expect(shipStable(shipWith)).toEqual(shipStable(shipWithout));
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
