/**
 * Docker (containerization) reference stack pack.
 *
 * Real, current (2026) guidance for building production container images: small
 * multi-stage builds off pinned, minimal (slim/distroless) bases, running as a
 * non-root user with a read-only root filesystem and dropped capabilities,
 * keeping secrets out of image layers/ENV (BuildKit --mount=type=secret, runtime
 * env only), ordering layers for cache hits, a .dockerignore, a HEALTHCHECK, and
 * exec-form entrypoints with proper PID-1 signal handling so containers stop
 * gracefully. Language-agnostic: keyed off a `docker` deployment hint.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// Containerization is language-agnostic — match on a `docker` deployment hint.
const DOCKER_HINTS = ['docker', 'container', 'containers'];

const bestPractices: Rule[] = [
  {
    id: 'docker.multi-stage-build',
    title: 'Use multi-stage builds so build tooling never ships in the runtime image',
    detail:
      'Compile/install in a build stage and COPY only the artifacts (dist/, node_modules --prod, the binary) into a lean runtime stage. The final image then omits compilers, dev dependencies, and source, shrinking size and attack surface.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'docker.minimal-pinned-base',
    title: 'Start from a minimal base pinned by version (ideally digest)',
    detail:
      'Prefer slim/distroless/alpine bases and pin them to a specific tag or @sha256 digest so builds are reproducible and you control when the base changes. A smaller base means fewer CVEs and a faster pull.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'docker.run-as-non-root',
    title: 'Create and switch to a non-root USER',
    detail:
      'Add a dedicated unprivileged user/group and declare USER before the entrypoint so the process does not run as root. A container escape from a root process is far more dangerous; most apps need no root privileges at all.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'docker.no-secrets-in-layers',
    title: 'Never bake secrets into ARG/ENV, COPY, or layers',
    detail:
      'Build-time ARG and every COPY are recorded in the image history, and ENV secrets persist in the running image. Use BuildKit `RUN --mount=type=secret` for build-time credentials and inject runtime secrets via env/secret manager at `docker run` time.',
    severity: 'critical',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'docker.dockerignore',
    title: 'Ship a .dockerignore that excludes .git, .env, and local deps',
    detail:
      'Without .dockerignore the whole context (including .git history, .env files, node_modules, test fixtures) is sent to the daemon and can land in the image via COPY . .. Exclude them to keep the context small, builds fast, and secrets out.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'docker.layer-cache-order',
    title: 'Copy the lockfile and install deps before copying source',
    detail:
      'COPY package.json pnpm-lock.yaml (or requirements.txt) and install first, then COPY the source. Dependency layers then stay cached across source-only changes; copying everything before installing busts the cache on every edit.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'docker.exec-form-signals',
    title: 'Use exec-form CMD/ENTRYPOINT and handle PID 1 signals',
    detail:
      'Exec form (["node","server.js"]) makes your process PID 1 and receive SIGTERM directly; shell form wraps it in /bin/sh which swallows signals, so the container waits the full grace period before being killed. Add tini/an init for processes that spawn children and need reaping.',
    severity: 'medium',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'docker.healthcheck',
    title: 'Declare a HEALTHCHECK (or rely on the orchestrator probe)',
    detail:
      'A HEALTHCHECK lets Docker/Compose report unhealthy containers and lets orchestrators gate traffic. Keep it cheap (a lightweight endpoint), with sensible interval/timeout/retries, and hit the real readiness path rather than just "process alive".',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'docker.harden-runtime',
    title: 'Run hardened: read-only rootfs, dropped caps, no privilege escalation',
    detail:
      'Run with --read-only (mounting a tmpfs for the few writable paths), --cap-drop ALL (adding back only what is needed), --security-opt no-new-privileges, and never --privileged. This narrows what a compromised container can do.',
    severity: 'high',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'docker.scan-and-production-env',
    title: 'Scan images and build for production (prune dev deps)',
    detail:
      'Scan images for known CVEs (Trivy/Grype/Docker Scout) in CI and fail on high severity. Set NODE_ENV=production / install without dev dependencies so the runtime image carries only what it needs.',
    severity: 'medium',
    appliesTo: ['config', 'test'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'docker.anti.run-as-root',
    title: 'Running the container process as root',
    detail:
      'Leaving the default root USER means any RCE runs with root inside the container and a wider blast radius on escape. Create a non-root user and switch to it before the entrypoint.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'docker.anti.secret-in-image',
    title: 'Baking a secret into the image via ARG/ENV/COPY',
    detail:
      'A token passed as ARG or set in ENV, or a copied .env, is retrievable with `docker history` / by inspecting layers even if a later layer deletes it. Use BuildKit secrets for build-time and runtime env for run-time; rotate anything already baked.',
    severity: 'critical',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'docker.anti.latest-base-tag',
    title: 'Using :latest (or no tag) for the base image',
    detail:
      'FROM node:latest makes builds non-reproducible — the same Dockerfile produces different images over time and can silently pull in a breaking base. Pin a specific version tag or digest.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'docker.anti.copy-before-install',
    title: 'COPY . . before installing dependencies',
    detail:
      'Copying the whole source before the install step invalidates the dependency layer on every code change, so every build re-installs from scratch. Copy the lockfile, install, then copy source.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'docker.anti.no-dockerignore',
    title: 'No .dockerignore, so .git/.env/node_modules enter the build',
    detail:
      'Without .dockerignore, COPY . . drags secrets (.env), history (.git), and bulky local artifacts into the context and image. Add a .dockerignore mirroring .gitignore plus build outputs.',
    severity: 'high',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'docker.anti.shell-form-entrypoint',
    title: 'Shell-form CMD so PID 1 ignores SIGTERM',
    detail:
      'CMD node server.js (shell form) runs the app under /bin/sh -c, which does not forward SIGTERM, so graceful shutdown is skipped and the container is SIGKILLed after the grace period. Use exec form and, if needed, an init like tini.',
    severity: 'medium',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'docker.anti.fat-runtime-image',
    title: 'A single-stage image carrying build tools and dev dependencies',
    detail:
      'Installing compilers, git, and dev dependencies into the final image bloats it and adds CVEs. Split build from runtime with multi-stage and copy only the artifacts and production dependencies.',
    severity: 'medium',
    appliesTo: ['config'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'docker',
    supported: '>=27',
    note: 'Docker Engine 27.x with BuildKit as the default builder — required for `RUN --mount=type=secret`, cache mounts, and multi-platform builds.',
  },
  {
    pkg: 'docker-compose',
    supported: '^2',
    note: 'Compose v2 (the `docker compose` plugin). The top-level `version:` key is obsolete; use profiles, depends_on with condition: service_healthy, and secrets.',
  },
  {
    pkg: 'node',
    supported: '>=22',
    note: 'For Node images use node:22-slim (or distroless/nodejs22) pinned by digest; match the base major to your app\'s engines.',
  },
  {
    pkg: 'trivy',
    supported: '^0.56',
    note: 'Trivy (or Grype / Docker Scout) to scan images for CVEs in CI; fail the build on HIGH/CRITICAL findings.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'docker.fail.secret-in-history',
    signature: 'A token/key is recoverable via `docker history --no-trunc` or by extracting an image layer, despite being "deleted" later',
    cause: 'The secret was passed as a build ARG/ENV or COPYed in; each instruction is its own immutable layer, so a later RUN rm does not remove it from history.',
    fix: 'Rebuild with BuildKit `RUN --mount=type=secret=id=...` for build-time credentials, inject runtime secrets via env/secret manager at run time, and rotate the exposed secret.',
  },
  {
    id: 'docker.fail.permission-denied-nonroot',
    signature: 'EACCES / "permission denied" writing a file or binding a port after switching to a non-root USER',
    cause: 'The non-root user does not own the writable directory, or the app binds a privileged port (<1024).',
    fix: 'chown the writable paths to the non-root user in the build, write only to owned/tmpfs paths, and bind an unprivileged port (>=1024), mapping it externally.',
  },
  {
    id: 'docker.fail.sigterm-ignored',
    signature: 'Container takes the full ~10s grace period to stop and is then SIGKILLed; in-flight requests are dropped on deploy',
    cause: 'Shell-form CMD/ENTRYPOINT ran the process under /bin/sh, which did not forward SIGTERM to the app.',
    fix: 'Switch to exec-form CMD (["node","server.js"]), add tini/an init if the app spawns children, and implement a SIGTERM handler that drains connections.',
  },
  {
    id: 'docker.fail.cache-busts-every-build',
    signature: 'Every build re-runs `pnpm install` / `pip install` even when only source changed',
    cause: 'COPY . . preceded the install step, so any source change invalidated the dependency layer.',
    fix: 'Copy the lockfile/manifest and install first, then COPY the source; use a BuildKit cache mount for the package cache.',
  },
  {
    id: 'docker.fail.readonly-fs-write',
    signature: 'EROFS: read-only file system when the app writes a temp/log/cache file under --read-only',
    cause: 'The hardened container has a read-only root filesystem but the app writes outside a mounted writable volume.',
    fix: 'Mount a tmpfs (or a named volume) for the specific writable paths (/tmp, cache dirs) and configure the app to write only there.',
  },
  {
    id: 'docker.fail.image-too-large',
    signature: 'The final image is many hundreds of MB / slow to pull and push',
    cause: 'A single-stage build kept build tools, dev dependencies, and source in the runtime image, or the base is a full OS image.',
    fix: 'Adopt a multi-stage build copying only artifacts + production deps into a slim/distroless base, and add a .dockerignore to shrink the context.',
  },
];

/**
 * The Docker containerization reference pack. Matches when the detected stack
 * advertises a `docker`/`container` deployment target (language-agnostic).
 */
