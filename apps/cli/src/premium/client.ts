// ============================================================================
// DevCortex Cloud client — remote premium download + license refresh.
//
// WIRE BEARER (locked to the cloud's `parseBearer` in devcortex-cloud
// `src/services/licenses.ts`): `Authorization: Bearer <base64(JSON.stringify
// (licenseFile))>` — base64 of the LicenseFile `{ payload, sig }` JSON. The
// server JSON.parses it and re-computes `canonicalJson(payload)` itself for
// signature verification, so canonicalJson never appears on the wire.
//
// TRUST BOUNDARY: nothing returned by the cloud is trusted blindly. This
// module shape-checks wire responses; callers MUST run the returned license
// through `verifyLicenseFile` before persisting or acting on it (both
// `maybeRefresh` below and `cmdPremiumRefresh` do exactly that). Downloaded
// bundles are verified by `installFromTarball` + the loader handshake.
//
// The fetcher is injectable (`opts.fetcher`) so tests never touch the
// network; production uses the Node 20+ global `fetch`.
// ============================================================================

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DevCortexError } from '@devcortex/core';

import { verifyLicenseFile } from './license';
import type { LicenseCheck, LicenseFile } from './license';
import { writeLicenseFile } from './store';

export type Fetcher = typeof fetch;

const DAY_MS = 86_400_000;
/** `maybeRefresh` fires when the license expires within this window. */
const REFRESH_WINDOW_MS = 7 * DAY_MS;
/** `maybeRefresh` gives the cloud this long before giving up silently. */
const REFRESH_TIMEOUT_MS = 3_000;

/** Cloud base URL: `$DEVCORTEX_CLOUD_URL` (trailing slashes stripped) or prod. */
export function cloudBaseUrl(): string {
  const override = process.env.DEVCORTEX_CLOUD_URL;
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim().replace(/\/+$/, '');
  }
  return 'https://cloud.devcortex.dev';
}

/**
 * The exact wire bearer the cloud's `parseBearer` decodes: base64 of the
 * LicenseFile JSON. Callers should pass the VERIFIED-echo file (`payload`
 * re-materialized from signed bytes + original `sig`) so unsigned extra
 * fields from a hand-edited store never reach the wire.
 */
export function licenseBearer(license: LicenseFile): string {
  return Buffer.from(JSON.stringify(license), 'utf8').toString('base64');
}

// --- wire-shape guards (wire SHAPE only — signatures are verified by callers) --

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shallow `{ payload, sig }` check for wire responses. Deliberately NOT the
 * deep payload guard: `verifyLicenseFile` re-guards the payload from the
 * exact signed bytes before anything is persisted, so duplicating the field
 * checks here would only invite drift.
 */
function isLicenseFileShaped(value: unknown): value is LicenseFile {
  return isRecord(value) && typeof value.sig === 'string' && isRecord(value.payload);
}

// --- error mapping ------------------------------------------------------------

/** Best-effort extraction of the cloud's `{ ok, error: { message } }` body. */
async function errorDetailOf(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (isRecord(body)) {
      const error = body.error;
      if (typeof error === 'string') return error;
      if (isRecord(error) && typeof error.message === 'string') return error.message;
    }
  } catch {
    // Non-JSON error body — the status alone will have to do.
  }
  return '';
}

/**
 * Map a non-200 cloud response to a clean DevCortexError. 401 AND 403 both
 * mean "this license no longer authenticates" (revoked, expired past grace,
 * or malformed) — surface the recovery command instead of a raw HTTP error.
 */
async function errorFromResponse(res: Response, what: string): Promise<DevCortexError> {
  const detail = await errorDetailOf(res);
  const suffix = detail.length > 0 ? `: ${detail}` : '';
  if (res.status === 401 || res.status === 403) {
    return new DevCortexError(
      'INTERNAL',
      `${what} was rejected by DevCortex Cloud (HTTP ${res.status})${suffix} — the license ` +
        'may be revoked or out of date. Re-activate with a current license via ' +
        '`devcortex premium activate <license.json>`, or renew at https://cloud.devcortex.dev.',
    );
  }
  return new DevCortexError('INTERNAL', `${what} failed (HTTP ${res.status})${suffix}.`);
}

// --- download -------------------------------------------------------------------

/**
 * GET `/api/v1/premium/download[?version=x.y.z]` with the wire bearer and
 * spool the gzip body to a fresh tmp file. The version comes from the
 * `x-premium-version` response header (falling back to `opts.version`); it is
 * returned RAW — `installFromTarball` allowlist-validates it before it ever
 * names a directory, and the tmp file name never embeds it.
 *
 * Callers own the returned tmp file's lifetime (remove its parent dir when
 * done — `cmdPremiumInstall` does).
 */
