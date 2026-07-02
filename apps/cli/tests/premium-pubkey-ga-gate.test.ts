// ============================================================================
// GA RELEASE-SAFETY GATE — the DEV/STAGING premium public key MUST NOT ship
// in a >= 0.3.0 (GA) publish.
//
// `src/premium/pubkeys.ts` currently embeds a dev/staging verification key
// whose banner says "replace before GA". A comment cannot stop a publish —
// this test can: it is wired into `package.json` `prepublishOnly`, so
// `pnpm publish` refuses while it is red.
//
// HOW IT ARMS (this is the release-safety gate):
//   - At the CURRENT pre-GA version (0.2.x) the gate PASSES — the dev key is
//     explicitly allowed until GA, so day-to-day CI stays green.
//   - The moment the version is bumped to >= 0.3.0 while pubkeys.ts still
//     carries the DEV/STAGING banner, the gate FAILS LOUDLY and tells the
//     release operator to run the production key ceremony
//     (devcortex-cloud docs/premium-e2e.md § "Production key ceremony") and
//     swap in the prod public key.
//
// The gate matches the loud banner STRING, never the key bytes — the bytes
// are exactly what the ceremony replaces. The banner line in pubkeys.ts is
// annotated as load-bearing so it is not reworded casually.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// --- gate inputs ---------------------------------------------------------------

/**
 * Stable substring of the loud dev-key banner in `src/premium/pubkeys.ts`.
 * Deliberately NOT the key bytes: the ceremony replaces the bytes, and the
 * sanctioned removal deletes the whole banner+key entry in the same commit.
 */
const DEV_KEY_MARKER = 'DEV/STAGING KEY';

/** First version that must NOT carry the dev key (the GA line). */
const GA_MAJOR = 0;
const GA_MINOR = 3;
const GA_PATCH = 0;

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const PUBKEYS_PATH = fileURLToPath(new URL('../src/premium/pubkeys.ts', import.meta.url));

// --- tiny inline semver (major.minor.patch as ints; no new dependency) ----------

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/.exec(version.trim());
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`GA gate cannot parse package.json version "${version}" as major.minor.patch`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `version` >= 0.3.0 — numeric tuple compare, immune to "0.10.0" string traps. */
function isGaOrLater(version: string): boolean {
  const [major, minor, patch] = parseSemver(version);
  if (major !== GA_MAJOR) return major > GA_MAJOR;
  if (minor !== GA_MINOR) return minor > GA_MINOR;
  return patch >= GA_PATCH;
}

/** The gate verdict, pure so the trip condition is provable without a version bump. */
function devKeyShipsAtGa(version: string, pubkeysSource: string): boolean {
  return isGaOrLater(version) && pubkeysSource.includes(DEV_KEY_MARKER);
}

// --- gate logic proves it arms (synthetic inputs — no version bump needed) -------

describe('GA gate logic (synthetic)', () => {
  it.each([
    ['0.2.0', false],
    ['0.2.99', false],
    ['0.3.0', true],
    ['0.3.1', true],
    ['0.10.0', true], // would be BELOW "0.3.0" in a naive string compare
    ['1.0.0', true],
    ['0.3.0-rc.1', true], // prerelease of the GA line still must not carry the dev key
  ])('isGaOrLater(%s) === %s', (version, expected) => {
    expect(isGaOrLater(version)).toBe(expected);
  });

  it('throws loudly on an unparseable version instead of silently passing', () => {
    expect(() => isGaOrLater('not-a-version')).toThrowError(/cannot parse/);
  });

  it('trips when a GA version still contains the dev-key banner', () => {
    expect(devKeyShipsAtGa('0.3.0', `// !!! ${DEV_KEY_MARKER} — NOT THE PRODUCTION KEY !!!`)).toBe(
      true,
    );
  });

  it('passes pre-GA with the dev key present, and at GA once the banner is gone', () => {
    expect(devKeyShipsAtGa('0.2.0', `// !!! ${DEV_KEY_MARKER} !!!`)).toBe(false);
    expect(devKeyShipsAtGa('0.3.0', '// prod key v1 (issued 2026-07)')).toBe(false);
  });
});

// --- THE GATE (real package.json + real pubkeys.ts) ------------------------------

describe('GA release-safety gate (real files)', () => {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { version?: unknown };
  const pubkeysSource = readFileSync(PUBKEYS_PATH, 'utf8');

  it('reads sane gate inputs (guards against file moves silently disarming the gate)', () => {
    expect(typeof packageJson.version).toBe('string');
    expect(pubkeysSource).toContain('PREMIUM_PUBKEYS');
  });

  it('the embedded DEV/STAGING key must be gone by 0.3.0 (GA)', () => {
    const version = String(packageJson.version);
    if (devKeyShipsAtGa(version, pubkeysSource)) {
      expect.fail(
        [
          '',
          '!!! GA RELEASE BLOCKED — DEV/STAGING PREMIUM KEY STILL EMBEDDED !!!',
          '',
          `apps/cli is at version ${version} (>= 0.3.0 = GA) but`,
          'src/premium/pubkeys.ts still contains the DEV/STAGING verification key.',
          'Publishing now would make every GA install trust licenses signed by a',
          'burned dev keypair.',
          '',
          'Before this version can publish, the release operator MUST run the',
          'production key ceremony (devcortex-cloud docs/premium-e2e.md',
          '§ "Production key ceremony"):',
          '  1. `node scripts/license-keygen.mjs` in devcortex-cloud — private half',
          '     goes ONLY into the deployment env (e.g. Vercel LICENSE_SIGNING_KEY).',
          '  2. APPEND the new production public PEM to PREMIUM_PUBKEYS.',
          '  3. REMOVE the dev/staging entry (banner + key) in the same commit.',
          '',
          'This gate runs in prepublishOnly, so `pnpm publish` refuses until then.',
          '',
        ].join('\n'),
      );
    }
    // Reaching here means: pre-GA (dev key allowed), or GA with the ceremony done.
  });
});
