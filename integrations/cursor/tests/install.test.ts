import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@devcortex/core';
import {
  buildCursorRule,
  buildCursorRuleBody,
  buildCursorRuleFrontmatter,
  buildMcpConfig,
  CURSOR_MCP_PATH,
  CURSOR_RULE_PATH,
  DEVCORTEX_MCP_SERVER_NAME,
  installCursor,
  mergeMcpConfig,
  serializeCursorFrontmatter,
} from '../src/index';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devcortex-cursor-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rulePath = (root: string): string => join(root, ...CURSOR_RULE_PATH.split('/'));
const mcpPath = (root: string): string => join(root, ...CURSOR_MCP_PATH.split('/'));

async function readJson(path: string): Promise<Record<string, unknown>> {
  // JSON.parse returns `any`; tests intentionally treat parsed config loosely.
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal, dependency-free MDC frontmatter parser used only by the tests to
 * assert the generated rule has structurally valid frontmatter. Handles the two
 * scalar shapes the builder emits: double-quoted strings and booleans.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | boolean>;
  body: string;
} {
  const lines = content.split('\n');
  if (lines[0] !== '---') throw new Error('rule does not open with a --- fence');
  const closingIndex = lines.indexOf('---', 1);
  if (closingIndex === -1) throw new Error('rule frontmatter is not closed with a --- fence');

  const frontmatter: Record<string, string | boolean> = {};
  for (let i = 1; i < closingIndex; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const sep = line.indexOf(':');
    if (sep === -1) throw new Error(`invalid frontmatter line: ${line}`);
    const key = line.slice(0, sep).trim();
    const raw = line.slice(sep + 1).trim();
    if (raw === 'true' || raw === 'false') {
      frontmatter[key] = raw === 'true';
    } else if (raw.startsWith('"') && raw.endsWith('"')) {
      frontmatter[key] = JSON.parse(raw) as string;
    } else {
      frontmatter[key] = raw;
    }
  }

  return { frontmatter, body: lines.slice(closingIndex + 1).join('\n') };
}

// ---------------------------------------------------------------------------

describe('builders', () => {
  it('buildMcpConfig registers the devcortex-mcp server with the right command', () => {
    const mcp = buildMcpConfig();
    expect(mcp.mcpServers[DEVCORTEX_MCP_SERVER_NAME]).toEqual({
      command: 'devcortex-mcp',
      args: [],
      env: {},
    });
  });

  it('buildCursorRuleFrontmatter carries description + alwaysApply', () => {
    const fm = buildCursorRuleFrontmatter();
    expect(typeof fm.description).toBe('string');
    expect(fm.description.length).toBeGreaterThan(0);
    expect(fm.alwaysApply).toBe(true);
  });

  it('serializeCursorFrontmatter emits deterministic, valid YAML scalar lines', () => {
    const yaml = serializeCursorFrontmatter(buildCursorRuleFrontmatter());
    const linesOut = yaml.split('\n');
    expect(linesOut[0]?.startsWith('description: "')).toBe(true);
    expect(linesOut[1]).toBe('alwaysApply: true');
  });

  it('buildCursorRule produces valid MDC frontmatter and the discipline body', () => {
    const mdc = buildCursorRule();
    expect(mdc.startsWith('---\n')).toBe(true);
    expect(mdc.endsWith('\n')).toBe(true);

    const { frontmatter, body } = parseFrontmatter(mdc);
    expect(frontmatter.alwaysApply).toBe(true);
    expect(typeof frontmatter.description).toBe('string');
    expect(frontmatter.description as string).toMatch(/DevCortex/);

    // The rule body embeds the four discipline pillars.
    expect(body).toMatch(/preflight/i);
    expect(body).toMatch(/protected path/i);
    expect(body).toMatch(/verify/i);
    expect(body).toMatch(/ship/i);
    expect(body).toMatch(/evidence/i);
    // ...and points the agent at the MCP server.
    expect(body).toContain('devcortex-mcp');
  });

  it('buildCursorRuleBody is a pure function (stable across calls)', () => {
    expect(buildCursorRuleBody()).toBe(buildCursorRuleBody());
  });

  it('mergeMcpConfig preserves foreign servers and is idempotent', () => {
    const existing = { mcpServers: { other: { command: 'other-mcp', args: [], env: {} } } };
    const once = mergeMcpConfig(existing);
    const servers = once.mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ command: 'other-mcp', args: [], env: {} });
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]).toEqual({
      command: 'devcortex-mcp',
      args: [],
      env: {},
    });
    expect(mergeMcpConfig(once)).toEqual(once);
  });
});

// ---------------------------------------------------------------------------

