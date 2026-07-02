// ============================================================================
// Premium loader — license gate → manifest → dynamic import → contract
// handshake, plus `installFromTarball` extraction.
//
// Every test points DEVCORTEX_HOME at a fresh mkdtemp dir (never the real
// ~/.devcortex) — which also keeps each fabricated bundle at a UNIQUE absolute
// path, so Node's process-lifetime ESM module cache can never serve one
// test's bundle to another. Licenses are signed with an ephemeral runtime
// keypair injected via the test-only `publicKeysPem` seam (the embedded
// PREMIUM_PUBKEYS list ships empty until the production key lands).
//
// Bundles are fabricated in npm-pack layout: `package/dist/index.js` plus a
// `package/package.json` with `"type": "module"` — exactly what `npm pack`
// of the real premium bundle produces (Task 3).
// ============================================================================

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DevCortexError } from '@devcortex/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/premium/license';
import type { LicenseFile, LicensePayload } from '../src/premium/license';
import {
  installFromTarball,
  loadPremiumBrain,
  SUPPORTED_PREMIUM_CONTRACT,
} from '../src/premium/loader';
import { installedManifestPath, premiumDir, writeLicenseFile } from '../src/premium/store';

// --- ephemeral signing keypair (no key material exists in the repo) ---------

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

// --- fixture home ------------------------------------------------------------

let home: string;
let savedHome: string | undefined;

// Every mkdtemp staging dir created outside `home` (tgz builds, bad-bundle
// stages) is tracked here and removed in afterEach — otherwise each run leaks
// ~7 temp dirs under tmpdir(), which accumulated to an ENOSPC. Same idiom as
// the `tmpRoots` array in commands.test.ts.
const stagingDirs: string[] = [];

