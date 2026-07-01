/**
 * Privacy & Redaction Engine (§7.22) — classifyOutbound (outbound disclosure).
 *
 * `classifyOutbound` is the gate every cloud transmission passes through, and it
 * is fail-safe by privacy mode. These tests exercise it against a REAL temp
 * workspace (no mocks — the engine reads the disk it will actually read), and
 * assert the mode-scoped contract exactly:
 *
 *   local-only     → nothing leaves; manifest empty, optOut true, disk untouched.
 *   metadata-cloud → only anonymized {ext,bytes} metadata leaves; sizeBytes is
 *                    the metadata payload, never the file.
 *   deep-cloud     → contents leave, redacted first; sizeBytes is the *redacted*
 *                    payload; the redaction tally drives the disclosure reason.
 *
 * Plus the fail-safe drops (out-of-root, missing, directory, blank) and the
 * static-contract guards (empty root, non-array files, unknown mode).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrivacyMode } from '../domain/index';
import { isDevCortexError } from '../domain/index';

import { classifyOutbound, redactText } from './index';

// A syntactically valid OpenAI-shaped key so redactText has a real match.
const OPENAI_KEY = `sk-proj${'ABCDEF0123456789ghijklmnop'}`;
const SECRET_FILE_BODY = `const client = "${OPENAI_KEY}";\nexport default client;\n`;
const CLEAN_FILE_BODY = 'export const answer = 42;\n// no secrets here\n';

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dc-outbound-'));
  writeFileSync(path.join(root, 'secret.ts'), SECRET_FILE_BODY, 'utf8');
  writeFileSync(path.join(root, 'clean.ts'), CLEAN_FILE_BODY, 'utf8');
  mkdirSync(path.join(root, 'sub'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('classifyOutbound — local-only mode (nothing leaves)', () => {
  it('returns an empty, opted-out manifest and never touches the disk', async () => {
    const manifest = await classifyOutbound(root, ['secret.ts', 'clean.ts'], 'local-only');

    expect(manifest.mode).toBe('local-only');
    expect(manifest.files).toEqual([]);
    expect(manifest.totalBytes).toBe(0);
    expect(manifest.retention).toBe('none');
    expect(manifest.optOut).toBe(true);
  });
});

describe('classifyOutbound — metadata-cloud mode (only anonymized metadata leaves)', () => {
  it('discloses ext + size metadata only, sized to the metadata payload not the file', async () => {
    const manifest = await classifyOutbound(root, ['secret.ts'], 'metadata-cloud');

    expect(manifest.mode).toBe('metadata-cloud');
    expect(manifest.retention).toBe('30d');
    expect(manifest.optOut).toBe(false);
    expect(manifest.files).toHaveLength(1);

    const [entry] = manifest.files;
    expect(entry).toBeDefined();
    if (!entry) throw new Error('unreachable: entry asserted present');

    expect(entry.path).toBe('secret.ts');
    expect(entry.redacted).toBe(true);
    expect(entry.reason).toMatch(/only anonymized file type and size leave/);

    // sizeBytes must be the metadata JSON, NOT the (larger) file body.
    const expectedMeta = JSON.stringify({ ext: 'ts', bytes: bytesOf(SECRET_FILE_BODY) });
    expect(entry.sizeBytes).toBe(bytesOf(expectedMeta));
    expect(entry.sizeBytes).toBeLessThan(bytesOf(SECRET_FILE_BODY));
    expect(manifest.totalBytes).toBe(entry.sizeBytes);
  });
});

describe('classifyOutbound — deep-cloud mode (redacted contents leave)', () => {
  it('redacts secrets before send, sizes to the redacted payload, and tallies the disclosure', async () => {
    const manifest = await classifyOutbound(root, ['secret.ts'], 'deep-cloud');

    expect(manifest.mode).toBe('deep-cloud');
    expect(manifest.retention).toBe('ephemeral');
    expect(manifest.optOut).toBe(false);

    const [entry] = manifest.files;
    expect(entry).toBeDefined();
    if (!entry) throw new Error('unreachable: entry asserted present');

    const { redacted, findings } = redactText(SECRET_FILE_BODY);
    const masked = findings.reduce((total, f) => total + f.count, 0);
    expect(masked).toBeGreaterThan(0);

    expect(entry.redacted).toBe(true);
    expect(entry.reason).toContain(`${masked} secret/PII occurrence(s) redacted before send`);
    expect(entry.sizeBytes).toBe(bytesOf(redacted));
    expect(manifest.totalBytes).toBe(entry.sizeBytes);
  });

  it('reports "no secrets detected" for a clean file', async () => {
    const manifest = await classifyOutbound(root, ['clean.ts'], 'deep-cloud');

    const [entry] = manifest.files;
    expect(entry).toBeDefined();
    if (!entry) throw new Error('unreachable: entry asserted present');

    expect(entry.reason).toMatch(/no secrets detected/);
    expect(entry.sizeBytes).toBe(bytesOf(CLEAN_FILE_BODY));
  });

  it('sums totalBytes across multiple disclosed files', async () => {
    const manifest = await classifyOutbound(root, ['secret.ts', 'clean.ts'], 'deep-cloud');

    expect(manifest.files).toHaveLength(2);
    const sum = manifest.files.reduce((total, f) => total + f.sizeBytes, 0);
    expect(manifest.totalBytes).toBe(sum);
  });
});

describe('classifyOutbound — fail-safe drops (cannot/must-not send)', () => {
  it('drops a path that escapes the repo root', async () => {
    const manifest = await classifyOutbound(root, ['../escape.ts', 'clean.ts'], 'deep-cloud');
    expect(manifest.files.map((f) => f.path)).toEqual(['clean.ts']);
  });

  it('drops a missing / unreadable file', async () => {
    const manifest = await classifyOutbound(root, ['does-not-exist.ts', 'clean.ts'], 'deep-cloud');
    expect(manifest.files.map((f) => f.path)).toEqual(['clean.ts']);
  });

  it('drops a directory (not a file) — including the root itself', async () => {
    const manifest = await classifyOutbound(root, ['sub', '.', 'clean.ts'], 'deep-cloud');
    expect(manifest.files.map((f) => f.path)).toEqual(['clean.ts']);
  });

  it('skips blank / non-string candidates without throwing', async () => {
    const manifest = await classifyOutbound(
      root,
      ['', 'clean.ts', undefined as unknown as string],
      'metadata-cloud',
    );
    expect(manifest.files.map((f) => f.path)).toEqual(['clean.ts']);
  });

  it('classifies a file with no extension as ext "none" in metadata mode', async () => {
    writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:20\n', 'utf8');
    const manifest = await classifyOutbound(root, ['Dockerfile'], 'metadata-cloud');
    const [entry] = manifest.files;
    expect(entry).toBeDefined();
    if (!entry) throw new Error('unreachable: entry asserted present');
    const expectedMeta = JSON.stringify({ ext: 'none', bytes: bytesOf('FROM node:20\n') });
    expect(entry.sizeBytes).toBe(bytesOf(expectedMeta));
  });
});

describe('classifyOutbound — static-contract guards', () => {
  it('rejects an empty root with an INTERNAL DevCortexError', async () => {
    await expect(classifyOutbound('', ['clean.ts'], 'deep-cloud')).rejects.toSatisfy(
      (err: unknown) => isDevCortexError(err) && err.code === 'INTERNAL',
    );
  });

  it('rejects a non-array files argument with an INTERNAL DevCortexError', async () => {
    await expect(
      classifyOutbound(root, undefined as unknown as string[], 'deep-cloud'),
    ).rejects.toSatisfy((err: unknown) => isDevCortexError(err) && err.code === 'INTERNAL');
  });

  it('rejects an unknown privacy mode with an INTERNAL DevCortexError', async () => {
    await expect(
      classifyOutbound(root, ['clean.ts'], 'bogus-mode' as unknown as PrivacyMode),
    ).rejects.toSatisfy((err: unknown) => isDevCortexError(err) && err.code === 'INTERNAL');
  });
});