describe('installCursor — fresh install', () => {
  it('creates the .mdc rule and .cursor/mcp.json', async () => {
    const result = await installCursor(dir);
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');

    // Two managed files, both created.
    expect(result.files).toHaveLength(2);
    expect(result.files.every((f) => f.action === 'create')).toBe(true);
    expect(result.files.map((f) => f.path).sort()).toEqual([mcpPath(dir), rulePath(dir)].sort());

    // Rule file exists with valid frontmatter.
    expect(await exists(rulePath(dir))).toBe(true);
    const mdc = await readFile(rulePath(dir), 'utf8');
    const { frontmatter } = parseFrontmatter(mdc);
    expect(frontmatter.alwaysApply).toBe(true);
    expect(frontmatter.description).toBeTypeOf('string');

    // .cursor/mcp.json shape.
    const mcp = await readJson(mcpPath(dir));
    const servers = mcp.mcpServers as Record<string, { command: string }>;
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]?.command).toBe('devcortex-mcp');
  });

  it('does not require force on a clean repository', async () => {
    const result = await installCursor(dir, { force: false });
    expect(result.status).toBe('applied');
  });
});

// ---------------------------------------------------------------------------

describe('installCursor — idempotency', () => {
  it('a second identical install rewrites nothing and reports all files unchanged', async () => {
    await installCursor(dir);
    const ruleBefore = await readFile(rulePath(dir), 'utf8');
    const mcpBefore = await readFile(mcpPath(dir), 'utf8');

    const second = await installCursor(dir);
    expect(second.status).toBe('applied');
    if (second.status !== 'applied') throw new Error('expected applied');
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);

    // Byte-for-byte stable.
    expect(await readFile(rulePath(dir), 'utf8')).toBe(ruleBefore);
    expect(await readFile(mcpPath(dir), 'utf8')).toBe(mcpBefore);
  });

  it('force on an already-installed repo still rewrites nothing identical', async () => {
    await installCursor(dir);
    const forced = await installCursor(dir, { force: true });
    expect(forced.status).toBe('applied');
    if (forced.status !== 'applied') throw new Error('expected applied');
    expect(forced.files.every((f) => f.action === 'unchanged')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('installCursor — confirm-before-overwrite (plan vs force)', () => {
  it('returns a plan and writes nothing when an existing mcp.json would change', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const original = `${JSON.stringify({ mcpServers: { github: { command: 'github-mcp', args: [], env: {} } } }, null, 2)}\n`;
    await writeFile(mcpPath(dir), original, 'utf8');

    const result = await installCursor(dir, { force: false });
    expect(result.status).toBe('plan');
    if (result.status !== 'plan') throw new Error('expected plan');

    const mcpItem = result.plan.find((p) => p.path === mcpPath(dir));
    expect(mcpItem?.action).toBe('merge');
    expect(result.plan.some((p) => p.path === rulePath(dir) && p.action === 'create')).toBe(true);

    // NOTHING was written: the existing file is untouched and the rule never appeared.
    expect(await readFile(mcpPath(dir), 'utf8')).toBe(original);
    expect(await exists(rulePath(dir))).toBe(false);
  });

  it('returns a plan flagging the rule as an overwrite when it already differs', async () => {
    await mkdir(join(dir, '.cursor', 'rules'), { recursive: true });
    await writeFile(rulePath(dir), '---\ndescription: "stale"\nalwaysApply: false\n---\n\nold\n', 'utf8');

    const result = await installCursor(dir, { force: false });
    expect(result.status).toBe('plan');
    if (result.status !== 'plan') throw new Error('expected plan');

    const ruleItem = result.plan.find((p) => p.path === rulePath(dir));
    expect(ruleItem?.action).toBe('overwrite');
    // The rule content was NOT touched.
    expect(await readFile(rulePath(dir), 'utf8')).toContain('old');
  });

  it('force merges into an existing mcp.json, preserving the foreign server', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const existing = { mcpServers: { github: { command: 'github-mcp', args: [], env: {} } } };
    await writeFile(mcpPath(dir), `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

    const result = await installCursor(dir, { force: true });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');
    expect(result.files.find((f) => f.path === mcpPath(dir))?.action).toBe('merge');

    const mcp = await readJson(mcpPath(dir));
    const servers = mcp.mcpServers as Record<string, { command: string }>;
    expect(servers.github?.command).toBe('github-mcp');
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]?.command).toBe('devcortex-mcp');
  });

  it('force overwrites an existing DevCortex rule with the canonical content', async () => {
    await mkdir(join(dir, '.cursor', 'rules'), { recursive: true });
    await writeFile(rulePath(dir), '---\ndescription: "stale"\nalwaysApply: false\n---\n\nold\n', 'utf8');

    const result = await installCursor(dir, { force: true });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');
    expect(result.files.find((f) => f.path === rulePath(dir))?.action).toBe('overwrite');

    expect(await readFile(rulePath(dir), 'utf8')).toBe(buildCursorRule());
  });
});

// ---------------------------------------------------------------------------

describe('installCursor — error handling', () => {
  it('throws ConfigError when an existing mcp.json is not valid JSON', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    await writeFile(mcpPath(dir), '{ not valid json', 'utf8');
    await expect(installCursor(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when an existing mcp.json has a non-object mcpServers key', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    await writeFile(mcpPath(dir), JSON.stringify({ mcpServers: 'nope' }), 'utf8');
    await expect(installCursor(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when an existing mcp.json is a JSON array, not an object', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    await writeFile(mcpPath(dir), JSON.stringify([1, 2, 3]), 'utf8');
    await expect(installCursor(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects an empty or whitespace target root', async () => {
    await expect(installCursor('   ')).rejects.toThrow(/non-empty target root/);
  });
});
