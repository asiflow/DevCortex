// ============================================================================
// DevCortex GitHub Actions integration — workflow / composite-action templates.
//
// Pure, deterministic builders. They produce the exact YAML documents that
// `installGithubActions` writes into a target repository:
//   - `.github/workflows/devcortex.yml`
//       A CI workflow that enforces the DevCortex rules on pull requests and
//       pushes to `main`. It runs the five named DevCortex checks (spec §4.8) as
//       independent jobs so each surfaces as its own required PR status check:
//         - ship-check           → `devcortex ship`         (evidence-backed gate)
//         - quality-gate         → `devcortex verify`        (typecheck/lint/build/test)
//         - feature-ledger-check → `devcortex feature list`  (feature-ledger integrity)
//         - security-gate        → `devcortex verify`        (secrets/env/route checks)
//         - ui-gate              → `devcortex verify`        (structural checks)
//
//   - `.github/actions/devcortex-ship-check/action.yml`
//       A composite action wrapping `devcortex ship`, so teams can enforce the
//       ship gate from any workflow with a single `uses:` (the published form is
//       `devcortex/ship-check`).
//
// Mapping note (binding, honest): DevCortex's CLI currently implements two gate
// commands — `verify` (the general code gate) and `ship` (the evidence-backed
// aggregate) — plus `feature list` (feature-ledger read). The dedicated
// `security-gate` and `ui-quality-gate` modules (spec §7.12–7.13) are not yet a
// CLI verb, so those two named checks are enforced through `devcortex verify`
// today. Each check carries its CLI command in {@link DevCortexCheck.cliCommand},
// so swapping to a dedicated `devcortex security` / `devcortex ui` command when
// those modules land is a one-line change here — never a workflow rewrite.
//
// Determinism is load-bearing: `installGithubActions` compares freshly-built
// content against what is already on disk to decide "unchanged" vs "would
// change", so every builder here MUST be a stable pure function. YAML is emitted
// with line-wrapping disabled so long `run:` commands never reflow between runs.
//
// Spec deviations (justified):
//   (a) Spec WS-2 called for a separate `devcortex/ship` commit-status API write.
//       The `ship-check` job already surfaces as a required-able GitHub status
//       check on its own, making a duplicate Statuses-API write redundant (YAGNI).
//       Dropped.
//   (b) Spec wrote `ship --json --ci`; the `--ci` flag does not exist on
//       `cmdShip` and is not needed — the workflow runs plain `ship --json`. The
//       composite action is a pure gate; the PR comment logic lives only in the
//       workflow, not in the action.
// ============================================================================

import { stringify } from 'yaml';

// --- Identity / location constants ------------------------------------------

/** The DevCortex CLI binary the workflow / action invoke. */
export const DEVCORTEX_CLI_BIN = 'devcortex';

/**
 * How the workflow invokes the CLI. `npx` resolves the locally-installed
 * `devcortex` binary from `node_modules/.bin` after the install step, so the
 * workflow assumes `devcortex` (the DevCortex CLI package) is a devDependency of
 * the target repository.
 */
export const DEVCORTEX_CLI_INVOCATION = `npx ${DEVCORTEX_CLI_BIN}`;

/** POSIX-relative path of the generated CI workflow inside the target repo. */
export const WORKFLOW_PATH = '.github/workflows/devcortex.yml';
/** POSIX-relative path of the generated composite ship-check action. */
export const SHIP_CHECK_ACTION_PATH = '.github/actions/devcortex-ship-check/action.yml';

/** Top-level `name:` of the generated workflow. */
export const WORKFLOW_NAME = 'DevCortex';
/** `name:` of the generated composite action. */
export const SHIP_CHECK_ACTION_NAME = 'DevCortex Ship Check';

// --- CI environment defaults ------------------------------------------------