export const dockerPack: StackPack = {
  id: 'docker-container',
  name: 'Docker — container image builds',
  matches: (stack) => stack.deploymentTargets.some((target) => DOCKER_HINTS.includes(target)),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'docker>=27',
    'docker-compose@^2',
    'buildkit@latest',
    'tini@^0.19',
    'trivy@^0.56',
    'hadolint@^2',
  ],
  versionChecks,
  setupCommands: [
    'DOCKER_BUILDKIT=1 docker build -t app:local .',
    'docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges -p 8080:8080 app:local',
    'docker compose up --build',
  ],
  testCommands: [
    'docker build -t app:test .',
    'hadolint Dockerfile',
    'trivy image --severity HIGH,CRITICAL --exit-code 1 app:test',
    'docker history --no-trunc app:test',
  ],
  qualityGates: [
    'The Dockerfile uses a multi-stage build; the runtime image contains no compilers or dev dependencies.',
    'The base image is pinned to a version tag or digest — never :latest.',
    'The container runs as a non-root USER.',
    'No secret is present in ARG/ENV/COPY or image history (verified with docker history / a scan); build-time secrets use BuildKit --mount=type=secret.',
    'A .dockerignore excludes .git, .env*, node_modules, and build outputs.',
    'Dependency install precedes source COPY so the dependency layer caches.',
    'CMD/ENTRYPOINT use exec form and the app handles SIGTERM; a HEALTHCHECK (or orchestrator probe) is defined.',
    'An image CVE scan (Trivy/Grype/Scout) runs in CI and fails on HIGH/CRITICAL.',
  ],
  securityNotes: [
    'Every build instruction is an immutable layer: ARG/ENV secrets and COPYed .env files are recoverable via docker history even after a later delete — use BuildKit `--mount=type=secret` and inject runtime secrets via env/secret manager.',
    'Run as a non-root USER with a read-only root filesystem, --cap-drop ALL (adding back only what is needed), and --security-opt no-new-privileges; never run --privileged.',
    'Pin base images by digest and rebuild to pick up patched bases; scan for CVEs in CI and fail on HIGH/CRITICAL.',
    'Ship a .dockerignore so .git, .env, and local credentials never enter the build context or the image.',
    'Keep the runtime image minimal (slim/distroless) to shrink the attack surface, and drop build tooling via multi-stage.',
  ],
  deploymentNotes: [
    'Enable BuildKit (default in Engine 27) for secret mounts, cache mounts, and multi-platform (--platform linux/amd64,linux/arm64) builds.',
    'Tag images immutably (git SHA / semver), not :latest, and push to a registry with vulnerability scanning enabled.',
    'Handle SIGTERM to drain connections and set a sane stop grace period; use exec form so PID 1 receives the signal.',
    'Externalise all configuration and secrets as runtime env / mounted secrets so the same image promotes across environments unchanged.',
    'Mount a tmpfs/volume for the few writable paths when running with --read-only, and expose only the ports the service needs.',
  ],
  commonFailures,
};
