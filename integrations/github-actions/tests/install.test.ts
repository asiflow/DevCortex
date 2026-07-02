import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { DevCortexError } from '@devcortex/core';
import {
  buildShipCheckActionObject,
  buildShipCheckActionYaml,
  buildShipCommentScript,
  buildWorkflowObject,
  buildWorkflowYaml,
  checkRunCommand,
  DEVCORTEX_CHECKS,
  installGithubActions,
  SHIP_CHECK_ACTION_PATH,
  WORKFLOW_PATH,
} from '../src/index';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devcortex-gha-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const workflowPath = (root: string): string => join(root, ...WORKFLOW_PATH.split('/'));
const actionPath = (root: string): string => join(root, ...SHIP_CHECK_ACTION_PATH.split('/'));

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// yaml.parse returns `any`; tests treat the parsed document loosely.
/* eslint-disable @typescript-eslint/no-explicit-any */
function parseYaml(text: string): any {
  return parse(text);
}

const EXPECTED_CHECK_IDS = [
  'ship-check',
  'quality-gate',
  'feature-ledger-check',
  'security-gate',
  'ui-gate',
];

describe('workflow template', () => {
  it('exposes the five named DevCortex checks in spec order', () => {
    expect(DEVCORTEX_CHECKS.map((c) => c.id)).toEqual(EXPECTED_CHECK_IDS);
  });

  it('maps the two locked checks to their required CLI commands', () => {
    const ship = DEVCORTEX_CHECKS.find((c) => c.id === 'ship-check');
    const quality = DEVCORTEX_CHECKS.find((c) => c.id === 'quality-gate');
    const feature = DEVCORTEX_CHECKS.find((c) => c.id === 'feature-ledger-check');
    expect(ship?.cliCommand).toBe('ship');
    expect(quality?.cliCommand).toBe('verify');
    expect(feature?.cliCommand).toBe('feature list');
    expect(ship && checkRunCommand(ship)).toBe('npx devcortex ship');
    expect(quality && checkRunCommand(quality)).toBe('npx devcortex verify');
    expect(feature && checkRunCommand(feature)).toBe('npx devcortex feature list');
  });

  it('produces parseable YAML with one job per check', () => {
    const wf = parseYaml(buildWorkflowYaml());
    expect(wf.name).toBe('DevCortex');
    expect(Object.keys(wf.jobs)).toEqual(EXPECTED_CHECK_IDS);
  });

  it('runs the DevCortex CLI in every check job, after checkout/setup/install/build', () => {
    const wf = parseYaml(buildWorkflowYaml());
    for (const check of DEVCORTEX_CHECKS) {
      const job = wf.jobs[check.id];
      expect(job).toBeDefined();
      expect(job['runs-on']).toBe('ubuntu-latest');

      const steps = job.steps as any[];
      const uses = steps.map((s) => s.uses).filter((u): u is string => typeof u === 'string');
      const runs = steps.map((s) => s.run).filter((r): r is string => typeof r === 'string');

      // Real CI step sequence: checkout + setup-node + install + build + devcortex.
      expect(uses).toContain('actions/checkout@v4');
      expect(uses.some((u) => u.startsWith('actions/setup-node@'))).toBe(true);
      expect(runs).toContain('npm ci');
      expect(runs).toContain('npm run build');

      if (check.id === 'ship-check') {
        // ship-check runs ship --json > file (not the bare command) and has
        // additional summary + enforce steps after; verify CLI is present.
        expect(runs.some((r) => r.startsWith(checkRunCommand(check)))).toBe(true);
      } else {
        // The devcortex command is the final step of the job.
        const lastRun = runs[runs.length - 1];
        expect(lastRun).toBe(checkRunCommand(check));
        expect(lastRun).toMatch(/^npx devcortex /);
      }
    }
  });

  it('triggers on pull requests and pushes to main (no null/bare event)', () => {
    const wf = parseYaml(buildWorkflowYaml());
    expect(wf.on.push.branches).toContain('main');
    expect(wf.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened']);
  });

  it('serialises deterministically (byte-identical across calls)', () => {
    expect(buildWorkflowYaml()).toBe(buildWorkflowYaml());
    expect(buildShipCheckActionYaml()).toBe(buildShipCheckActionYaml());
  });

  it('keeps the `on` key as a string (not a YAML 1.1 boolean)', () => {
    const wf = parseYaml(buildWorkflowYaml());
    expect(Object.prototype.hasOwnProperty.call(wf, 'on')).toBe(true);
    expect(wf.on).toMatchObject({ push: expect.anything(), pull_request: expect.anything() });
  });

  it('builds an object whose jobs match the serialised YAML', () => {
    const obj = buildWorkflowObject();
    const parsed = parseYaml(buildWorkflowYaml());
    expect(Object.keys(obj.jobs as Record<string, unknown>)).toEqual(Object.keys(parsed.jobs));
  });

  // --- Task 7: PR-native ship report ---

  it('workflow declares least-privilege permissions', () => {
    const wf = buildWorkflowObject() as Record<string, any>;
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
  });

  it('ship-check job comments before enforcing, fork-safe', () => {
    const yamlText = buildWorkflowYaml();
    expect(yamlText).toContain('continue-on-error: true');
    expect(yamlText).toContain('devcortex-ship-report');           // artifact + comment marker name
    expect(yamlText).toContain('<!-- devcortex-ship-report -->');  // sticky marker
    expect(yamlText).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(yamlText.indexOf('Comment ship report')).toBeLessThan(yamlText.indexOf('Enforce ship gate'));
  });

  it('remains deterministic', () => {
    expect(buildWorkflowYaml()).toBe(buildWorkflowYaml());
  });

  // Step 5 (YAML validity): parse the generated YAML and verify ship-check steps are in order.
  // ESM package cannot use require('./dist/...'); vitest is the canonical route.
  it('ship-check job steps parse correctly and appear in the required order', () => {
    const wf = parseYaml(buildWorkflowYaml());
    const job = wf.jobs['ship-check'] as any;
    const names = (job.steps as any[]).map((s: any) => s.name as string);
    const commentIdx = names.indexOf('Comment ship report');
    const summaryIdx = names.indexOf('Ship report to job summary');
    const enforceIdx = names.indexOf('Enforce ship gate');
    expect(commentIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(enforceIdx).toBeGreaterThan(-1);
    expect(commentIdx).toBeLessThan(enforceIdx);
    expect(summaryIdx).toBeLessThan(enforceIdx);
  });

  it('buildShipCommentScript returns a deterministic string containing the sticky marker', () => {
    const script = buildShipCommentScript();
    expect(typeof script).toBe('string');
    expect(script).toContain('<!-- devcortex-ship-report -->');
    expect(script).toContain('report.status');
    expect(script).toContain('report.passed');
    expect(script).toContain('report.blocked');
    // Must be deterministic.
    expect(buildShipCommentScript()).toBe(script);
  });
});

describe('composite ship-check action template', () => {
  it('produces a parseable composite action wrapping `devcortex ship`', () => {
    const action = parseYaml(buildShipCheckActionYaml());
    expect(action.runs.using).toBe('composite');

    const steps = action.runs.steps as any[];
    const runs = steps.map((s) => s.run).filter((r): r is string => typeof r === 'string');
    expect(runs).toContain('npx devcortex ship');

    // Composite `run` steps must declare a shell.
    for (const step of steps) {
      if (typeof step.run === 'string') {
        expect(step.shell).toBe('bash');
      }
    }
  });

  it('exposes overridable inputs with sensible defaults', () => {
    const action = buildShipCheckActionObject() as any;
    expect(action.inputs['node-version'].default).toBe('20');
    expect(action.inputs['install-command'].default).toBe('npm ci');
    expect(action.inputs['build-command'].default).toBe('npm run build');
    expect(action.inputs['working-directory'].default).toBe('.');
  });

  it('preserves ${{ }} expressions through YAML round-trip', () => {
    const action = parseYaml(buildShipCheckActionYaml());
    const steps = action.runs.steps as any[];
    const install = steps.find((s) => s.name === 'Install dependencies');
    expect(install.run).toBe('${{ inputs.install-command }}');
    const setup = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node'));
    expect(setup.with['node-version']).toBe('${{ inputs.node-version }}');
  });
});

describe('installGithubActions', () => {
  it('rejects an empty target root with a DevCortexError', async () => {
    await expect(installGithubActions('')).rejects.toBeInstanceOf(DevCortexError);
    await expect(installGithubActions('   ')).rejects.toBeInstanceOf(DevCortexError);
  });

  it('creates both files on a fresh install with byte-exact content', async () => {
    const result = await installGithubActions(dir);
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');

    expect(result.files.map((f) => f.action).sort()).toEqual(['create', 'create']);
    expect(await exists(workflowPath(dir))).toBe(true);
    expect(await exists(actionPath(dir))).toBe(true);
    expect(await readFile(workflowPath(dir), 'utf8')).toBe(buildWorkflowYaml());
    expect(await readFile(actionPath(dir), 'utf8')).toBe(buildShipCheckActionYaml());
  });

  it('writes a workflow that still parses and carries all five checks', async () => {
    await installGithubActions(dir);
    const wf = parseYaml(await readFile(workflowPath(dir), 'utf8'));
    expect(Object.keys(wf.jobs)).toEqual(EXPECTED_CHECK_IDS);
  });

  it('is idempotent: a second install reports everything unchanged', async () => {
    await installGithubActions(dir);
    const before = await readFile(workflowPath(dir), 'utf8');

    const second = await installGithubActions(dir);
    expect(second.status).toBe('applied');
    if (second.status !== 'applied') throw new Error('expected applied');
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);
    expect(await readFile(workflowPath(dir), 'utf8')).toBe(before);
  });

  it('returns a plan (writing nothing) when a managed file would change without force', async () => {
    await mkdir(dirname(workflowPath(dir)), { recursive: true });
    await writeFile(workflowPath(dir), 'name: custom-workflow\n', 'utf8');

    const result = await installGithubActions(dir);
    expect(result.status).toBe('plan');
    if (result.status !== 'plan') throw new Error('expected plan');

    const actions = new Map(result.plan.map((p) => [p.path, p.action]));
    expect(actions.get(workflowPath(dir))).toBe('overwrite');
    expect(actions.get(actionPath(dir))).toBe('create');

    // Nothing was written: the user's file is intact, the action is still absent.
    expect(await readFile(workflowPath(dir), 'utf8')).toBe('name: custom-workflow\n');
    expect(await exists(actionPath(dir))).toBe(false);
  });

  it('overwrites a conflicting managed file when force is set', async () => {
    await mkdir(dirname(workflowPath(dir)), { recursive: true });
    await writeFile(workflowPath(dir), 'name: custom-workflow\n', 'utf8');

    const result = await installGithubActions(dir, { force: true });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied');

    const actions = new Map(result.files.map((f) => [f.path, f.action]));
    expect(actions.get(workflowPath(dir))).toBe('overwrite');
    expect(actions.get(actionPath(dir))).toBe('create');
    expect(await readFile(workflowPath(dir), 'utf8')).toBe(buildWorkflowYaml());
    expect(await readFile(actionPath(dir), 'utf8')).toBe(buildShipCheckActionYaml());
  });

  it('re-applies cleanly (no plan) when the on-disk files already match', async () => {
    await installGithubActions(dir);
    // Even without force, matching files never trigger a plan.
    const result = await installGithubActions(dir);
    expect(result.status).toBe('applied');
  });
});
