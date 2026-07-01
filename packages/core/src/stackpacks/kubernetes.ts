/**
 * Kubernetes (orchestration) reference stack pack.
 *
 * Real, current (2026) guidance for running workloads on Kubernetes 1.31+:
 * resource requests/limits, liveness/readiness/startup probes, a hardened
 * securityContext (runAsNonRoot, readOnlyRootFilesystem, drop ALL capabilities,
 * seccompRuntimeDefault, allowPrivilegeEscalation:false) satisfying the
 * "restricted" Pod Security Standard, secrets kept out of committed manifests
 * (external-secrets / sealed-secrets / CSI), default-deny NetworkPolicies,
 * PodDisruptionBudgets + anti-affinity for availability, least-privilege RBAC,
 * and graceful shutdown via terminationGracePeriod + a preStop hook.
 * Language-agnostic: keyed off a `kubernetes`/`k8s`/managed-cluster hint.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// Orchestration is language-agnostic — match on a kubernetes deployment hint.
const K8S_HINTS = ['kubernetes', 'k8s', 'gke', 'eks', 'aks', 'openshift'];

const bestPractices: Rule[] = [
  {
    id: 'k8s.resource-requests-limits',
    title: 'Set CPU/memory requests and memory limits on every container',
    detail:
      'Requests drive scheduling and give the pod a QoS floor; a memory limit stops one container OOMing the node. Set requests to the steady-state need and a memory limit to a safe ceiling. Be cautious with CPU limits (they throttle) — many teams set CPU requests but omit CPU limits deliberately.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.probes',
    title: 'Define readiness, liveness, and (for slow starts) startup probes',
    detail:
      'Readiness gates traffic so a pod only receives requests when it can serve them; liveness restarts a wedged pod; a startupProbe protects slow-booting apps from premature liveness kills. Point readiness at a real dependency-aware endpoint, not just "process up".',
    severity: 'high',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'k8s.security-context-restricted',
    title: 'Harden the securityContext to the "restricted" Pod Security Standard',
    detail:
      'Set runAsNonRoot: true, a non-zero runAsUser, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities.drop: ["ALL"], and seccompProfile.type: RuntimeDefault. Label the namespace with pod-security.kubernetes.io/enforce: restricted so violations are rejected.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.secrets-not-in-manifests',
    title: 'Keep secrets out of committed manifests',
    detail:
      'A Kubernetes Secret is only base64-encoded, not encrypted, so never commit raw Secret YAML. Use External Secrets Operator / Sealed Secrets / the Secrets Store CSI driver to source values from a real secret manager, enable etcd encryption-at-rest, and mount secrets as files or env at runtime.',
    severity: 'critical',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'k8s.network-policy-default-deny',
    title: 'Apply default-deny NetworkPolicies and open only required flows',
    detail:
      'By default every pod can talk to every other pod. Add a default-deny ingress/egress NetworkPolicy per namespace and then allow only the specific pod-to-pod and egress flows the workload needs, so a compromised pod cannot pivot freely.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.availability-replicas-pdb-affinity',
    title: 'Run multiple replicas with a PodDisruptionBudget and anti-affinity',
    detail:
      'For a stateless service run >=2 replicas, add a PodDisruptionBudget (minAvailable) so voluntary disruptions (drains, upgrades) keep capacity, and spread replicas across nodes/zones with podAntiAffinity or topologySpreadConstraints.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.rolling-update-and-graceful-shutdown',
    title: 'Configure rolling updates and graceful shutdown',
    detail:
      'Set a RollingUpdate strategy (maxUnavailable/maxSurge), a terminationGracePeriodSeconds long enough to drain, and a preStop hook (a short sleep / connection-drain) so the pod stops receiving traffic before it exits. The app must handle SIGTERM.',
    severity: 'medium',
    appliesTo: ['config', 'service'],
  },
  {
    id: 'k8s.pin-image-digest-pull-policy',
    title: 'Pin images by digest and set an explicit imagePullPolicy',
    detail:
      'Reference images by @sha256 digest (or an immutable tag) so a rollout is deterministic and cannot drift when a mutable tag is repushed. Set imagePullPolicy accordingly (IfNotPresent for digests) and use imagePullSecrets for private registries.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.least-privilege-rbac-sa',
    title: 'Give each workload a dedicated ServiceAccount with least-privilege RBAC',
    detail:
      'Do not run workloads under the default ServiceAccount or grant cluster-admin. Create a per-workload SA, bind only the RBAC it needs, and set automountServiceAccountToken: false when the pod does not call the API server.',
    severity: 'high',
    appliesTo: ['config', 'auth'],
  },
  {
    id: 'k8s.hpa-autoscaling',
    title: 'Autoscale with an HPA driven by requests-based metrics',
    detail:
      'Add a HorizontalPodAutoscaler targeting CPU/memory utilisation (or custom metrics) so replicas track load. HPA math depends on resource requests being set, so requests and the HPA target must be defined together.',
    severity: 'medium',
    appliesTo: ['config'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'k8s.anti.no-resource-limits',
    title: 'Containers with no requests/limits',
    detail:
      'Without requests the scheduler cannot place pods sensibly and without a memory limit one container can OOM the whole node (BestEffort QoS is evicted first). Set requests everywhere and a memory limit.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.anti.run-as-root-privileged',
    title: 'Running as root / privileged / with escalation allowed',
    detail:
      'Default root, privileged: true, or allowPrivilegeEscalation left true gives a container near-host power on escape. Enforce runAsNonRoot, drop ALL capabilities, and forbid privilege escalation via the restricted PSS.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.anti.plaintext-secret-manifest',
    title: 'Committing Secret YAML / putting secrets in env literals',
    detail:
      'Secret data is only base64, so committing it (or hardcoding credentials in a ConfigMap/env) exposes it in git and to anyone with read access. Source secrets from a manager via External/Sealed Secrets or CSI and enable etcd encryption.',
    severity: 'critical',
    appliesTo: ['config', 'env'],
  },
  {
    id: 'k8s.anti.latest-image-tag',
    title: 'Deploying a :latest / mutable image tag',
    detail:
      'A mutable tag makes rollouts non-deterministic — repushing :latest silently changes what runs, and rollbacks are unreliable. Pin by digest or an immutable release tag.',
    severity: 'medium',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.anti.no-probes',
    title: 'No readiness probe, so traffic hits pods that cannot serve',
    detail:
      'Without a readiness probe the Service routes to pods during startup or while a dependency is down, causing 502/503s on every deploy. Without liveness a wedged pod never restarts. Define both (plus startup for slow boots).',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.anti.flat-network-no-policy',
    title: 'No NetworkPolicy — every pod can reach every pod',
    detail:
      'A flat cluster network lets a compromised or buggy pod reach databases and internal services it should never touch. Apply default-deny and allow only required flows.',
    severity: 'high',
    appliesTo: ['config'],
  },
  {
    id: 'k8s.anti.default-sa-cluster-admin',
    title: 'Workloads on the default ServiceAccount or bound to cluster-admin',
    detail:
      'Using the default SA (often with an automounted token) or granting broad/cluster-admin RBAC to an app means a compromised pod can drive the API server. Use per-workload SAs with minimal RBAC and disable token automount when unused.',
    severity: 'high',
    appliesTo: ['config', 'auth'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'kubernetes',
    supported: '>=1.31',
    note: 'Kubernetes 1.31+ (control plane). Pod Security Admission is GA — enforce the "restricted" standard via namespace labels; PodSecurityPolicy is removed.',
  },
  {
    pkg: 'kubectl',
    supported: '>=1.31',
    note: 'Keep kubectl within one minor of the cluster. Use `kubectl diff`/server-side apply and validate manifests before rollout.',
  },
  {
    pkg: 'helm',
    supported: '^3',
    note: 'Helm 3 for packaging/templating (no Tiller). Lint charts and template + diff before upgrade; or use Kustomize overlays per environment.',
  },
  {
    pkg: 'external-secrets',
    supported: '^0.10',
    note: 'External Secrets Operator (or Sealed Secrets / Secrets Store CSI) to sync secrets from a cloud secret manager instead of committing Secret YAML.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'k8s.fail.crashloopbackoff',
    signature: 'Pod status CrashLoopBackOff; restart count climbing',
    cause: 'The container exits soon after start — a bad command/config, a missing dependency, or a liveness probe killing a still-booting app.',
    fix: 'Read `kubectl logs --previous`, fix the startup error/config, add a startupProbe for slow boots, and confirm the entrypoint stays running (foreground process).',
  },
  {
    id: 'k8s.fail.oomkilled',
    signature: 'Container terminated with reason OOMKilled (exit 137)',
    cause: 'The container exceeded its memory limit (or the node ran out of memory and evicted it because no limit/request was set).',
    fix: 'Right-size the memory request/limit from observed usage, fix leaks, and set limits so a spike is contained to one pod rather than the node.',
  },
  {
    id: 'k8s.fail.imagepullbackoff',
    signature: 'Pod status ImagePullBackOff / ErrImagePull',
    cause: 'The image tag/digest does not exist, the registry is private without imagePullSecrets, or the registry is unreachable.',
    fix: 'Verify the image reference and that it was pushed, add the correct imagePullSecrets (or workload-identity registry access), and pin an existing digest.',
  },
  {
    id: 'k8s.fail.pending-unschedulable',
    signature: 'Pod stuck Pending; events show "0/N nodes are available: Insufficient cpu/memory" or taint mismatches',
    cause: 'No node satisfies the pod\'s resource requests / node selectors / affinity / taints-tolerations.',
    fix: 'Lower over-large requests, add capacity or enable cluster autoscaling, and reconcile nodeSelector/affinity/tolerations with the actual node labels/taints.',
  },
  {
    id: 'k8s.fail.createcontainerconfigerror',
    signature: 'Pod status CreateContainerConfigError; event "secret/configmap ... not found"',
    cause: 'The pod references a Secret/ConfigMap (env or volume) that does not exist in the namespace (often ordering or a typo).',
    fix: 'Create/sync the referenced Secret/ConfigMap (via External Secrets) in the same namespace before the Deployment, and check the key names match.',
  },
  {
    id: 'k8s.fail.readiness-503',
    signature: 'Service returns 502/503 during deploys, or endpoints stay empty though pods are Running',
    cause: 'No readiness probe (traffic sent before ready) or a readiness probe that never passes, so the pod is excluded from the Service endpoints.',
    fix: 'Add/point the readiness probe at a real ready endpoint, ensure it returns 200 only when dependencies are up, and add a preStop drain so terminating pods leave the endpoints first.',
  },
];

/**
 * The Kubernetes orchestration reference pack. Matches when the detected stack
 * advertises a kubernetes/managed-cluster deployment target (language-agnostic).
 */
