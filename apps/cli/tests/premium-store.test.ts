// ============================================================================
// Premium license store — on-disk layout under $DEVCORTEX_HOME.
//
// Every test points DEVCORTEX_HOME at a mkdtemp directory: the suite must
// NEVER touch the real ~/.devcortex. The default-path test only computes a
// path (no filesystem writes), so it is safe to assert against homedir().
// ============================================================================

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LicenseFile } from '../src/premium/license';
import {
  devcortexHome,
  installedManifestPath,
  licensePath,
  premiumDir,
  readLicenseFile,
  writeLicenseFile,
} from '../src/premium/store';

function sampleLicense(): LicenseFile {
  return {
    payload: {
      v: 1,
      kid: 'kid-1',
      sub: 'acme',
      plan: 'premium',
      seats: 5,
      exp: new Date(Date.now() + 30 * 86400_000).toISOString(),
      graceDays: 14,
      durationDays: 30,
      features: ['prediction'],
    },
    sig: 'c2lnLWJ5dGVz',
  };
}

let tmpHome: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  savedEnv = process.env.DEVCORTEX_HOME;
  tmpHome = await mkdtemp(path.join(tmpdir(), 'devcortex-home-'));
  process.env.DEVCORTEX_HOME = tmpHome;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.DEVCORTEX_HOME;
  else process.env.DEVCORTEX_HOME = savedEnv;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('premium store paths', () => {
  it('honors the DEVCORTEX_HOME env override for every derived path', () => {
    expect(devcortexHome()).toBe(tmpHome);
    expect(licensePath()).toBe(path.join(tmpHome, 'license.json'));
    expect(premiumDir()).toBe(path.join(tmpHome, 'premium'));
    expect(installedManifestPath()).toBe(path.join(tmpHome, 'premium', 'installed.json'));
  });

  it('defaults to ~/.devcortex when DEVCORTEX_HOME is unset or blank', () => {
    delete process.env.DEVCORTEX_HOME;
    expect(devcortexHome()).toBe(path.join(homedir(), '.devcortex'));
    process.env.DEVCORTEX_HOME = '   ';
    expect(devcortexHome()).toBe(path.join(homedir(), '.devcortex'));
  });
});

describe('writeLicenseFile / readLicenseFile', () => {
  it('round-trips a license and creates the home directory (mkdir -p)', async () => {
    // Point at a not-yet-existing nested dir to prove the recursive mkdir.
    process.env.DEVCORTEX_HOME = path.join(tmpHome, 'nested', 'home');
    const license = sampleLicense();
    await writeLicenseFile(license);
    await expect(readLicenseFile()).resolves.toEqual(license);
  });

  it('writes the license file with owner-only mode 0600', async () => {
    await writeLicenseFile(sampleLicense());
    const info = await stat(licensePath());
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('re-asserts mode 0600 when overwriting an existing looser-mode file', async () => {
    await writeLicenseFile(sampleLicense());
    await chmod(licensePath(), 0o644);
    await writeLicenseFile(sampleLicense());
    const info = await stat(licensePath());
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('readLicenseFile returns null when the file is absent', async () => {
    await expect(readLicenseFile()).resolves.toBeNull();
  });

  it('readLicenseFile returns null on unparseable content — never throws', async () => {
    await writeLicenseFile(sampleLicense());
    await writeFile(licensePath(), 'not json {', 'utf8');
    await expect(readLicenseFile()).resolves.toBeNull();
  });

  it('readLicenseFile returns null on an unreadable file — never throws', async () => {
    await writeLicenseFile(sampleLicense());
    await chmod(licensePath(), 0o000);
    await expect(readLicenseFile()).resolves.toBeNull();
    await chmod(licensePath(), 0o600); // restore so cleanup is quiet
  });

  it('stored bytes are plain JSON of the LicenseFile (parseable by readFile)', async () => {
    const license = sampleLicense();
    await writeLicenseFile(license);
    const raw = await readFile(licensePath(), 'utf8');
    expect(JSON.parse(raw)).toEqual(license);
  });
});