/** Node.js version the jobs / composite action run on. */
export const DEFAULT_NODE_VERSION = '20';
/** Command that installs the target repo's dependencies. */
export const DEFAULT_INSTALL_COMMAND = 'npm ci';
/** Command that builds the target repo before a gate runs. */
export const DEFAULT_BUILD_COMMAND = 'npm run build';
/** Runner image used by every generated job. */
export const DEFAULT_RUNNER = 'ubuntu-latest';

// --- Pinned third-party action versions -------------------------------------
//
// Pinned to major tags for readable, auto-patched CI. Bump here in one place.

export const CHECKOUT_ACTION = 'actions/checkout@v4';
export const SETUP_NODE_ACTION = 'actions/setup-node@v4';
export const UPLOAD_ARTIFACT_ACTION = 'actions/upload-artifact@v4';
export const GITHUB_SCRIPT_ACTION = 'actions/github-script@v7';

/** Filename the ship-check job writes the JSON report to before uploading. */
export const SHIP_JSON_FILE = 'devcortex-ship.json';
/** HTML comment used as the sticky PR comment marker (prefix match). */
export const SHIP_COMMENT_MARKER = '<!-- devcortex-ship-report -->';

// --- Check model ------------------------------------------------------------

/**
 * One DevCortex CI check (spec §4.8). `id` doubles as the workflow job id (and
 * therefore the PR status-check name suffix); `cliCommand` is the DevCortex CLI
 * invocation the job runs, given verbatim after {@link DEVCORTEX_CLI_INVOCATION}.
 */
export interface DevCortexCheck {
  /** Workflow job id / stable check identifier (spec §4.8 name). */
  id: string;
  /** Human-readable job name shown in the Actions UI. */
  name: string;
  /** CLI subcommand run after `npx devcortex` (e.g. `ship`, `verify`, `feature list`). */
  cliCommand: string;
  /** What this gate enforces. */
  description: string;
}

/**
 * The five DevCortex CI checks, in the order spec §4.8 lists them. See the
 * module header for the CLI-command mapping rationale.
 */
export const DEVCORTEX_CHECKS: readonly DevCortexCheck[] = [
  {
    id: 'ship-check',
    name: 'DevCortex ship-check',
    cliCommand: 'ship',
    description:
      'Evidence-backed ship gate: fails the check when the change is not proven ready ' +
      '(typecheck/lint/build/test + recorded evidence). Mirrors `devcortex ship`, which ' +
      'exits non-zero when NOT_READY.',
  },
  {
    id: 'quality-gate',
    name: 'DevCortex quality-gate',
    cliCommand: 'verify',
    description:
      'General code quality gate: runs the project-configured typecheck / lint / build / ' +
      'test commands plus DevCortex route and env checks.',
  },
  {
    id: 'feature-ledger-check',
    name: 'DevCortex feature-ledger-check',
    cliCommand: 'feature list',
    description:
      'Feature-ledger integrity: loads and lists the project feature ledger, failing on a ' +
      'corrupt or unreadable ledger so feature records stay valid across PRs.',
  },
  {
    id: 'security-gate',
    name: 'DevCortex security-gate',
    cliCommand: 'verify',
    description:
      'Security gate: enforced today through `devcortex verify` (secrets/env/route checks). ' +
      'Point `cliCommand` at the dedicated `devcortex security` command once the security-gate ' +
      'module ships (spec §7.12).',
  },
  {
    id: 'ui-gate',
    name: 'DevCortex ui-gate',
    cliCommand: 'verify',
    description:
      'UI quality gate: enforced today through `devcortex verify`. Point `cliCommand` at the ' +
      'dedicated `devcortex ui` command once the ui-quality-gate module ships (spec §7.13).',
  },
];

// --- Workflow trigger --------------------------------------------------------

/**
 * The workflow trigger. Explicit (never a bare/null event) so the emitted YAML
 * is unambiguous: run on every pull request (any base branch) and on pushes to
 * `main`. `synchronize` re-runs the checks when new commits are pushed to a PR.
 */
export function buildWorkflowTrigger(): Record<string, unknown> {
  return {
    push: { branches: ['main'] },
    pull_request: { types: ['opened', 'synchronize', 'reopened'] },
  };
}