beforeEach(async () => {
  savedHome = process.env.DEVCORTEX_HOME;
  home = await mkdtemp(path.join(tmpdir(), 'devcortex-loader-'));
  process.env.DEVCORTEX_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.DEVCORTEX_HOME;
  else process.env.DEVCORTEX_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
  await Promise.all(stagingDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const OK_INDEX_JS = `export const PREMIUM_CONTRACT_VERSION = ${SUPPORTED_PREMIUM_CONTRACT};\nexport const brain = () => 'premium-ok';\n`;

/** Write an installed bundle (npm-pack layout) + manifest directly under <home>/premium. */
async function fabricateInstall(version: string, indexJs: string): Promise<void> {
  const dist = path.join(premiumDir(), version, 'package', 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(
    path.join(premiumDir(), version, 'package', 'package.json'),
    JSON.stringify({ name: 'devcortex-premium', version, type: 'module' }),
    'utf8',
  );
  await writeFile(path.join(dist, 'index.js'), indexJs, 'utf8');
  await writeFile(
    installedManifestPath(),
    `${JSON.stringify({ version, contract: SUPPORTED_PREMIUM_CONTRACT })}\n`,
    'utf8',
  );
}

/** Fabricate an npm-pack-shaped tarball (package/dist/index.js) and return its path. */
async function fabricateTgz(indexJs: string, version = '9.9.9'): Promise<string> {
  const stage = await mkdtemp(path.join(tmpdir(), 'devcortex-tgz-'));
  stagingDirs.push(stage);
  const dist = path.join(stage, 'package', 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(
    path.join(stage, 'package', 'package.json'),
    JSON.stringify({ name: 'devcortex-premium', version, type: 'module' }),
    'utf8',
  );
  await writeFile(path.join(dist, 'index.js'), indexJs, 'utf8');
  const tgz = path.join(stage, 'bundle.tgz');
  const tar = spawnSync('tar', ['-czf', tgz, '-C', stage, 'package']);
  if (tar.status !== 0) throw new Error('test fixture: tar -czf failed');
  return tgz;
}

// --- loadPremiumBrain ---------------------------------------------------------

describe('loadPremiumBrain', () => {
  it('loads a valid install end-to-end', async () => {
    await writeLicenseFile(makeLicense());
    await fabricateInstall('9.9.9', OK_INDEX_JS);
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load.status).toBe('ok');
    if (load.status === 'ok') {
      expect(load.module.PREMIUM_CONTRACT_VERSION).toBe(SUPPORTED_PREMIUM_CONTRACT);
      expect((load.module.brain as () => string)()).toBe('premium-ok');
      expect(load.version).toBe('9.9.9');
    }
  });

  it('proceeds on a grace-window license (grace warns, it does not gate)', async () => {
    await writeLicenseFile(
      makeLicense({ exp: new Date(Date.now() - 5 * 86400_000).toISOString() }),
    );
    await fabricateInstall('9.9.9', OK_INDEX_JS);
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load.status).toBe('ok');
  });

  it('refuses with license-invalid when no license was ever activated', async () => {
    await fabricateInstall('9.9.9', OK_INDEX_JS);
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load).toMatchObject({ status: 'license-invalid' });
    if (load.status !== 'ok') expect(load.reason).toMatch(/premium activate/);
  });

  it('refuses with license-invalid on a stored license that fails verification', async () => {
    const tampered = makeLicense();
    tampered.payload.seats = 500; // breaks the signature
    await writeLicenseFile(tampered);
    await fabricateInstall('9.9.9', OK_INDEX_JS);
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load).toMatchObject({ status: 'license-invalid' });
    if (load.status !== 'ok') expect(load.reason).toMatch(/signature/i);
  });

  it('refuses with license-expired (and the actionable reason) past the grace window', async () => {
    await writeLicenseFile(
      makeLicense({ exp: new Date(Date.now() - 30 * 86400_000).toISOString() }),
    );
    await fabricateInstall('9.9.9', OK_INDEX_JS);
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load).toMatchObject({ status: 'license-expired' });
    if (load.status !== 'ok') expect(load.reason).toMatch(/expired.*refresh/is);
  });

  it('refuses with not-installed when no manifest exists', async () => {
    await writeLicenseFile(makeLicense());
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load).toMatchObject({ status: 'not-installed' });
    if (load.status !== 'ok') expect(load.reason).toMatch(/premium install/);
  });

  it('treats a hostile manifest (bad JSON or wrong shape) as not-installed', async () => {
    await writeLicenseFile(makeLicense());
    await mkdir(premiumDir(), { recursive: true });

    await writeFile(installedManifestPath(), 'not json {', 'utf8');
    expect(await loadPremiumBrain({ publicKeysPem: [pubPem] })).toMatchObject({
      status: 'not-installed',
    });

    await writeFile(installedManifestPath(), JSON.stringify({ version: 42 }), 'utf8');
    expect(await loadPremiumBrain({ publicKeysPem: [pubPem] })).toMatchObject({
      status: 'not-installed',
    });

    // Hand-edited path-y versions must never resolve an entry outside the
    // premium dir — the manifest guard refuses them on read. The read-side
    // allowlist is kept consistent with the install-time guard, so `.` (which
    // path.join would collapse to the premium dir itself) is refused too.
    for (const evil of ['../../evil', '.', '.hidden']) {
      await writeFile(
        installedManifestPath(),
        JSON.stringify({ version: evil, contract: SUPPORTED_PREMIUM_CONTRACT }),
        'utf8',
      );
      expect(await loadPremiumBrain({ publicKeysPem: [pubPem] })).toMatchObject({
        status: 'not-installed',
      });
    }
  });

  it('refuses a contract mismatch with an actionable reason', async () => {
    await writeLicenseFile(makeLicense());
    await fabricateInstall(
      '9.9.9',
      `export const PREMIUM_CONTRACT_VERSION = 99;\nexport const brain = () => 'premium-ok';\n`,
    );
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load).toMatchObject({ status: 'contract-mismatch' });
    if (load.status !== 'ok') {
      expect(load.reason).toContain(
        'run `devcortex premium install` to fetch a matching bundle, or upgrade devcortex',
      );
      expect(load.reason).toContain('99');
    }
  });

  it('returns load-error (never throws) when the bundle throws at import time', async () => {
    await writeLicenseFile(makeLicense());
    await fabricateInstall('9.9.9', `throw new Error('boom at import');\n`);
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load).toMatchObject({ status: 'load-error' });
    if (load.status !== 'ok') expect(load.reason).toContain('boom at import');
  });

  it('returns load-error when the manifest points at a missing entry file', async () => {
    await writeLicenseFile(makeLicense());
    await fabricateInstall('9.9.9', OK_INDEX_JS);
    await rm(path.join(premiumDir(), '9.9.9', 'package', 'dist', 'index.js'));
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load).toMatchObject({ status: 'load-error' });
    if (load.status !== 'ok') expect(load.reason).toMatch(/premium install/);
  });
});

// --- installFromTarball ---------------------------------------------------------

