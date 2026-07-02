// ============================================================================
// Unit tests for command implementations in commands.ts.
//
// These tests call command functions directly (bypassing CLI parsing) and pass
// GlobalOptions objects directly — `readGlobals` is never invoked here, so
// we never touch the filesystem for option resolution.
// ============================================================================

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import * as commands from '../src/commands';

// The transcript-basic.jsonl fixture from Task 4 (packages/core/src/runs/__fixtures__/).
const FIXTURE_JSONL = fileURLToPath(
  new URL(
    '../../../packages/core/src/runs/__fixtures__/transcript-basic.jsonl',
    import.meta.url,
  ),
);

/**
 * Creates a temp directory, copies the Task 4 transcript fixture in as t.jsonl,
 * and initializes the workspace (.cortex/ scaffold) so commands that require an
 * initialized workspace (e.g. cmdPreflight) work without a live repo.
 */
async function makeFixtureWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'devcortex-cli-'));
  await copyFile(FIXTURE_JSONL, path.join(root, 't.jsonl'));
  await commands.cmdInit({ root, json: false }, { force: false });
  return root;
}

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------

describe('cmdBrief', () => {
  it('cmdBrief returns the brief text and ok:true even when uninitialized', async () => {
    const result = await commands.cmdBrief({ root: '/tmp/not-a-workspace-xyz', json: false });
    expect(result.data).toMatchObject({ ok: true });
    expect(result.human).toContain('devcortex init');
  });
});

// ---------------------------------------------------------------------------

describe('cmdDistill', () => {
  it('cmdDistill never blocks and reports the outcome', async () => {
    const root = await makeFixtureWorkspace();
    tmpRoots.push(root);
    const transcript = path.join(root, 't.jsonl');
    const outcome = await commands.cmdDistill({ root, json: true }, { transcriptPath: transcript });
    expect(outcome.blocked).toBe(false);
    expect(outcome.data).toMatchObject({ ok: true });
  });

  it('cmdDistill with no transcript resolves passively', async () => {
    const outcome = await commands.cmdDistill({ root: '/tmp/nowhere-xyz', json: true }, {});
    expect(outcome.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('cmdPreflight', () => {
  it('cmdPreflight degrades under an impossible budget instead of blowing it', async () => {
    const root = await makeFixtureWorkspace();
    tmpRoots.push(root);
    process.env.DEVCORTEX_PREFLIGHT_BUDGET_MS = '1';
    try {
      const result = await commands.cmdPreflight({ root, json: true }, 'change the date parser');
      expect(result.data).toMatchObject({ ok: true, degraded: true });
      expect((result.data as { blastRadius: unknown }).blastRadius).toBeNull();
    } finally {
      delete process.env.DEVCORTEX_PREFLIGHT_BUDGET_MS;
    }
  });

  it('cmdPreflight reports degraded:false under a generous budget', async () => {
    const root = await makeFixtureWorkspace();
    tmpRoots.push(root);
    const result = await commands.cmdPreflight({ root, json: true }, 'change the date parser');
    expect(result.data).toMatchObject({ degraded: false });
  });
});