// --- Step builders (shared shape) -------------------------------------------

interface WorkflowStep {
  name: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  shell?: string;
  'working-directory'?: string;
}

/**
 * The shared preamble every gate job runs: check out the repo, set up Node with
 * a dependency cache, install, and build. Returned fresh each call so callers
 * never share mutable step objects.
 */
function checkoutAndBuildSteps(): WorkflowStep[] {
  return [
    { name: 'Checkout', uses: CHECKOUT_ACTION },
    {
      name: 'Set up Node.js',
      uses: SETUP_NODE_ACTION,
      with: { 'node-version': DEFAULT_NODE_VERSION, cache: 'npm' },
    },
    { name: 'Install dependencies', run: DEFAULT_INSTALL_COMMAND },
    { name: 'Build', run: DEFAULT_BUILD_COMMAND },
  ];
}

/** The full CLI command a check runs, e.g. `npx devcortex ship`. */
export function checkRunCommand(check: DevCortexCheck): string {
  return `${DEVCORTEX_CLI_INVOCATION} ${check.cliCommand}`;
}

/** Builds the single job for one DevCortex check. */
function buildCheckJob(check: DevCortexCheck): Record<string, unknown> {
  return {
    name: check.name,
    'runs-on': DEFAULT_RUNNER,
    steps: [
      ...checkoutAndBuildSteps(),
      { name: `Run ${DEVCORTEX_CLI_BIN} ${check.cliCommand}`, run: checkRunCommand(check) },
    ],
  };
}

// --- Ship-check PR comment script -------------------------------------------

/**
 * Returns the deterministic JS string executed by `actions/github-script` to
 * create or update a sticky PR comment with the DevCortex ship report.
 *
 * Field bindings (ShipReport from @devcortex/core — verified 2026-07-02):
 *   report.status  → ShipReport.status (ShipStatus: READY | READY_WITH_WARNINGS | NOT_READY)
 *   report.passed  → ShipReport.passed  (CheckResult[]) — count of passing checks
 *   report.blocked → ShipReport.blocked (CheckResult[]) — count of blocking checks
 *   data.blocked   → top-level boolean from cmdShip (blockUnprovenDone result)
 *   data.reasons   → top-level string[] from cmdShip
 * Note: ShipReport has no `score` field; passed/blocked counts are used instead.
 */
export function buildShipCommentScript(): string {
  return [
    `const fs = require('fs');`,
    `const marker = '${SHIP_COMMENT_MARKER}';`,
    `let data = null;`,
    `try { data = JSON.parse(fs.readFileSync('${SHIP_JSON_FILE}', 'utf8')); } catch { data = null; }`,
    `const report = data && data.report ? data.report : {};`,
    `const status = report.status || 'UNKNOWN';`,
    `const emoji = status === 'READY' ? '🟢' : status === 'READY_WITH_WARNINGS' ? '🟡' : '🔴';`,
    `const passed = Array.isArray(report.passed) ? report.passed.length : '—';`,
    `const blocked = Array.isArray(report.blocked) ? report.blocked.length : '—';`,
    `const reasons = Array.isArray(data && data.reasons) ? data.reasons : [];`,
    `const lines = [marker, '## ' + emoji + ' DevCortex ship report', '', '**Status:** ' + status + '   **Passed:** ' + passed + '   **Blocked:** ' + blocked, ''];`,
    `if (data && data.blocked) { lines.push('**Blocked — unproven done:**'); for (const r of reasons.slice(0, 10)) lines.push('- ' + r); lines.push(''); }`,
    `lines.push('_Full report in the devcortex-ship-report workflow artifact._');`,
    `const body = lines.join('\\n');`,
    `const { data: comments } = await github.rest.issues.listComments({ owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number, per_page: 100 });`,
    `const existing = comments.find((c) => c.body && c.body.startsWith(marker));`,
    `if (existing) { await github.rest.issues.updateComment({ owner: context.repo.owner, repo: context.repo.repo, comment_id: existing.id, body }); }`,
    `else { await github.rest.issues.createComment({ owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number, body }); }`,
  ].join('\n');
}

