import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initWorkspace, scanProject } from '@devcortex/core';

import { startDaemon } from '../src/index';
import type { DaemonHandle } from '../src/index';

let tmp: string;
let daemon: DaemonHandle | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-daemon-'));
  await writeFile(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { next: '^15.0.0', react: '^19.0.0' } }),
    'utf8',
  );
  const graph = await scanProject(tmp);
  await initWorkspace(tmp, { mode: 'passive', stack: graph.stack, graph });
});

afterEach(async () => {
  if (daemon !== undefined) {
    await daemon.close();
    daemon = undefined;
  }
  await rm(tmp, { recursive: true, force: true });
});

async function fetchJson(url: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url);
  return { status: res.status, json: await res.json() };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

describe('daemon', () => {
  it('serves /api/health with ok + root + mode + version', async () => {
    daemon = await startDaemon(tmp, { port: 0 });
    const { status, json } = await fetchJson(`${daemon.url}/api/health`);
    const body = asRecord(json);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.root).toBe(tmp);
    expect(body.mode).toBe('passive');
    expect(typeof body.version).toBe('string');
  });

  it('serves ready-score, features (array), and the scanned graph', async () => {
    daemon = await startDaemon(tmp, { port: 0 });

    const score = await fetchJson(`${daemon.url}/api/ready-score`);
    expect(score.status).toBe(200);
    expect(typeof asRecord(score.json).score).toBe('number');

    const feats = await fetchJson(`${daemon.url}/api/features`);
    expect(feats.status).toBe(200);
    expect(Array.isArray(feats.json)).toBe(true);

    const graph = await fetchJson(`${daemon.url}/api/graph`);
    expect(graph.status).toBe(200);
    expect(asRecord(asRecord(graph.json).stack).framework).toBe('nextjs');
  });

  it('returns a structured 404 for an unknown API route', async () => {
    daemon = await startDaemon(tmp, { port: 0 });
    const { status, json } = await fetchJson(`${daemon.url}/api/does-not-exist`);
    expect(status).toBe(404);
    expect(asRecord(asRecord(json).error).code).toBe('INTERNAL');
  });

  it('serves an HTML page at / (dashboard build or placeholder)', async () => {
    daemon = await startDaemon(tmp, { port: 0 });
    const res = await fetch(`${daemon.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect((await res.text()).toLowerCase()).toContain('<!doctype html>');
  });

  it('rejects a non-GET method with 405', async () => {
    daemon = await startDaemon(tmp, { port: 0 });
    const res = await fetch(`${daemon.url}/api/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
