import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initWorkspace, scanProject } from '@devcortex/core';

import { cmdDaemonStatus, cmdDaemonStop } from '../src/daemon';
import type { GlobalOptions } from '../src/runtime';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-cli-daemon-'));
  await writeFile(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { next: '^15.0.0' } }),
    'utf8',
  );
  const graph = await scanProject(tmp);
  await initWorkspace(tmp, { mode: 'passive', stack: graph.stack, graph });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function globals(root: string): GlobalOptions {
  return { root, json: false };
}

describe('daemon CLI commands', () => {
  it('status reports not-running on a fresh workspace', async () => {
    const res = await cmdDaemonStatus(globals(tmp));
    expect((res.data as { running: boolean }).running).toBe(false);
    expect(res.human.toLowerCase()).toContain('not running');
  });

  it('stop is a safe no-op when the daemon is not running', async () => {
    const res = await cmdDaemonStop(globals(tmp));
    expect((res.data as { status: string }).status).toBe('not-running');
  });
});
