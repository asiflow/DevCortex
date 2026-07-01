import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@devcortex/core';
import {
  buildDevCortexSettingsSection,
  buildDevCortexTasks,
  buildMcpConfig,
  buildSettingsConfig,
  buildTasksConfig,
  DEVCORTEX_MCP_SERVER_NAME,
  DEVCORTEX_SETTINGS_KEY,
  DEVCORTEX_TASK_LABEL_PREFIX,
  DEVCORTEX_TASK_SPECS,
  installVscode,
  isDevCortexTask,
  mergeMcpConfig,
  mergeSettings,
  mergeTasksConfig,
  VSCODE_MCP_PATH,
  VSCODE_SETTINGS_PATH,
  VSCODE_TASKS_PATH,
  VSCODE_TASKS_VERSION,
} from '../src/index';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devcortex-vscode-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tasksPath = (root: string): string => join(root, ...VSCODE_TASKS_PATH.split('/'));
const mcpPath = (root: string): string => join(root, ...VSCODE_MCP_PATH.split('/'));
const settingsPath = (root: string): string => join(root, ...VSCODE_SETTINGS_PATH.split('/'));

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

/** Writes an object to `path` in the same canonical form the installer emits. */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(join(dir, '.vscode'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------

describe('builders', () => {
  it('buildTasksConfig produces the 2.0.0 schema with the five DevCortex tasks', () => {
    const config = buildTasksConfig();
    expect(config.version).toBe(VSCODE_TASKS_VERSION);
    expect(config.version).toBe('2.0.0');
    expect(config.tasks).toHaveLength(DEVCORTEX_TASK_SPECS.length);

    // Every task is a labelled shell task invoking the devcortex CLI.
    for (const task of config.tasks) {
      expect(task.type).toBe('shell');
      expect(task.command).toBe('devcortex');
      expect(task.label.startsWith(DEVCORTEX_TASK_LABEL_PREFIX)).toBe(true);
      expect(task.problemMatcher).toEqual([]);
      expect(task.args).toHaveLength(1);
    }

    // The five lifecycle subcommands the spec requires are all wired.
    const subcommands = config.tasks.map((t) => t.args[0]).sort();
    expect(subcommands).toEqual(['init', 'preflight', 'scan', 'ship', 'verify']);
  });

  it('buildDevCortexTasks is a pure function (stable across calls)', () => {
    expect(buildDevCortexTasks()).toEqual(buildDevCortexTasks());
  });

  it('buildMcpConfig registers devcortex-mcp under the VS Code `servers` key with type stdio', () => {
    const mcp = buildMcpConfig();
    // VS Code uses `servers` (NOT `mcpServers`) and an explicit stdio discriminator.
    expect(mcp).toHaveProperty('servers');
    expect(mcp).not.toHaveProperty('mcpServers');
    expect(mcp.servers[DEVCORTEX_MCP_SERVER_NAME]).toEqual({
      type: 'stdio',
      command: 'devcortex-mcp',
      args: [],
    });
  });

  it('buildDevCortexSettingsSection is a coherent, declarative section', () => {
    const section = buildDevCortexSettingsSection();
    expect(section.enabled).toBe(true);
    expect(section.cli).toBe('devcortex');
    expect(section.mcpServer).toBe('devcortex-mcp');
    expect(section.commands).toEqual(['init', 'scan', 'preflight', 'verify', 'ship']);
    expect(section.discipline).toMatch(/evidence/i);
  });

  it('buildSettingsConfig nests the section under the single `devcortex` key', () => {
    const config = buildSettingsConfig();
    expect(Object.keys(config)).toEqual([DEVCORTEX_SETTINGS_KEY]);
    expect(config[DEVCORTEX_SETTINGS_KEY]).toEqual(buildDevCortexSettingsSection());
  });

  it('isDevCortexTask recognises only our own labelled tasks', () => {
    expect(isDevCortexTask({ label: `${DEVCORTEX_TASK_LABEL_PREFIX}Ship` })).toBe(true);
    expect(isDevCortexTask({ label: 'Build project' })).toBe(false);
    expect(isDevCortexTask({ command: 'x' })).toBe(false);
    expect(isDevCortexTask('not-an-object')).toBe(false);
    expect(isDevCortexTask(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('merge helpers', () => {
  it('mergeTasksConfig preserves foreign tasks + keys and is idempotent', () => {
    const existing = {
      version: '2.0.0',
      tasks: [{ label: 'Build', type: 'npm', script: 'build' }],
      inputs: [{ id: 'x', type: 'promptString' }],
    };
    const once = mergeTasksConfig(existing);

    // Foreign task and unrelated top-level key survive.
    const tasks = once.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]).toEqual({ label: 'Build', type: 'npm', script: 'build' });
    expect(once.inputs).toEqual([{ id: 'x', type: 'promptString' }]);

    // Our five tasks are appended.
    const dcTasks = tasks.filter((t) => isDevCortexTask(t));
    expect(dcTasks).toHaveLength(DEVCORTEX_TASK_SPECS.length);

    // Idempotent at the value level.
    expect(mergeTasksConfig(once)).toEqual(once);
  });

  it('mergeTasksConfig replaces stale DevCortex tasks rather than duplicating them', () => {
    const stale = {
      version: '2.0.0',
      tasks: [
        { label: `${DEVCORTEX_TASK_LABEL_PREFIX}Old`, type: 'shell', command: 'devcortex' },
        { label: 'User Task', type: 'shell', command: 'echo' },
      ],
    };
    const merged = mergeTasksConfig(stale);
    const tasks = merged.tasks as Array<Record<string, unknown>>;

    // The stale DevCortex task is gone; the user task survives; the fresh set is present.
    expect(tasks.some((t) => t.label === `${DEVCORTEX_TASK_LABEL_PREFIX}Old`)).toBe(false);
    expect(tasks.some((t) => t.label === 'User Task')).toBe(true);
    expect(tasks.filter((t) => isDevCortexTask(t))).toHaveLength(DEVCORTEX_TASK_SPECS.length);
  });

  it('mergeTasksConfig defaults an absent version and preserves a user version', () => {
    expect(mergeTasksConfig({}).version).toBe(VSCODE_TASKS_VERSION);
    expect(mergeTasksConfig({ version: '2.0.0' }).version).toBe('2.0.0');
  });

  it('mergeMcpConfig preserves foreign servers + inputs and is idempotent', () => {
    const existing = {
      servers: { github: { type: 'stdio', command: 'github-mcp', args: [] } },
      inputs: [{ id: 'token', type: 'promptString' }],
    };
    const once = mergeMcpConfig(existing);
    const servers = once.servers as Record<string, unknown>;

    expect(servers.github).toEqual({ type: 'stdio', command: 'github-mcp', args: [] });
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]).toEqual({
      type: 'stdio',
      command: 'devcortex-mcp',
      args: [],
    });
    expect(once.inputs).toEqual([{ id: 'token', type: 'promptString' }]);
    expect(mergeMcpConfig(once)).toEqual(once);
  });

  it('mergeSettings preserves every user setting and is idempotent', () => {
    const existing = { 'editor.tabSize': 2, 'files.eol': '\n' };
    const once = mergeSettings(existing);

    expect(once['editor.tabSize']).toBe(2);
    expect(once['files.eol']).toBe('\n');
    expect(once[DEVCORTEX_SETTINGS_KEY]).toEqual(buildDevCortexSettingsSection());
    expect(mergeSettings(once)).toEqual(once);
  });
});

// ---------------------------------------------------------------------------

describe('installVscode — fresh install', () => {
  it('creates tasks.json, mcp.json and settings.json', async () => {
    const result = await installVscode(dir);
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');

    expect(result.files).toHaveLength(3);
    expect(result.files.every((f) => f.action === 'create')).toBe(true);
    expect(result.files.map((f) => f.path).sort()).toEqual(
      [tasksPath(dir), mcpPath(dir), settingsPath(dir)].sort(),
    );

    // tasks.json shape.
    const tasks = await readJson(tasksPath(dir));
    expect(tasks.version).toBe('2.0.0');
    expect((tasks.tasks as unknown[]).length).toBe(DEVCORTEX_TASK_SPECS.length);

    // mcp.json shape — VS Code `servers` key with stdio server.
    const mcp = await readJson(mcpPath(dir));
    const servers = mcp.servers as Record<string, { type: string; command: string }>;
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]?.type).toBe('stdio');
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]?.command).toBe('devcortex-mcp');

    // settings.json shape — devcortex section present.
    const settings = await readJson(settingsPath(dir));
    expect(settings[DEVCORTEX_SETTINGS_KEY]).toEqual(buildDevCortexSettingsSection());
  });

  it('does not require force on a clean repository', async () => {
    const result = await installVscode(dir, { force: false });
    expect(result.status).toBe('applied');
  });
});

