// ============================================================================
// DevCortex Cloud client — wire-bearer format, premium download, license
// refresh, and the opportunistic `maybeRefresh`.
//
// NO REAL NETWORK: every test injects a fetcher and asserts on what the
// client sent. The wire bearer is locked to the cloud's `parseBearer`
// (devcortex-cloud `src/services/licenses.ts`): base64 of the LicenseFile
// JSON — the decode-side assertions below mirror that parse exactly.
//
// Licenses are signed with an ephemeral runtime keypair (no key material in
// the repo); DEVCORTEX_HOME points at a fresh mkdtemp dir per test so the
// real ~/.devcortex is never touched, and every tmp dir this suite (or the
// client under test) creates is tracked and removed in afterEach.
// ============================================================================

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DevCortexError } from '@devcortex/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cloudBaseUrl,
  downloadPremium,
  maybeRefresh,
  refreshRemote,
} from '../src/premium/client';
import type { Fetcher } from '../src/premium/client';
import { canonicalJson, verifyLicenseFile } from '../src/premium/license';
import type { LicenseFile, LicensePayload } from '../src/premium/license';
import { readLicenseFile } from '../src/premium/store';

// --- ephemeral signing keypair (no key material exists in the repo) ---------

let pubPem: string;
let privKey: import('node:crypto').KeyObject;
let otherPrivKey: import('node:crypto').KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  pubPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  privKey = pair.privateKey;
  otherPrivKey = generateKeyPairSync('ed25519').privateKey; // NOT in pubPem
});

function makeLicense(
  overrides: Partial<LicensePayload> = {},
  signer: () => import('node:crypto').KeyObject = () => privKey,
): LicenseFile {
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
  const sig = sign(null, Buffer.from(canonicalJson(payload)), signer()).toString('base64');
  return { payload, sig };
}

// --- fixture env + tmp tracking ----------------------------------------------

let home: string;
let savedHome: string | undefined;
let savedCloudUrl: string | undefined;
const tmpPaths: string[] = [];

