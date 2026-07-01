import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@devcortex/core';
import {
  AGENTS_BLOCK_BEGIN,
  AGENTS_BLOCK_END,
  buildAgentsBlock,
  buildCodexConfigBlock,
  CODEX_BLOCK_BEGIN,
  CODEX_BLOCK_END,
  DEVCORTEX_MCP_SERVER_NAME,
  installCodex,
  mergeAgentsDoc,
  mergeCodexConfig,
  mergeDelimitedBlock,
} from '../src/index';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devcortex-codex-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const agentsPath = (root: string): string => join(root, 'AGENTS.md');
const codexPath = (root: string): string => join(root, '.codex', 'config.toml');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe('builders', () => {
  it('buildAgentsBlock is delimited and instructs preflight / protected paths / ship', () => {
    const block = buildAgentsBlock();
    expect(block.startsWith(AGENTS_BLOCK_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(AGENTS_BLOCK_END)).toBe(true);
    // No trailing newline: the merge primitive owns line termination.
    expect(block.endsWith('\n')).toBe(false);

    expect(block).toContain('## DevCortex');
    expect(block).toContain('devcortex preflight "<one-line description of the task>"');
    expect(block).toContain('protected path');
    expect(block).toContain('devcortex ship');
    expect(block).toContain('Evidence over claims');
    expect(block).toContain('fails open');
  });

  it('buildCodexConfigBlock registers the devcortex-mcp stdio server (canonical Codex table)', () => {
    const block = buildCodexConfigBlock();
    expect(block.startsWith(CODEX_BLOCK_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(CODEX_BLOCK_END)).toBe(true);
    expect(block.endsWith('\n')).toBe(false);

    expect(block).toContain(`[mcp_servers.${DEVCORTEX_MCP_SERVER_NAME}]`);
    expect(block).toContain('command = "devcortex-mcp"');
    expect(block).toContain('args = []');
    // Portable: no absolute paths baked into a potentially-committed config file.
    expect(block).not.toContain(tmpdir());
  });

  it('mergeDelimitedBlock: fresh (null) yields block + trailing newline', () => {
    const block = 'B:BEGIN\nbody\nB:END';
    expect(mergeDelimitedBlock(null, block, 'B:BEGIN', 'B:END')).toBe(`${block}\n`);
    expect(mergeDelimitedBlock('   \n\t', block, 'B:BEGIN', 'B:END')).toBe(`${block}\n`);
  });

  it('mergeDelimitedBlock: appends after foreign content and is idempotent', () => {
    const block = 'B:BEGIN\nbody\nB:END';
    const once = mergeDelimitedBlock('user stuff\n', block, 'B:BEGIN', 'B:END');
    expect(once).toBe('user stuff\n\nB:BEGIN\nbody\nB:END\n');
    // Re-splicing the same block reproduces identical bytes.
    expect(mergeDelimitedBlock(once, block, 'B:BEGIN', 'B:END')).toBe(once);
  });

  it('mergeDelimitedBlock: replaces only the managed region, preserving surrounds', () => {
    const existing = 'HEAD\n\nB:BEGIN\nOLD\nB:END\n\nTAIL\n';
    const block = 'B:BEGIN\nNEW\nB:END';
    expect(mergeDelimitedBlock(existing, block, 'B:BEGIN', 'B:END')).toBe(
      'HEAD\n\nB:BEGIN\nNEW\nB:END\n\nTAIL\n',
    );
  });

  it('mergeDelimitedBlock: throws ConfigError on a BEGIN with no matching END', () => {
    expect(() =>
      mergeDelimitedBlock('B:BEGIN\nhalf a block\n', 'B:BEGIN\nx\nB:END', 'B:BEGIN', 'B:END'),
    ).toThrow(ConfigError);
  });

  it('mergeAgentsDoc / mergeCodexConfig are idempotent', () => {
    const agentsOnce = mergeAgentsDoc(null);
    expect(mergeAgentsDoc(agentsOnce)).toBe(agentsOnce);
    const codexOnce = mergeCodexConfig(null);
    expect(mergeCodexConfig(codexOnce)).toBe(codexOnce);
  });
});

// ---------------------------------------------------------------------------

describe('installCodex — fresh install', () => {
  it('creates AGENTS.md and .codex/config.toml with the expected shapes', async () => {
    const result = await installCodex(dir);
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');

    expect(result.files).toHaveLength(2);
    expect(result.files.every((f) => f.action === 'create')).toBe(true);

    const agents = await readFile(agentsPath(dir), 'utf8');
    expect(agents).toContain(AGENTS_BLOCK_BEGIN);
    expect(agents).toContain(AGENTS_BLOCK_END);
    expect(agents).toContain('devcortex preflight');
    expect(agents).toContain('devcortex ship');

    const codex = await readFile(codexPath(dir), 'utf8');
    expect(codex).toContain(CODEX_BLOCK_BEGIN);
    expect(codex).toContain(`[mcp_servers.${DEVCORTEX_MCP_SERVER_NAME}]`);
    expect(codex).toContain('command = "devcortex-mcp"');
  });

  it('does not require force on a clean repository', async () => {
    const result = await installCodex(dir, { force: false });
    expect(result.status).toBe('applied');
  });
});

// ---------------------------------------------------------------------------

describe('installCodex — idempotency', () => {
  it('a second identical install rewrites nothing and reports all files unchanged', async () => {
    await installCodex(dir);
    const agentsBefore = await readFile(agentsPath(dir), 'utf8');
    const codexBefore = await readFile(codexPath(dir), 'utf8');

    const second = await installCodex(dir);
    expect(second.status).toBe('applied');
    if (second.status !== 'applied') throw new Error('expected applied');
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);

    // Byte-for-byte stable.
    expect(await readFile(agentsPath(dir), 'utf8')).toBe(agentsBefore);
    expect(await readFile(codexPath(dir), 'utf8')).toBe(codexBefore);
  });

  it('force on an already-installed repo still rewrites nothing identical', async () => {
    await installCodex(dir);
    const forced = await installCodex(dir, { force: true });
    expect(forced.status).toBe('applied');
    if (forced.status !== 'applied') throw new Error('expected applied');
    expect(forced.files.every((f) => f.action === 'unchanged')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('installCodex — confirm-before-overwrite (plan vs force)', () => {
  it('returns a plan and writes nothing when an existing AGENTS.md would change', async () => {
    const original = '# My project\n\nSome existing agent notes.\n';
    await writeFile(agentsPath(dir), original, 'utf8');

    const result = await installCodex(dir, { force: false });
    expect(result.status).toBe('plan');
    if (result.status !== 'plan') throw new Error('expected plan');

    // AGENTS.md is flagged as a merge; the create-only config file is listed too.
    const agentsItem = result.plan.find((p) => p.path === agentsPath(dir));
    expect(agentsItem?.action).toBe('merge');
    expect(result.plan.some((p) => p.path === codexPath(dir) && p.action === 'create')).toBe(true);

    // NOTHING was written: the existing file is untouched and no others appeared.
    expect(await readFile(agentsPath(dir), 'utf8')).toBe(original);
    expect(await exists(codexPath(dir))).toBe(false);
  });

  it('force appends the DevCortex block to an existing AGENTS.md, preserving user content', async () => {
    const original = '# My project\n\nSome existing agent notes.\n';
    await writeFile(agentsPath(dir), original, 'utf8');

    const result = await installCodex(dir, { force: true });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');
    expect(result.files.find((f) => f.path === agentsPath(dir))?.action).toBe('merge');

    const agents = await readFile(agentsPath(dir), 'utf8');
    // User content survives verbatim, DevCortex block is appended after it.
    expect(agents.startsWith('# My project\n\nSome existing agent notes.')).toBe(true);
    expect(agents).toContain(AGENTS_BLOCK_BEGIN);
    expect(agents.indexOf('Some existing agent notes')).toBeLessThan(agents.indexOf(AGENTS_BLOCK_BEGIN));
  });

  it('force merges the DevCortex block into an existing .codex/config.toml, preserving foreign servers', async () => {
    const original =
      'model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "github-mcp"\nargs = []\n';
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(codexPath(dir), original, 'utf8');

    const result = await installCodex(dir, { force: true });
    expect(result.status).toBe('applied');

    const codex = await readFile(codexPath(dir), 'utf8');
    // The user's own top-level setting and foreign MCP server are untouched.
    expect(codex).toContain('model = "gpt-5"');
    expect(codex).toContain('[mcp_servers.github]');
    expect(codex).toContain('command = "github-mcp"');
    // ...and our block is present exactly once.
    expect(codex).toContain(`[mcp_servers.${DEVCORTEX_MCP_SERVER_NAME}]`);
    expect(codex.split(CODEX_BLOCK_BEGIN)).toHaveLength(2);
  });

  it('re-installing over an existing DevCortex install does not duplicate the block', async () => {
    await installCodex(dir);
    const forced = await installCodex(dir, { force: true });
    expect(forced.status).toBe('applied');

    const agents = await readFile(agentsPath(dir), 'utf8');
    const codex = await readFile(codexPath(dir), 'utf8');
    expect(agents.split(AGENTS_BLOCK_BEGIN)).toHaveLength(2);
    expect(agents.split(AGENTS_BLOCK_END)).toHaveLength(2);
    expect(codex.split(CODEX_BLOCK_BEGIN)).toHaveLength(2);
    expect(codex.split(CODEX_BLOCK_END)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('installCodex — error handling', () => {
  it('throws ConfigError when an existing AGENTS.md has a corrupt DevCortex block', async () => {
    // BEGIN marker present, END marker missing → refuse to overwrite.
    await writeFile(agentsPath(dir), `intro\n${AGENTS_BLOCK_BEGIN}\ntruncated...\n`, 'utf8');
    await expect(installCodex(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when an existing .codex/config.toml has a corrupt DevCortex block', async () => {
    await mkdir(join(dir, '.codex'), { recursive: true });
    await writeFile(codexPath(dir), `${CODEX_BLOCK_BEGIN}\ncommand = "x"\n`, 'utf8');
    await expect(installCodex(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects an empty or whitespace target root', async () => {
    await expect(installCodex('   ')).rejects.toThrow(/non-empty target root/);
  });
});