// ---------------------------------------------------------------------------

describe('installVscode — idempotency', () => {
  it('a second identical install rewrites nothing and reports all files unchanged', async () => {
    await installVscode(dir);
    const before = {
      tasks: await readFile(tasksPath(dir), 'utf8'),
      mcp: await readFile(mcpPath(dir), 'utf8'),
      settings: await readFile(settingsPath(dir), 'utf8'),
    };

    const second = await installVscode(dir);
    expect(second.status).toBe('applied');
    if (second.status !== 'applied') throw new Error('expected applied');
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);

    // Byte-for-byte stable (fresh-build output === merge-of-own-output).
    expect(await readFile(tasksPath(dir), 'utf8')).toBe(before.tasks);
    expect(await readFile(mcpPath(dir), 'utf8')).toBe(before.mcp);
    expect(await readFile(settingsPath(dir), 'utf8')).toBe(before.settings);
  });

  it('force on an already-installed repo still rewrites nothing identical', async () => {
    await installVscode(dir);
    const forced = await installVscode(dir, { force: true });
    expect(forced.status).toBe('applied');
    if (forced.status !== 'applied') throw new Error('expected applied');
    expect(forced.files.every((f) => f.action === 'unchanged')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('installVscode — confirm-before-overwrite (plan vs force)', () => {
  it('returns a plan and writes nothing when existing files would change', async () => {
    // A user tasks.json with a foreign task would be merged, not created.
    await writeJsonFile(tasksPath(dir), {
      version: '2.0.0',
      tasks: [{ label: 'Build', type: 'shell', command: 'make' }],
    });

    const result = await installVscode(dir, { force: false });
    expect(result.status).toBe('plan');
    if (result.status !== 'plan') throw new Error('expected plan');

    const tasksItem = result.plan.find((p) => p.path === tasksPath(dir));
    expect(tasksItem?.action).toBe('merge');
    // The absent files are planned as creates.
    expect(result.plan.some((p) => p.path === mcpPath(dir) && p.action === 'create')).toBe(true);
    expect(result.plan.some((p) => p.path === settingsPath(dir) && p.action === 'create')).toBe(
      true,
    );

    // NOTHING was written: the existing file is untouched, the others never appeared.
    const untouched = await readJson(tasksPath(dir));
    expect((untouched.tasks as unknown[]).length).toBe(1);
    expect(await exists(mcpPath(dir))).toBe(false);
    expect(await exists(settingsPath(dir))).toBe(false);
  });

  it('force merges into existing files, preserving foreign content', async () => {
    await writeJsonFile(mcpPath(dir), {
      servers: { github: { type: 'stdio', command: 'github-mcp', args: [] } },
    });
    await writeJsonFile(settingsPath(dir), { 'editor.tabSize': 4 });

    const result = await installVscode(dir, { force: true });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');
    expect(result.files.find((f) => f.path === mcpPath(dir))?.action).toBe('merge');
    expect(result.files.find((f) => f.path === settingsPath(dir))?.action).toBe('merge');
    expect(result.files.find((f) => f.path === tasksPath(dir))?.action).toBe('create');

    // Foreign MCP server + user setting survive alongside the DevCortex additions.
    const mcp = await readJson(mcpPath(dir));
    const servers = mcp.servers as Record<string, { command: string }>;
    expect(servers.github?.command).toBe('github-mcp');
    expect(servers[DEVCORTEX_MCP_SERVER_NAME]?.command).toBe('devcortex-mcp');

    const settings = await readJson(settingsPath(dir));
    expect(settings['editor.tabSize']).toBe(4);
    expect(settings[DEVCORTEX_SETTINGS_KEY]).toEqual(buildDevCortexSettingsSection());
  });

  it('a partially-installed repo (only mcp present) applies without force', async () => {
    // The mcp.json already holds the exact DevCortex content → it will not change,
    // so there is no conflict and the two missing files are created directly.
    await writeJsonFile(mcpPath(dir), buildMcpConfig());

    const result = await installVscode(dir, { force: false });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');

    expect(result.files.find((f) => f.path === mcpPath(dir))?.action).toBe('unchanged');
    expect(result.files.find((f) => f.path === tasksPath(dir))?.action).toBe('create');
    expect(result.files.find((f) => f.path === settingsPath(dir))?.action).toBe('create');
  });
});

// ---------------------------------------------------------------------------

describe('installVscode — error handling', () => {
  it('throws ConfigError when an existing tasks.json is not valid JSON', async () => {
    await writeFile(await ensureVscodeFile(tasksPath(dir)), '{ not valid json', 'utf8');
    await expect(installVscode(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when tasks.json has a non-array `tasks` key', async () => {
    await writeJsonFile(tasksPath(dir), { version: '2.0.0', tasks: 'nope' });
    await expect(installVscode(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when mcp.json has a non-object `servers` key', async () => {
    await writeJsonFile(mcpPath(dir), { servers: 'nope' });
    await expect(installVscode(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when a managed file is a JSON array, not an object', async () => {
    await writeJsonFile(settingsPath(dir), [1, 2, 3]);
    await expect(installVscode(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects an empty or whitespace target root', async () => {
    await expect(installVscode('   ')).rejects.toThrow(/non-empty target root/);
  });
});

/** Ensures the `.vscode` dir exists and returns the target path (for raw writes). */
async function ensureVscodeFile(path: string): Promise<string> {
  await mkdir(join(dir, '.vscode'), { recursive: true });
  return path;
}