describe('installFromTarball', () => {
  it('extracts an npm-pack tgz and writes the manifest', async () => {
    const tgz = await fabricateTgz(OK_INDEX_JS);
    const { installDir } = await installFromTarball(tgz, '9.9.9');
    expect(installDir).toBe(path.join(premiumDir(), '9.9.9'));
    expect(existsSync(path.join(installDir, 'package', 'dist', 'index.js'))).toBe(true);
    const manifest: unknown = JSON.parse(await readFile(installedManifestPath(), 'utf8'));
    expect(manifest).toEqual({ version: '9.9.9', contract: SUPPORTED_PREMIUM_CONTRACT });
  });

  it('install → load round-trips end-to-end', async () => {
    await writeLicenseFile(makeLicense());
    const tgz = await fabricateTgz(OK_INDEX_JS);
    await installFromTarball(tgz, '9.9.9');
    const load = await loadPremiumBrain({ publicKeysPem: [pubPem] });
    expect(load.status).toBe('ok');
  });

  it('throws a clean DevCortexError on a corrupt tgz (and writes no manifest)', async () => {
    const bogus = path.join(home, 'corrupt.tgz');
    await writeFile(bogus, 'this is definitely not gzip data', 'utf8');
    const err = await installFromTarball(bogus, '9.9.9')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevCortexError);
    expect((err as DevCortexError).message).toMatch(/extract/i);
    expect(existsSync(installedManifestPath())).toBe(false);
  });

  it('throws a clean DevCortexError when the tgz path does not exist', async () => {
    await expect(installFromTarball(path.join(home, 'nope.tgz'), '1.0.0')).rejects.toBeInstanceOf(
      DevCortexError,
    );
  });

  it('rejects a tgz missing package/dist/index.js (not a premium bundle)', async () => {
    const stage = await mkdtemp(path.join(tmpdir(), 'devcortex-badtgz-'));
    stagingDirs.push(stage);
    await mkdir(path.join(stage, 'package'), { recursive: true });
    await writeFile(path.join(stage, 'package', 'readme.txt'), 'nothing here', 'utf8');
    const tgz = path.join(stage, 'bad.tgz');
    spawnSync('tar', ['-czf', tgz, '-C', stage, 'package']);
    const err = await installFromTarball(tgz, '9.9.9')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevCortexError);
    expect((err as DevCortexError).message).toContain('package/dist/index.js');
    expect(existsSync(installedManifestPath())).toBe(false);
  });

  it('rejects a version containing path separators or ..', async () => {
    const tgz = await fabricateTgz(OK_INDEX_JS);
    await expect(installFromTarball(tgz, '../evil')).rejects.toBeInstanceOf(DevCortexError);
    await expect(installFromTarball(tgz, 'a/b')).rejects.toBeInstanceOf(DevCortexError);
    await expect(installFromTarball(tgz, '')).rejects.toBeInstanceOf(DevCortexError);
  });

  it('rejects reserved, leading-dot, and null-byte versions (positive allowlist)', async () => {
    const tgz = await fabricateTgz(OK_INDEX_JS);
    // `.` and `..` are path references; a leading dot is a hidden dir; internal
    // whitespace survives the input trim; a null byte would otherwise make
    // path.join throw a raw (non-DevCortex) error. The allowlist turns all of
    // these into ONE clean DevCortexError, and none writes a manifest.
    const nullByte = `x${String.fromCharCode(0)}y`;
    for (const bad of ['.', '..', '.hidden', 'x y', nullByte]) {
      await expect(installFromTarball(tgz, bad)).rejects.toBeInstanceOf(DevCortexError);
    }
    expect(existsSync(installedManifestPath())).toBe(false);
  });

  it('a dirty-dir re-install cannot report false success on a stale entry file', async () => {
    // 1. A good v5.0.0 install lands package/dist/index.js.
    const good = await fabricateTgz(OK_INDEX_JS, '5.0.0');
    await installFromTarball(good, '5.0.0');
    const entry = path.join(premiumDir(), '5.0.0', 'package', 'dist', 'index.js');
    expect(existsSync(entry)).toBe(true);

    // 2. Re-install a v5.0.0 tarball that LACKS package/dist/index.js. `tar -x`
    //    MERGES into an existing dir and never deletes files absent from the
    //    archive, so without the clean-slate rm the sanity check would pass on
    //    the STALE index.js and rewrite the manifest — a false success while
    //    old code keeps running. It must instead throw the clean sanity error.
    const badStage = await mkdtemp(path.join(tmpdir(), 'devcortex-stale-'));
    stagingDirs.push(badStage);
    await mkdir(path.join(badStage, 'package'), { recursive: true });
    await writeFile(path.join(badStage, 'package', 'readme.txt'), 'no dist here', 'utf8');
    const badTgz = path.join(badStage, 'bad.tgz');
    spawnSync('tar', ['-czf', badTgz, '-C', badStage, 'package']);

    const err = await installFromTarball(badTgz, '5.0.0')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevCortexError);
    expect((err as DevCortexError).message).toContain('package/dist/index.js');
    // The stale entry was wiped by the clean slate — no leftover can fake it.
    expect(existsSync(entry)).toBe(false);
  });
});