// --- Ship-check dedicated job builder ----------------------------------------

/**
 * Builds the ship-check job with the full PR-native ship-report pipeline:
 *   1. Run `devcortex ship --json` (continue-on-error so later steps always run)
 *   2. Upload the JSON file as a workflow artifact
 *   3. Post / update a sticky PR comment (same-repo PRs only — fork-safe)
 *   4. Append a human-readable summary to the GitHub step summary
 *   5. Enforce: fail the job iff ship returned non-zero
 *
 * The composite action (`buildShipCheckActionObject`) remains a pure gate so
 * teams that only want `uses: devcortex/ship-check` are not forced to accept
 * the comment step. The comment logic lives only here.
 */
function buildShipCheckJob(check: DevCortexCheck): Record<string, unknown> {
  return {
    name: check.name,
    'runs-on': DEFAULT_RUNNER,
    steps: [
      ...checkoutAndBuildSteps(),
      {
        name: `Run ${DEVCORTEX_CLI_BIN} ${check.cliCommand} (JSON)`,
        id: 'ship',
        'continue-on-error': true,
        run: `${checkRunCommand(check)} --json > ${SHIP_JSON_FILE}`,
      },
      {
        name: 'Upload ship report artifact',
        if: 'always()',
        uses: UPLOAD_ARTIFACT_ACTION,
        with: { name: 'devcortex-ship-report', path: SHIP_JSON_FILE, 'if-no-files-found': 'ignore' },
      },
      {
        name: 'Comment ship report',
        if: "always() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
        uses: GITHUB_SCRIPT_ACTION,
        with: { script: buildShipCommentScript() },
      },
      {
        name: 'Ship report to job summary',
        if: 'always()',
        shell: 'bash',
        run: `{ echo '## DevCortex ship report'; echo '\`\`\`json'; cat ${SHIP_JSON_FILE} 2>/dev/null || echo '{"error":"no report produced"}'; echo '\`\`\`'; } >> "$GITHUB_STEP_SUMMARY"`,
      },
      {
        name: 'Enforce ship gate',
        if: "steps.ship.outcome == 'failure'",
        shell: 'bash',
        run: 'echo "devcortex ship exited non-zero (NOT_READY or error) — failing the check." && exit 1',
      },
    ],
  };
}

// --- Workflow builder --------------------------------------------------------

/**
 * Builds the GitHub Actions workflow document as a plain object: one job per
 * DevCortex check. Pure and deterministic.
 *
 * Workflow-level `permissions` follow least-privilege: `contents: read` for
 * checkout, `pull-requests: write` for the sticky PR comment in ship-check.
 */
export function buildWorkflowObject(): Record<string, unknown> {
  const jobs: Record<string, unknown> = {};
  for (const check of DEVCORTEX_CHECKS) {
    jobs[check.id] = check.id === 'ship-check' ? buildShipCheckJob(check) : buildCheckJob(check);
  }
  return {
    name: WORKFLOW_NAME,
    on: buildWorkflowTrigger(),
    permissions: { contents: 'read', 'pull-requests': 'write' },
    jobs,
  };
}

// --- Composite action builder ------------------------------------------------

/**
 * Builds the `devcortex-ship-check` composite action document as a plain object.
 * The action is turnkey — it checks out, sets up Node, installs, builds, and
 * runs `devcortex ship` — so callers need only `uses: devcortex/ship-check`.
 * Inputs let consumers override the Node version, install/build commands, and
 * working directory. Pure and deterministic.
 */