beforeEach(async () => {
  savedHome = process.env.DEVCORTEX_HOME;
  savedCloudUrl = process.env.DEVCORTEX_CLOUD_URL;
  delete process.env.DEVCORTEX_CLOUD_URL;
  home = await mkdtemp(path.join(tmpdir(), 'devcortex-client-'));
  process.env.DEVCORTEX_HOME = home;
  tmpPaths.push(home);
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.DEVCORTEX_HOME;
  else process.env.DEVCORTEX_HOME = savedHome;
  if (savedCloudUrl === undefined) delete process.env.DEVCORTEX_CLOUD_URL;
  else process.env.DEVCORTEX_CLOUD_URL = savedCloudUrl;
  await Promise.all(tmpPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

// --- injected fetcher helpers --------------------------------------------------

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetcher(makeResponse: () => Response): {
  calls: RecordedCall[];
  fetcher: Fetcher;
} {
  const calls: RecordedCall[] = [];
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

function gzipResponse(bytes: Buffer, version?: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/gzip',
      ...(version !== undefined ? { 'x-premium-version': version } : {}),
    },
  });
}

/** The exact wire format the cloud's parseBearer decodes. */
function expectedBearer(license: LicenseFile): string {
  return Buffer.from(JSON.stringify(license), 'utf8').toString('base64');
}

function authHeaderOf(call: RecordedCall): string {
  const auth = new Headers(call.init?.headers).get('authorization');
  expect(auth).not.toBeNull();
  return auth ?? '';
}

// --- cloudBaseUrl ---------------------------------------------------------------

describe('cloudBaseUrl', () => {
  it('defaults to https://cloud.devcortex.dev', () => {
    expect(cloudBaseUrl()).toBe('https://cloud.devcortex.dev');
  });

  it('honors DEVCORTEX_CLOUD_URL and strips trailing slashes', () => {
    process.env.DEVCORTEX_CLOUD_URL = 'http://localhost:3000/';
    expect(cloudBaseUrl()).toBe('http://localhost:3000');
  });
});

// --- downloadPremium --------------------------------------------------------------

describe('downloadPremium', () => {
  it('GETs the download route with the exact wire bearer and honors x-premium-version', async () => {
    const license = makeLicense();
    const bytes = Buffer.from('fake-premium-tgz-bytes');
    const { calls, fetcher } = recordingFetcher(() => gzipResponse(bytes, '2.3.4'));

    const { tgzPath, version } = await downloadPremium(license, { fetcher });
    tmpPaths.push(path.dirname(tgzPath));

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('unreachable: one call recorded');
    expect(call.url).toBe('https://cloud.devcortex.dev/api/v1/premium/download');

    // Wire bearer: base64 of the LicenseFile JSON — decode it exactly the way
    // the cloud's parseBearer does and require the same LicenseFile back.
    const auth = authHeaderOf(call);
    expect(auth).toBe(`Bearer ${expectedBearer(license)}`);
    const decoded: unknown = JSON.parse(
      Buffer.from(auth.slice('Bearer '.length), 'base64').toString('utf8'),
    );
    expect(decoded).toEqual(license);

    expect(version).toBe('2.3.4');
    await expect(readFile(tgzPath)).resolves.toEqual(bytes);
  });

  it('appends ?version= when opts.version is set and falls back to it when the header is missing', async () => {
    const license = makeLicense();
    const { calls, fetcher } = recordingFetcher(() => gzipResponse(Buffer.from('x')));

    const { tgzPath, version } = await downloadPremium(license, { version: '1.0.0', fetcher });
    tmpPaths.push(path.dirname(tgzPath));

    expect(calls[0]?.url).toBe(
      'https://cloud.devcortex.dev/api/v1/premium/download?version=1.0.0',
    );
    expect(version).toBe('1.0.0');
  });

  it('prefers the x-premium-version header over opts.version', async () => {
    const license = makeLicense();
    const { fetcher } = recordingFetcher(() => gzipResponse(Buffer.from('x'), '9.9.9'));
    const { tgzPath, version } = await downloadPremium(license, { version: '1.0.0', fetcher });
    tmpPaths.push(path.dirname(tgzPath));
    expect(version).toBe('9.9.9');
  });

  it('throws when neither the header nor opts.version names the bundle version', async () => {
    const license = makeLicense();
    const { fetcher } = recordingFetcher(() => gzipResponse(Buffer.from('x')));
    await expect(downloadPremium(license, { fetcher })).rejects.toBeInstanceOf(DevCortexError);
  });

  it('uses DEVCORTEX_CLOUD_URL as the base when set', async () => {
    process.env.DEVCORTEX_CLOUD_URL = 'http://localhost:4001';
    const license = makeLicense();
    const { calls, fetcher } = recordingFetcher(() => gzipResponse(Buffer.from('x'), '1.2.3'));
    const { tgzPath } = await downloadPremium(license, { fetcher });
    tmpPaths.push(path.dirname(tgzPath));
    expect(calls[0]?.url).toBe('http://localhost:4001/api/v1/premium/download');
  });

  it('throws a DevCortexError naming the status and the {error} body on non-200', async () => {
    const license = makeLicense();
    const { fetcher } = recordingFetcher(() =>
      jsonResponse(500, { ok: false, error: { code: 'internal', message: 'internal server error' } }),
    );
    const err = await downloadPremium(license, { fetcher })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevCortexError);
    expect((err as DevCortexError).message).toContain('500');
    expect((err as DevCortexError).message).toContain('internal server error');
  });

  it.each([401, 403])(
    'maps HTTP %i to an actionable license error naming `devcortex premium activate`',
    async (status) => {
      const license = makeLicense();
      const { fetcher } = recordingFetcher(() =>
        jsonResponse(status, {
          ok: false,
          error: { code: 'unauthenticated', message: 'license is unknown or has been revoked' },
        }),
      );
      const err = await downloadPremium(license, { fetcher })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DevCortexError);
      expect((err as DevCortexError).message).toContain('devcortex premium activate');
      expect((err as DevCortexError).message).toContain(String(status));
    },
  );
});

// --- refreshRemote -----------------------------------------------------------------

