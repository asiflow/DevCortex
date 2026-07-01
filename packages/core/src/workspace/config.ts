/**
 * Typed, schema-validated read/write of `.cortex/config.yaml` plus the canonical
 * default configuration produced at `init` time.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { CortexConfig, DetectedStack } from '../domain/index';
import { ConfigError, CortexConfigSchema, DevCortexError } from '../domain/index';

import { workspacePaths } from './paths';

/** Schema version written into freshly generated configs. */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Glob patterns (picomatch syntax) whose edits are treated as high/critical
 * risk by default: auth, billing, middleware, migrations, env files and
 * secrets. Repo-relative POSIX paths are matched against these.
 */
const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '**/middleware.{ts,tsx,js,jsx,mjs,cjs}',
  '**/middleware/**',
  '**/auth/**',
  '**/*auth*.{ts,tsx,js,jsx}',
  '**/billing/**',
  '**/*billing*.{ts,tsx,js,jsx}',
  '**/migrations/**',
  '**/migrate/**',
  '**/*.migration.{ts,js,sql}',
  '**/.env',
  '**/.env.*',
  '**/secrets/**',
  '**/*secret*',
] as const;

/**
 * Build the canonical default {@link CortexConfig}.
 *
 * Defaults are intentionally conservative: passive mode (never blocks), local
 * privacy (no network), every gate on (including `blockUnprovenDone`), and risk
 * floors that force the security-sensitive task types to at least `high`.
 *
 * `commands` is left empty here: a {@link DetectedStack} carries no scripts, so
 * concrete gate commands are resolved later from the cached project graph /
 * stack-pack defaults. An empty record is valid against `CortexCommandsSchema`.
 *
 * The `_stack` parameter is part of the public contract (callers pass the
 * detected stack) but does not alter the safe, conservative defaults today; it
 * is reserved so stack-aware seeding can be layered in without a signature
 * change. The security-sensitive floors and protected paths are deliberately
 * framework-agnostic.
 */
export function defaultConfig(_stack?: DetectedStack): CortexConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    mode: 'passive',
    privacy: 'local-only',
    risk: {
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
      floors: {
        auth: 'high',
        billing: 'high',
        database: 'high',
        security: 'high',
        devops: 'high',
      },
    },
    gates: {
      typecheck: true,
      lint: true,
      build: true,
      test: true,
      blockUnprovenDone: true,
    },
    stackPacks: [],
    commands: {},
  };
}

/**
 * Read and validate `.cortex/config.yaml`.
 *
 * @throws DevCortexError `CONFIG_NOT_FOUND` when the file is absent.
 * @throws ConfigError `CONFIG_INVALID` when the YAML is unparseable or fails
 *   `CortexConfigSchema`.
 */
export async function loadConfig(root: string): Promise<CortexConfig> {
  const paths = workspacePaths(root);

  let raw: string;
  try {
    raw = await readFile(paths.config, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      throw new DevCortexError(
        'CONFIG_NOT_FOUND',
        `No DevCortex config found at ${paths.config}. Run \`devcortex init\` first.`,
        { cause: err },
      );
    }
    throw new ConfigError(`Unable to read config at ${paths.config}.`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`Config at ${paths.config} is not valid YAML.`, { cause: err });
  }

  const result = CortexConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Config at ${paths.config} failed validation.`, {
      details: result.error.issues,
      cause: result.error,
    });
  }

  return result.data;
}

/**
 * Validate and atomically persist `config` to `.cortex/config.yaml` as YAML.
 *
 * Two-stage durability: the config is validated against `CortexConfigSchema`
 * before any I/O, so a malformed in-memory object can never reach disk; then the
 * bytes are written to a uniquely-named temp file in the same directory and
 * `rename`d over the target. Because `rename` is atomic within a filesystem, a
 * concurrent reader (or a crash mid-write) always observes either the previous
 * complete config or the new complete config — never a half-written file. The
 * temp file is removed on failure so no `.tmp` debris is left behind.
 *
 * @throws ConfigError `CONFIG_INVALID` when `config` fails `CortexConfigSchema`
 *   or the file cannot be written.
 */
export async function saveConfig(root: string, config: CortexConfig): Promise<void> {
  const paths = workspacePaths(root);

  const result = CortexConfigSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigError('Refusing to write an invalid config.', {
      details: result.error.issues,
      cause: result.error,
    });
  }

  const yaml = stringifyYaml(result.data, { indent: 2 });
  const banner =
    '# DevCortex workspace config — see .cortex/quality-constitution.md\n' +
    '# Managed file: edits are honored, but keep it valid against CortexConfigSchema.\n';

  // Temp file lives in the SAME directory as the target so the rename stays on
  // one filesystem (cross-device renames are not atomic and fail with EXDEV).
  const tmpPath = `${paths.config}.${randomUUID()}.tmp`;

  try {
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(tmpPath, banner + yaml, 'utf8');
    await rename(tmpPath, paths.config);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new ConfigError(`Unable to write config to ${paths.config}.`, { cause: err });
  }
}

/** Narrow an unknown thrown value to a Node `errno` exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