export async function downloadPremium(
  license: LicenseFile,
  opts?: { version?: string; fetcher?: Fetcher },
): Promise<{ tgzPath: string; version: string }> {
  const fetcher = opts?.fetcher ?? fetch;
  const query =
    opts?.version !== undefined && opts.version.trim().length > 0
      ? `?version=${encodeURIComponent(opts.version.trim())}`
      : '';
  const res = await fetcher(`${cloudBaseUrl()}/api/v1/premium/download${query}`, {
    headers: { authorization: `Bearer ${licenseBearer(license)}` },
  });
  if (res.status !== 200) {
    throw await errorFromResponse(res, 'Premium download');
  }

  const headerVersion = res.headers.get('x-premium-version')?.trim() ?? '';
  const version = headerVersion.length > 0 ? headerVersion : (opts?.version?.trim() ?? '');
  if (version.length === 0) {
    throw new DevCortexError(
      'INTERNAL',
      'DevCortex Cloud did not name the bundle version (missing x-premium-version header) — ' +
        'retry with an explicit --version.',
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const dir = await mkdtemp(path.join(tmpdir(), 'devcortex-premium-dl-'));
  const tgzPath = path.join(dir, 'premium-bundle.tgz'); // fixed name: no wire value in the path
  await writeFile(tgzPath, bytes);
  return { tgzPath, version };
}

// --- refresh --------------------------------------------------------------------

/**
 * POST `/api/v1/licenses/refresh` with the wire bearer and return the
 * re-signed LicenseFile from the `{ ok: true, license }` body. The body is
 * wire-shape-checked only — callers MUST `verifyLicenseFile` the result
 * before persisting it (never trust the wire blindly).
 */
export async function refreshRemote(
  license: LicenseFile,
  opts?: { fetcher?: Fetcher; signal?: AbortSignal },
): Promise<LicenseFile> {
  const fetcher = opts?.fetcher ?? fetch;
  const res = await fetcher(`${cloudBaseUrl()}/api/v1/licenses/refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${licenseBearer(license)}` },
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  });
  if (res.status !== 200) {
    throw await errorFromResponse(res, 'License refresh');
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new DevCortexError(
      'INTERNAL',
      'License refresh returned a non-JSON body — DevCortex Cloud answered with something ' +
        'other than a license.',
      { cause: err },
    );
  }
  if (!isRecord(body) || body.ok !== true || !isLicenseFileShaped(body.license)) {
    throw new DevCortexError(
      'INTERNAL',
      'License refresh returned a malformed body — expected { ok: true, license: { payload, sig } }.',
    );
  }
  return body.license;
}

// --- opportunistic auto-refresh ----------------------------------------------------

/**
 * Fire-and-forget refresh when the license is in grace or expires within
 * 7 days (spec PB-0 pt 4 "weekly background refresh"). 3s timeout, every
 * failure silent — offline is normal. The returned license is verified
 * locally against the trusted keys and persisted via the verified-echo
 * discipline (payload from signed bytes + wire sig) before being returned;
 * anything less than valid/grace is discarded.
 *
 * Returns the persisted LicenseFile when a refresh landed, null otherwise.
 * Callers MUST NOT await this on a hot path — `cmdPremiumStatus` awaits it
 * (user-facing); nothing else does.
 *
 * `publicKeysPem` is the same test/staging-only seam as everywhere else in
 * the premium stack.
 */
export async function maybeRefresh(
  license: LicenseFile,
  check: LicenseCheck,
  opts?: { fetcher?: Fetcher; publicKeysPem?: readonly string[] },
): Promise<LicenseFile | null> {
  try {
    if (check.state === 'invalid') return null; // unverifiable input never goes on the wire
    const exp = check.payload !== undefined ? Date.parse(check.payload.exp) : Number.NaN;
    const due =
      check.state === 'grace' ||
      (Number.isFinite(exp) && exp - Date.now() < REFRESH_WINDOW_MS);
    if (!due) return null;

    const refreshed = await refreshRemote(license, {
      ...(opts?.fetcher !== undefined ? { fetcher: opts.fetcher } : {}),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });

    const verified = verifyLicenseFile(
      refreshed,
      opts?.publicKeysPem !== undefined ? { publicKeysPem: opts.publicKeysPem } : undefined,
    );
    if ((verified.state !== 'valid' && verified.state !== 'grace') || verified.payload === undefined) {
      return null; // wire returned something the trusted keys did not sign — discard
    }

    const stored: LicenseFile = { payload: verified.payload, sig: refreshed.sig };
    await writeLicenseFile(stored);
    return stored;
  } catch {
    return null; // silent by contract: offline / flaky cloud must never surface here
  }
}
