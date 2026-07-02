// ============================================================================
// Premium bundle loader — the OPEN half of DevCortex Premium.
//
// This module is intentionally open-source and contains ZERO premium logic:
// it verifies the license offline, locates the installed bundle, dynamic-
// imports it, and performs a contract handshake. All premium capability lives
// in the PRIVATE bundle this loader imports — an npm-pack tarball whose
// layout is `package/dist/index.js` (a fully self-contained ESM build).
//
// `loadPremiumBrain` NEVER throws — every failure is a typed refusal. It sits
// on informational paths (`premium status`) and feature probes that must
// degrade gracefully on a pure-OSS install. Load order is a state machine:
// license → manifest → import → handshake; the first failing gate names the
// refusal, and a `grace` license PROCEEDS (grace warns, it does not gate).
//
// `installFromTarball` requires `tar` on PATH (preinstalled on macOS, Linux,
// and modern Windows 10+); a missing binary fails with a clean DevCortexError.
//
// Note: Node caches ESM imports for the process lifetime — a re-install into
// the SAME version directory is picked up by the next CLI invocation, not by
// a loader call later in the same process. CLI commands are one-shot, so this
// never bites in practice.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DevCortexError } from '@devcortex/core';

import { verifyLicenseFile } from './license';
import {
  isValidBundleVersion,
  premiumDir,
  readInstalledManifest,
  readLicenseFile,
  writeInstalledManifest,
} from './store';

/** The premium contract this devcortex speaks; the bundle must export the same. */
export const SUPPORTED_PREMIUM_CONTRACT = 1;

export type PremiumLoad =
  | { status: 'ok'; module: Record<string, unknown>; version: string }
  | {
      status:
        | 'not-installed'
        | 'license-invalid'
        | 'license-expired'
        | 'contract-mismatch'
        | 'load-error';
      reason: string;
    };

/**
 * Verify license → read manifest → dynamic-import the installed bundle →
 * contract handshake. Never throws; every failure is a typed refusal.
 *
 * `publicKeysPem` overrides the embedded PREMIUM_PUBKEYS (used by tests and
 * staging — the CLI deliberately exposes no flag for it).
 */
export async function loadPremiumBrain(opts?: {
  publicKeysPem?: readonly string[];
}): Promise<PremiumLoad> {
  try {
    // 1. License gate — absent or unverifiable refuses before any disk walk.
    const stored = await readLicenseFile();
    if (stored === null) {
      return {
        status: 'license-invalid',
        reason: 'No license activated — run `devcortex premium activate <license.json>` first.',
      };
    }
    const check = verifyLicenseFile(stored, opts);
    if (check.state === 'invalid') {
      return {
        status: 'license-invalid',
        reason: check.reason ?? 'Stored license failed verification.',
      };
    }
    if (check.state === 'expired') {
      return {
        status: 'license-expired',
        reason:
          check.reason ??
          'License expired past its grace window — run `devcortex premium refresh` or renew.',
      };
    }
    // `valid` and `grace` both proceed — grace is surfaced by `premium status`.

    // 2. Manifest — a missing/hostile manifest means nothing is installed.
    const manifest = await readInstalledManifest();
    if (manifest === null) {
      return {
        status: 'not-installed',
        reason: 'Premium bundle not installed — run `devcortex premium install`.',
      };
    }

    // 3. Entry check — a manifest pointing at deleted files is a broken
    //    install, not a missing one: report load-error with the repair step.
    const entry = path.join(premiumDir(), manifest.version, 'package', 'dist', 'index.js');
    if (!existsSync(entry)) {
      return {
        status: 'load-error',
        reason: `Premium bundle entry missing at ${entry} — re-run \`devcortex premium install\`.`,
      };
    }

    // 4. Dynamic import — the ONLY moment third-party code runs.
    let module: Record<string, unknown>;
    try {
      module = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as Record<
        string,
        unknown
      >;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      return { status: 'load-error', reason: `Premium bundle failed to load: ${cause}` };
    }

    // 5. Contract handshake — refuse a bundle speaking a different contract.
    const found = module.PREMIUM_CONTRACT_VERSION;
    if (found !== SUPPORTED_PREMIUM_CONTRACT) {
      return {
        status: 'contract-mismatch',
        reason:
          `Installed bundle speaks premium contract ${String(found)}; this devcortex supports ` +
          `${SUPPORTED_PREMIUM_CONTRACT} — run \`devcortex premium install\` to fetch a matching ` +
          'bundle, or upgrade devcortex.',
      };
    }

    return { status: 'ok', module, version: manifest.version };
  } catch (err) {
    // Whole-body fence: a loader returns refusals, never throws — even on
    // faults the step-level handling above did not anticipate.
    const cause = err instanceof Error ? err.message : String(err);
    return { status: 'load-error', reason: `Premium bundle failed to load: ${cause}` };
  }
}