describe('refreshRemote', () => {
  it('POSTs the refresh route with the wire bearer and returns the parsed license', async () => {
    const license = makeLicense();
    const renewed = makeLicense({ exp: new Date(Date.now() + 60 * 86400_000).toISOString() });
    const { calls, fetcher } = recordingFetcher(() =>
      jsonResponse(200, { ok: true, license: renewed }),
    );

    const result = await refreshRemote(license, { fetcher });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('unreachable: one call recorded');
    expect(call.url).toBe('https://cloud.devcortex.dev/api/v1/licenses/refresh');
    expect(call.init?.method).toBe('POST');
    expect(authHeaderOf(call)).toBe(`Bearer ${expectedBearer(license)}`);
    expect(result).toEqual(renewed);
  });

  it.each([
    ['license not file-shaped', { ok: true, license: { nope: 1 } }],
    ['license missing', { ok: true }],
    ['ok:false on a 200', { ok: false, license: null }],
  ])('rejects a malformed 200 body (%s) with a DevCortexError', async (_name, body) => {
    const license = makeLicense();
    const { fetcher } = recordingFetcher(() => jsonResponse(200, body));
    await expect(refreshRemote(license, { fetcher })).rejects.toBeInstanceOf(DevCortexError);
  });

  it('rejects a non-JSON 200 body with a DevCortexError', async () => {
    const license = makeLicense();
    const { fetcher } = recordingFetcher(
      () => new Response('gzip? no.', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(refreshRemote(license, { fetcher })).rejects.toBeInstanceOf(DevCortexError);
  });

  it.each([401, 403])(
    'maps HTTP %i to an actionable license error naming `devcortex premium activate`',
    async (status) => {
      const license = makeLicense();
      const { fetcher } = recordingFetcher(() =>
        jsonResponse(status, { ok: false, error: { code: 'unauthenticated', message: 'revoked' } }),
      );
      const err = await refreshRemote(license, { fetcher })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DevCortexError);
      expect((err as DevCortexError).message).toContain('devcortex premium activate');
      expect((err as DevCortexError).message).toContain(String(status));
    },
  );

  it('includes the status on other non-200 responses', async () => {
    const license = makeLicense();
    const { fetcher } = recordingFetcher(() =>
      jsonResponse(500, { ok: false, error: { code: 'internal', message: 'internal server error' } }),
    );
    const err = await refreshRemote(license, { fetcher })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevCortexError);
    expect((err as DevCortexError).message).toContain('500');
  });
});

// --- maybeRefresh -------------------------------------------------------------------

describe('maybeRefresh', () => {
  it('refreshes a grace-window license, verifies locally, persists, and returns it', async () => {
    const grace = makeLicense({ exp: new Date(Date.now() - 5 * 86400_000).toISOString() });
    const check = verifyLicenseFile(grace, { publicKeysPem: [pubPem] });
    expect(check.state).toBe('grace');

    const renewed = makeLicense({ exp: new Date(Date.now() + 30 * 86400_000).toISOString() });
    const { calls, fetcher } = recordingFetcher(() =>
      jsonResponse(200, { ok: true, license: renewed }),
    );

    const result = await maybeRefresh(grace, check, { fetcher, publicKeysPem: [pubPem] });

    expect(calls).toHaveLength(1);
    expect(result).toEqual(renewed);
    await expect(readLicenseFile()).resolves.toEqual(renewed); // persisted under DEVCORTEX_HOME
  });

  it('refreshes a valid license expiring within 7 days', async () => {
    const nearExpiry = makeLicense({ exp: new Date(Date.now() + 3 * 86400_000).toISOString() });
    const check = verifyLicenseFile(nearExpiry, { publicKeysPem: [pubPem] });
    expect(check.state).toBe('valid');

    const renewed = makeLicense({ exp: new Date(Date.now() + 30 * 86400_000).toISOString() });
    const { calls, fetcher } = recordingFetcher(() =>
      jsonResponse(200, { ok: true, license: renewed }),
    );

    const result = await maybeRefresh(nearExpiry, check, { fetcher, publicKeysPem: [pubPem] });
    expect(calls).toHaveLength(1);
    expect(result).toEqual(renewed);
  });

  it('skips (and never calls the fetcher) when the expiry is far away', async () => {
    const fresh = makeLicense(); // exp = +30 days
    const check = verifyLicenseFile(fresh, { publicKeysPem: [pubPem] });
    const { calls, fetcher } = recordingFetcher(() => jsonResponse(200, { ok: true }));

    const result = await maybeRefresh(fresh, check, { fetcher, publicKeysPem: [pubPem] });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('swallows a rejecting fetcher (offline is normal) and returns null', async () => {
    const grace = makeLicense({ exp: new Date(Date.now() - 5 * 86400_000).toISOString() });
    const check = verifyLicenseFile(grace, { publicKeysPem: [pubPem] });
    const fetcher: Fetcher = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await maybeRefresh(grace, check, { fetcher, publicKeysPem: [pubPem] });
    expect(result).toBeNull();
    await expect(readLicenseFile()).resolves.toBeNull(); // nothing persisted
  });

  it('refuses to persist a returned license that fails local verification', async () => {
    const grace = makeLicense({ exp: new Date(Date.now() - 5 * 86400_000).toISOString() });
    const check = verifyLicenseFile(grace, { publicKeysPem: [pubPem] });

    // Signed by a key OUTSIDE the trusted set — the wire cannot be trusted.
    const forged = makeLicense(
      { exp: new Date(Date.now() + 30 * 86400_000).toISOString() },
      () => otherPrivKey,
    );
    const { fetcher } = recordingFetcher(() => jsonResponse(200, { ok: true, license: forged }));

    const result = await maybeRefresh(grace, check, { fetcher, publicKeysPem: [pubPem] });
    expect(result).toBeNull();
    await expect(readLicenseFile()).resolves.toBeNull(); // forged file never stored
  });
});