export const kubernetesPack: StackPack = {
  id: 'kubernetes-orchestration',
  name: 'Kubernetes 1.31 — workload orchestration',
  matches: (stack) => stack.deploymentTargets.some((target) => K8S_HINTS.includes(target)),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'kubectl@^1.31',
    'helm@^3',
    'kustomize@^5',
    'external-secrets@^0.10',
    'kube-score@^1.19',
    'kubeconform@^0.6',
  ],
  versionChecks,
  setupCommands: [
    'kubectl create namespace app',
    'kubectl label namespace app pod-security.kubernetes.io/enforce=restricted',
    'kubectl apply -f k8s/ --dry-run=server',
    'helm upgrade --install app ./chart -n app',
  ],
  testCommands: [
    'kubectl apply -f k8s/ --dry-run=server',
    'kubeconform -strict -summary k8s/',
    'kube-score score k8s/*.yaml',
    'kubectl rollout status deploy/app -n app',
  ],
  qualityGates: [
    'Every container sets CPU/memory requests and a memory limit.',
    'Readiness and liveness probes are defined (plus a startup probe for slow-booting apps).',
    'The securityContext meets the restricted PSS (runAsNonRoot, readOnlyRootFilesystem, drop ALL caps, no privilege escalation, seccomp RuntimeDefault) and the namespace enforces it.',
    'No plaintext Secret YAML is committed; secrets come from a manager via External/Sealed Secrets or CSI with etcd encryption enabled.',
    'A default-deny NetworkPolicy is in place with only required flows opened.',
    'Stateless services run >=2 replicas with a PodDisruptionBudget and anti-affinity/topology spread.',
    'Images are pinned by digest/immutable tag; workloads use a dedicated least-privilege ServiceAccount (token automount off when unused).',
    'Manifests pass server-side dry-run and a policy/score check (kubeconform + kube-score) in CI.',
  ],
  securityNotes: [
    'Kubernetes Secrets are only base64-encoded — never commit Secret YAML; source them via External Secrets / Sealed Secrets / CSI and enable etcd encryption-at-rest.',
    'Enforce the restricted Pod Security Standard: runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation:false, drop ALL capabilities, seccompProfile RuntimeDefault; never run privileged.',
    'Apply default-deny NetworkPolicies and open only required pod-to-pod/egress flows so a compromised pod cannot pivot.',
    'Give each workload a dedicated ServiceAccount with least-privilege RBAC (no cluster-admin) and set automountServiceAccountToken:false when the pod does not call the API server.',
    'Pin images by digest so a repushed mutable tag cannot silently change what runs, and scan images before admission.',
  ],
  deploymentNotes: [
    'Use a RollingUpdate strategy with a PodDisruptionBudget, a terminationGracePeriod long enough to drain, and a preStop hook so pods leave the Service endpoints before exiting; the app must handle SIGTERM.',
    'Manage manifests with Helm or Kustomize overlays per environment, and gate rollout on `kubectl apply --dry-run=server` + kubeconform/kube-score in CI (GitOps via Argo CD/Flux for promotion).',
    'Add an HPA driven by requests-based metrics (requests must be set) and, where relevant, cluster autoscaling for node capacity.',
    'Prefer Workload Identity / IRSA over static cloud credentials in Secrets for pods that call cloud APIs.',
    'Watch rollout health with `kubectl rollout status` and keep the previous ReplicaSet for fast `kubectl rollout undo`.',
  ],
  commonFailures,
};
