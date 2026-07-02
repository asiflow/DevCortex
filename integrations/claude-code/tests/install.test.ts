import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@devcortex/core';
import {
  buildHookShim,
  buildMcpConfig,
  buildSettingsHooks,
  DEVCORTEX_MCP_SERVER_NAME,
  HOOK_SHIMS,
  installClaude,
  mergeMcpConfig,
  mergeSettings,
} from '../src/index';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devcortex-cc-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settingsPath = (root: string): string => join(root, '.claude', 'settings.json');
const mcpPath = (root: string): string => join(root, '.mcp.json');

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

// ---------------------------------------------------------------------------

describe('builders', () => {
  it('includes a SessionStart brief shim, passive (canBlock=false)', () => {
    const brief = HOOK_SHIMS.find((s) => s.event === 'SessionStart');
    expect(brief).toBeDefined();
    expect(brief!.fileName).toBe('devcortex-brief.sh');
    expect(brief!.canBlock).toBe(false);
    const hooks = buildSettingsHooks();
    expect(hooks.SessionStart).toHaveLength(1);
  });

  it('buildSettingsHooks emits one group for each of the five lifecycle events', () => {
    const hooks = buildSettingsHooks();
    expect(Object.keys(hooks).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );

    // SessionStart + UserPromptSubmit + Stop are not tool-scoped → no matcher.
    expect(hooks.SessionStart?.[0]).not.toHaveProperty('matcher');
    expect(hooks.UserPromptSubmit?.[0]).not.toHaveProperty('matcher');
    expect(hooks.Stop?.[0]).not.toHaveProperty('matcher');

    // PreToolUse + PostToolUse guard the mutating tools.
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('Edit|Write|Bash');
    expect(hooks.PostToolUse?.[0]?.matcher).toBe('Edit|Write|Bash');

    // Every command points at a fail-open shim under .claude/hooks/devcortex-*.
    const command = hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? '';
    expect(command).toContain('$CLAUDE_PROJECT_DIR');
    expect(command).toContain('.claude/hooks/devcortex-preflight.sh');
    expect(hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.type).toBe('command');
  });

  it('buildMcpConfig registers the devcortex-mcp server with the right command', () => {
    const mcp = buildMcpConfig();
    expect(mcp.mcpServers[DEVCORTEX_MCP_SERVER_NAME]).toEqual({
      command: 'devcortex-mcp',
      args: [],
      env: {},
    });
  });

  it('non-blocking shims always exit 0 (pure passive, never propagate a block)', () => {
    const preflight = HOOK_SHIMS.find((s) => s.event === 'UserPromptSubmit');
    expect(preflight).toBeDefined();
    const shim = buildHookShim(preflight!);
    expect(shim.startsWith('#!/usr/bin/env sh')).toBe(true);
    expect(shim).toContain('devcortex preflight --json || true');
    expect(shim.trimEnd().endsWith('exit 0')).toBe(true);
    expect(shim).not.toContain('exit 2');
  });

  it('blocking shims fail open but propagate a deliberate exit-2 block', () => {
    const ship = HOOK_SHIMS.find((s) => s.event === 'Stop');
    expect(ship).toBeDefined();
    const shim = buildHookShim(ship!);
    expect(shim).toContain('devcortex ship --json');
    expect(shim).toContain('status=$?');
    expect(shim).toContain('if [ "$status" -eq 2 ]; then');
    expect(shim).toContain('exit 2');
    // ...and the catch-all fail-open at the end.
    expect(shim.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('mergeSettings is idempotent and strips its own previously-installed groups', () => {
    const once = mergeSettings({});
    const twice = mergeSettings(once);
    expect(twice).toEqual(once);

    // A duplicate DevCortex group is collapsed, not stacked.
    const merged = once.hooks as Record<string, unknown[]>;
    expect(merged.UserPromptSubmit).toHaveLength(1);
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

describe('installClaude — fresh install', () => {
  it('creates settings.json, .mcp.json and five executable fail-open shims', async () => {
    const result = await installClaude(dir);
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');

    // Two config files + five shims = seven managed files, all created.
    expect(result.files).toHaveLength(7);
    expect(result.files.every((f) => f.action === 'create')).toBe(true);

    // settings.json shape.
    const settings = await readJson(settingsPath(dir));
    const hooks = settings.hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    expect(Object.keys(hooks).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('Edit|Write|Bash');

    // .mcp.json shape.
    const mcp = await readJson(mcpPath(dir));
    const servers = mcp.mcpServers as Record<string, { command: string }>;
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]?.command).toBe('devcortex-mcp');

    // Shims exist on disk, are executable, and honour the fail-open contract.
    for (const spec of HOOK_SHIMS) {
      const shimPath = join(dir, '.claude', 'hooks', spec.fileName);
      expect(await exists(shimPath)).toBe(true);
      const mode = (await stat(shimPath)).mode;
      expect(mode & 0o111).not.toBe(0);
      const content = await readFile(shimPath, 'utf8');
      expect(content.trimEnd().endsWith('exit 0')).toBe(true);
    }
  });

  it('does not require force on a clean repository', async () => {
    const result = await installClaude(dir, { force: false });
    expect(result.status).toBe('applied');
  });
});

// ---------------------------------------------------------------------------

describe('installClaude — idempotency', () => {
  it('a second identical install rewrites nothing and reports all files unchanged', async () => {
    await installClaude(dir);
    const settingsBefore = await readFile(settingsPath(dir), 'utf8');
    const shimBefore = await readFile(join(dir, '.claude', 'hooks', 'devcortex-ship.sh'), 'utf8');

    const second = await installClaude(dir);
    expect(second.status).toBe('applied');
    if (second.status !== 'applied') throw new Error('expected applied');
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);

    // Byte-for-byte stable.
    expect(await readFile(settingsPath(dir), 'utf8')).toBe(settingsBefore);
    expect(await readFile(join(dir, '.claude', 'hooks', 'devcortex-ship.sh'), 'utf8')).toBe(
      shimBefore,
    );
  });

  it('force on an already-installed repo still rewrites nothing identical', async () => {
    await installClaude(dir);
    const forced = await installClaude(dir, { force: true });
    expect(forced.status).toBe('applied');
    if (forced.status !== 'applied') throw new Error('expected applied');
    expect(forced.files.every((f) => f.action === 'unchanged')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('installClaude — confirm-before-overwrite (plan vs force)', () => {
  it('returns a plan and writes nothing when an existing settings.json would change', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const original = `${JSON.stringify({ model: 'sonnet' }, null, 2)}\n`;
    await writeFile(settingsPath(dir), original, 'utf8');

    const result = await installClaude(dir, { force: false });
    expect(result.status).toBe('plan');
    if (result.status !== 'plan') throw new Error('expected plan');

    // The settings file is flagged as a merge; the create-only files are listed too.
    const settingsItem = result.plan.find((p) => p.path === settingsPath(dir));
    expect(settingsItem?.action).toBe('merge');
    expect(result.plan.some((p) => p.path === mcpPath(dir) && p.action === 'create')).toBe(true);

    // NOTHING was written: the existing file is untouched and no others appeared.
    expect(await readFile(settingsPath(dir), 'utf8')).toBe(original);
    expect(await exists(mcpPath(dir))).toBe(false);
    expect(await exists(join(dir, '.claude', 'hooks', 'devcortex-ship.sh'))).toBe(false);
  });

  it('force merges into an existing settings.json, preserving the user content', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const userHooks = {
      model: 'sonnet',
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      },
    };
    await writeFile(settingsPath(dir), `${JSON.stringify(userHooks, null, 2)}\n`, 'utf8');

    const result = await installClaude(dir, { force: true });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');
    expect(result.files.find((f) => f.path === settingsPath(dir))?.action).toBe('merge');

    const settings = await readJson(settingsPath(dir));
    expect(settings.model).toBe('sonnet');

    // The user's own UserPromptSubmit group survives alongside the DevCortex one.
    const groups = (settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .UserPromptSubmit;
    expect(groups).toHaveLength(2);
    expect(groups?.[0]?.hooks?.[0]?.command).toBe('echo user-hook');
    expect(groups?.[1]?.hooks?.[0]?.command).toContain('devcortex-preflight.sh');
  });

  it('force preserves a foreign MCP server when merging .mcp.json', async () => {
    const existing = { mcpServers: { github: { command: 'github-mcp', args: [], env: {} } } };
    await writeFile(mcpPath(dir), `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

    const result = await installClaude(dir, { force: true });
    expect(result.status).toBe('applied');

    const mcp = await readJson(mcpPath(dir));
    const servers = mcp.mcpServers as Record<string, { command: string }>;
    expect(servers.github?.command).toBe('github-mcp');
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]?.command).toBe('devcortex-mcp');
  });

  it('re-installing over an existing DevCortex install does not duplicate hook groups', async () => {
    await installClaude(dir);
    const forced = await installClaude(dir, { force: true });
    expect(forced.status).toBe('applied');

    const settings = await readJson(settingsPath(dir));
    const groups = (settings.hooks as Record<string, unknown[]>).UserPromptSubmit;
    expect(groups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('installClaude — error handling', () => {
  it('throws ConfigError when an existing settings.json is not valid JSON', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(settingsPath(dir), '{ not valid json', 'utf8');
    await expect(installClaude(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when an existing settings.json has a non-object hooks key', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(settingsPath(dir), JSON.stringify({ hooks: 'nope' }), 'utf8');
    await expect(installClaude(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when an existing settings.json is a JSON array, not an object', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(settingsPath(dir), JSON.stringify([1, 2, 3]), 'utf8');
    await expect(installClaude(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects an empty or whitespace target root', async () => {
    await expect(installClaude('   ')).rejects.toThrow(/non-empty target root/);
  });
});