export function buildShipCheckActionObject(): Record<string, unknown> {
  return {
    name: SHIP_CHECK_ACTION_NAME,
    description:
      'Run the DevCortex evidence-backed ship gate. Fails the check when the change is not ' +
      'proven ready (typecheck/lint/build/test + recorded evidence).',
    inputs: {
      'node-version': {
        description: 'Node.js version to set up.',
        required: false,
        default: DEFAULT_NODE_VERSION,
      },
      'install-command': {
        description: 'Command used to install dependencies.',
        required: false,
        default: DEFAULT_INSTALL_COMMAND,
      },
      'build-command': {
        description: 'Command used to build the project before shipping.',
        required: false,
        default: DEFAULT_BUILD_COMMAND,
      },
      'working-directory': {
        description: 'Directory to run DevCortex in.',
        required: false,
        default: '.',
      },
    },
    runs: {
      using: 'composite',
      steps: [
        { name: 'Checkout', uses: CHECKOUT_ACTION },
        {
          name: 'Set up Node.js',
          uses: SETUP_NODE_ACTION,
          with: { 'node-version': '${{ inputs.node-version }}', cache: 'npm' },
        },
        {
          name: 'Install dependencies',
          shell: 'bash',
          'working-directory': '${{ inputs.working-directory }}',
          run: '${{ inputs.install-command }}',
        },
        {
          name: 'Build',
          shell: 'bash',
          'working-directory': '${{ inputs.working-directory }}',
          run: '${{ inputs.build-command }}',
        },
        {
          name: `Run ${DEVCORTEX_CLI_BIN} ship`,
          shell: 'bash',
          'working-directory': '${{ inputs.working-directory }}',
          run: `${DEVCORTEX_CLI_INVOCATION} ship`,
        },
      ],
    },
  };
}

// --- YAML serialisation ------------------------------------------------------

/**
 * A `#`-comment banner prepended to a generated YAML document. Declares the file
 * DevCortex-owned and auto-generated so hand edits are not mistaken for user
 * config (the whole file is regenerated/overwritten on the next install).
 */
function buildHeader(lines: readonly string[]): string {
  const rule = '# ---------------------------------------------------------------------------';
  return [rule, ...lines.map((line) => (line === '' ? '#' : `# ${line}`)), rule].join('\n');
}

const WORKFLOW_HEADER = buildHeader([
  'DevCortex — GitHub Actions CI workflow',
  '',
  'AUTO-GENERATED by `devcortex install github-actions`. Safe to delete or',
  'regenerate. This whole file is DevCortex-owned; hand edits are overwritten on',
  'the next regenerate (re-run with { force: true }).',
  '',
  'Enforces the DevCortex rules on pull requests and pushes to main via five',
  'named checks (spec §4.8). Assumes `devcortex` (the DevCortex CLI) is a',
  'devDependency so `npx devcortex` resolves the locally-installed binary.',
]);

const SHIP_CHECK_ACTION_HEADER = buildHeader([
  'DevCortex — composite ship-check action',
  '',
  'AUTO-GENERATED by `devcortex install github-actions`. Safe to delete or',
  'regenerate. Wraps `devcortex ship` so any workflow can enforce the DevCortex',
  'ship gate with a single `uses:` step. This whole file is DevCortex-owned; hand',
  'edits are overwritten on the next regenerate (re-run with { force: true }).',
]);

/** yaml.stringify options: no line-wrapping (deterministic long `run:` lines). */
const YAML_OPTIONS = { lineWidth: 0 } as const;

/** Serialises an object to a headed YAML document with a single trailing newline. */
function serializeDocument(header: string, value: Record<string, unknown>): string {
  // yaml.stringify already terminates with a newline; the header adds its own.
  return `${header}\n${stringify(value, YAML_OPTIONS)}`;
}

/** The exact bytes written to `.github/workflows/devcortex.yml`. */
export function buildWorkflowYaml(): string {
  return serializeDocument(WORKFLOW_HEADER, buildWorkflowObject());
}

/** The exact bytes written to `.github/actions/devcortex-ship-check/action.yml`. */
export function buildShipCheckActionYaml(): string {
  return serializeDocument(SHIP_CHECK_ACTION_HEADER, buildShipCheckActionObject());
}