/**
 * Extract an npm-pack bundle tarball into `<premiumDir>/<version>` and record
 * it in `installed.json`. Fail-loud contract (unlike the loader): a missing
 * tgz, a corrupt archive, a missing `tar` binary, or a tarball that is not a
 * premium bundle all throw a clean `DevCortexError` — and the manifest is
 * only written AFTER the extracted layout passes its sanity check, so a
 * failed install never masquerades as an installed one.
 *
 * The install directory is wiped BEFORE extraction: `tar -x` merges into an
 * existing dir and never removes files absent from the archive, so a re-install
 * of the same version over a prior one could otherwise leave a stale
 * `package/dist/index.js` that fakes the sanity check. A failed re-install thus
 * removes the previous install of that version — the honest outcome (the user
 * is told it failed) versus silently running old code as new.
 */
export async function installFromTarball(
  tgzPath: string,
  version: string,
): Promise<{ installDir: string }> {
  // The version names a directory under premiumDir — a positive allowlist
  // (alphanumeric-led, then `. _ + -`) rejects the empty string, `.`/`..`, any
  // leading-dot, path separators, whitespace, and null bytes before we touch
  // disk. Shared with the manifest read guard so both sides agree.
  const clean = version.trim();
  if (!isValidBundleVersion(clean)) {
    throw new DevCortexError(
      'INTERNAL',
      `Invalid bundle version "${version}" — expected a plain version like 1.2.3 (letters, digits, and \`. _ + -\`).`,
    );
  }
  if (!existsSync(tgzPath)) {
    throw new DevCortexError('INTERNAL', `Cannot read bundle "${tgzPath}": no such file.`);
  }

  // Clean slate before extraction (see banner). `clean` is allowlist-validated,
  // so installDir is provably a direct child of premiumDir — safe to remove
  // recursively; `force` makes a first-time install (no dir yet) a no-op.
  const installDir = path.join(premiumDir(), clean);
  await rm(installDir, { recursive: true, force: true });
  await mkdir(installDir, { recursive: true });

  const tar = spawnSync('tar', ['-xzf', tgzPath, '-C', installDir]);
  if (tar.error !== undefined) {
    throw new DevCortexError(
      'INTERNAL',
      'Cannot extract the bundle: `tar` was not found on PATH. Install tar ' +
        '(preinstalled on macOS, Linux, and modern Windows 10+) and retry.',
      { cause: tar.error },
    );
  }
  if (tar.status !== 0) {
    throw new DevCortexError(
      'INTERNAL',
      `Cannot extract "${tgzPath}" (tar exited with ${tar.status ?? 'a signal'}) — ` +
        'is it a valid .tgz bundle?',
      { details: tar.stderr?.toString().trim() },
    );
  }

  const entry = path.join(installDir, 'package', 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new DevCortexError(
      'INTERNAL',
      `Extracted archive has no package/dist/index.js — "${tgzPath}" is not a DevCortex Premium bundle.`,
    );
  }

  await writeInstalledManifest({ version: clean, contract: SUPPORTED_PREMIUM_CONTRACT });
  return { installDir };
}
