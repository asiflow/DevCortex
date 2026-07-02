// ============================================================================
// Premium license store — the on-disk home for DevCortex Premium state.
//
// Layout (all under $DEVCORTEX_HOME, defaulting to ~/.devcortex):
//   license.json            the verified license, owner-only (0600)
//   premium/                the installed Premium bundle
//   premium/installed.json  bundle manifest (written by `premium install`)
//
// Reading is a PRIMITIVE that never throws: an absent, unreadable, or
// unparseable store reads as `null` — `verifyLicenseFile` decides validity,
// the reader only answers "is there parseable JSON here?". Writing is strict:
// mkdir -p, then persist with mode 0600 (re-asserted on overwrite, since the
// `writeFile` mode option only applies at creation).
// ============================================================================

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { LicenseFile } from './license';

/** Root of DevCortex user state: `$DEVCORTEX_HOME` when set, else `~/.devcortex`. */
export function devcortexHome(): string {
  const override = process.env.DEVCORTEX_HOME;
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(homedir(), '.devcortex');
}

/** Where the activated license lives: `<home>/license.json`. */
export function licensePath(): string {
  return path.join(devcortexHome(), 'license.json');
}

/** Where the Premium bundle is installed: `<home>/premium`. */
export function premiumDir(): string {
  return path.join(devcortexHome(), 'premium');
}

/** The installed-bundle manifest: `<home>/premium/installed.json`. */
export function installedManifestPath(): string {
  return path.join(premiumDir(), 'installed.json');
}

/**
 * Read the stored license as parsed-but-UNVERIFIED JSON. Returns `null` when
 * the file is absent, unreadable, or not valid JSON — never throws. Callers
 * MUST pass the result through `verifyLicenseFile` before trusting it.
 */
export async function readLicenseFile(): Promise<unknown | null> {
  try {
    const raw = await readFile(licensePath(), 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Persist a verified license file (mkdir -p on the home dir, mode 0600).
 * The explicit `chmod` after the write re-asserts owner-only permissions on
 * re-activation over an existing file, where the `writeFile` mode is ignored.
 */
export async function writeLicenseFile(file: LicenseFile): Promise<void> {
  await mkdir(devcortexHome(), { recursive: true });
  const target = licensePath();
  await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(target, 0o600);
}

/** Manifest describing the installed Premium bundle (`premium/installed.json`). */
export interface InstalledManifest {
  /** Bundle version — names the install directory `<premiumDir>/<version>`. */
  version: string;
  /** Premium contract the installer believed it was installing (informational). */
  contract: number;
}

/**
 * Whether a bundle version is safe to use as a single directory name under the
 * premium dir. Positive allowlist: an alphanumeric first character, then any of
 * `A-Za-z0-9 . _ + -`. This rejects the empty string, `.`, `..`, any
 * leading-dot (hidden dir), path separators (`/`, `\`), whitespace, and
 * embedded null bytes — everything that could escape the premium dir or make
 * `path.join` throw. `installFromTarball` (write) and `isInstalledManifest`
 * (read) MUST agree, so both call this ONE predicate.
 */
export function isValidBundleVersion(version: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version);
}

function isInstalledManifest(value: unknown): value is InstalledManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === 'string' &&
    // Refuse path-y versions on read too, so the loader can never resolve an
    // entry outside the premium dir from a hand-edited manifest.
    isValidBundleVersion(record.version) &&
    typeof record.contract === 'number' &&
    Number.isFinite(record.contract)
  );
}

/**
 * Read the installed-bundle manifest. Returns `null` when the file is absent,
 * unreadable, unparseable, or not manifest-shaped — never throws. The loader
 * treats every `null` as "not installed"; only `installFromTarball` writes it.
 */
export async function readInstalledManifest(): Promise<InstalledManifest | null> {
  try {
    const raw = await readFile(installedManifestPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isInstalledManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the installed-bundle manifest (mkdir -p on the premium dir). */
export async function writeInstalledManifest(manifest: InstalledManifest): Promise<void> {
  await mkdir(premiumDir(), { recursive: true });
  await writeFile(installedManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
