# Operator Helm Values Reference

Complete reference for `packages/operator/helm/agentspec-operator/values.yaml`.

Install or upgrade:

```bash
helm install agentspec agentspec/operator -f my-values.yaml
helm upgrade  agentspec agentspec/operator -f my-values.yaml
```

---

## `operator`

Controls the operator pod itself.

| Key | Default | Description |
|-----|---------|-------------|
| `operator.image.repository` | `ghcr.io/agentspec/operator` | Operator container image |
| `operator.image.tag` | `""` (Chart.appVersion) | Image tag. Leave empty to track the chart version. |
| `operator.image.pullPolicy` | `IfNotPresent` | Image pull policy |
| `operator.replicas` | `1` | Replica count. Keep at 1 unless you have leader election configured. |
| `operator.resources.requests.cpu` | `50m` | CPU request |
| `operator.resources.requests.memory` | `64Mi` | Memory request |
| `operator.resources.limits.cpu` | `200m` | CPU limit |
| `operator.resources.limits.memory` | `128Mi` | Memory limit |
| `operator.livenessPort` | `8080` | Kopf built-in liveness probe port |
| `operator.env` | `[]` | Extra environment variables for the operator pod |

---

## `rbac`

| Key | Default | Description |
|-----|---------|-------------|
| `rbac.create` | `true` | Create ClusterRole, ClusterRoleBinding, and ServiceAccount. Set `false` if you manage RBAC separately. |
| `rbac.serviceAccountName` | `agentspec-operator` | ServiceAccount name |

---

## `installCRD`

| Key | Default | Description |
|-----|---------|-------------|
| `installCRD` | `true` | Install the `AgentObservation` CRD automatically. Set `false` if managing CRDs via GitOps or a separate pipeline. |

---

## `watchNamespace`

| Key | Default | Description |
|-----|---------|-------------|
| `watchNamespace` | `""` | Namespace to watch. Empty = all namespaces (requires ClusterRole). Set to a single namespace for a scoped install. |

---

## `webhook`

Configures the mutating admission webhook that injects the `agentspec-sidecar` (and optionally OPA) into agent pods.

> The webhook is **disabled by default** (`webhook.enabled: false`). Enabling it requires TLS — either via cert-manager or a manually supplied CA bundle.

### Enabling the webhook

```bash
helm upgrade agentspec agentspec/operator \
  --set webhook.enabled=true \
  --set webhook.certManager.enabled=true
```

### Injection mode

Controls which pods receive sidecar injection.

| Key | Default | Description |
|-----|---------|-------------|
| `webhook.injectMode` | `annotation` | `annotation` — only pods with `agentspec.io/inject: "true"` are injected (explicit opt-in). `default` — all pods in targeted namespaces are injected unless they carry `agentspec.io/inject: "false"` (opt-out). |

**Use `annotation` (default)** when onboarding incrementally or when you want explicit opt-in per workload.

**Use `default`** when you want full-namespace coverage without annotating every Deployment. Pair with `namespaceSelector` and `excludedNamespaces` to avoid injecting into system workloads.

### Namespace targeting

Two complementary layers:

**`webhook.namespaceSelector`** — Kubernetes-level filter evaluated by kube-apiserver *before* calling the webhook. Pods in non-matching namespaces never reach the webhook.

```yaml
# Only call the webhook for namespaces explicitly opted in:
webhook:
  namespaceSelector:
    matchLabels:
      agentspec.io/enabled: "true"

# Call webhook for all namespaces except system namespaces:
webhook:
  namespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values: [kube-system, kube-public, kube-node-lease]
```

> The operator's own release namespace is **always appended** to any `NotIn` exclusion list at render time, regardless of this setting, to prevent circular dependency injection.

**`webhook.excludedNamespaces`** — Handler-level exclusion list. Even if kube-apiserver routes a request to the webhook, the handler checks this list and returns `allowed: true` without injecting. Acts as a defence-in-depth layer when `namespaceSelector` cannot express all exclusions (e.g. dynamically created system namespaces).

```yaml
webhook:
  excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - my-infra-namespace
```

### TLS

| Key | Default | Description |
|-----|---------|-------------|
| `webhook.certManager.enabled` | `true` | When `true`, a self-signed cert-manager `Issuer` + `Certificate` are created and the `caBundle` is injected automatically. Requires cert-manager ≥ 1.x. |
| `webhook.caBundle` | `""` | When `certManager.enabled` is `false`, supply a base64-encoded PEM CA bundle manually. |
| `webhook.tls.secretName` | `agentspec-webhook-tls` | Kubernetes Secret name that cert-manager (or your pipeline) populates with `tls.crt` / `tls.key`. |
| `webhook.tls.duration` | `8760h` | Certificate lifetime (1 year). |
| `webhook.tls.renewBefore` | `720h` | Renewal window before expiry (30 days). |

### Sidecar image

| Key | Default | Description |
|-----|---------|-------------|
| `webhook.sidecarImage` | `ghcr.io/agentspec/sidecar:latest` | Sidecar image injected into annotated pods. **Pin to a SHA digest in production** for supply-chain security. |

---

## `webhook.opa`

When `opa.enabled` is `true`, the webhook injects an OPA container alongside every `agentspec-sidecar` and wires `OPA_URL` + `OPA_PROXY_MODE` env vars on the sidecar automatically — zero agent-side code changes required.

> **Requires:** A ConfigMap named `{agent-name}-{opa.policyConfigMapSuffix}` must exist in the pod's namespace before the pod starts. Generate it with `agentspec generate-policy agent.yaml --out policies/` then create a ConfigMap from the output.

| Key | Default | Description |
|-----|---------|-------------|
| `webhook.opa.enabled` | `false` | Inject OPA alongside every `agentspec-sidecar`. |
| `webhook.opa.image` | `openpolicyagent/opa:0.70.0-static` | OPA server image. Pin to a digest in production. |
| `webhook.opa.proxyMode` | `track` | Default per-request enforcement mode. See modes below. Can be overridden per pod with the `agentspec.io/opa-proxy-mode` annotation. |
| `webhook.opa.policyConfigMapSuffix` | `opa-policy` | Suffix used to derive the OPA policy ConfigMap name: `{agent-name}-{suffix}`. For an agent named `gymcoach` the ConfigMap must be named `gymcoach-opa-policy`. |

### OPA proxy modes

| Mode | Behaviour |
|------|-----------|
| `track` | Record violations in the sidecar audit ring and add `X-AgentSpec-OPA-Violations` response header. Request is always forwarded. Safe for initial rollout — never blocks traffic. |
| `enforce` | Block non-compliant requests with `403 PolicyViolation` **before** they reach the agent. Use after verifying policies in `track` mode first. |
| `off` | Disable per-request OPA checks on the proxy entirely. `/gap` still calls OPA if `OPA_URL` is set. |

---

## `controlPlane`

Enables `RemoteAgentWatcher`, which polls the control plane and upserts `AgentObservation` CRs for remote agents (Bedrock, Vertex, Docker, local) into a dedicated namespace.

| Key | Default | Description |
|-----|---------|-------------|
| `controlPlane.enabled` | `false` | Enable `RemoteAgentWatcher`. |
| `controlPlane.url` | `""` | Control plane base URL (e.g. `https://control-plane.agentspec.io`). |
| `controlPlane.apiKey` | `""` | Admin key for `GET /api/v1/agents`. Stored in a Kubernetes Secret. |
| `controlPlane.pollInterval` | `30` | Seconds between polls. |
| `controlPlane.namespace` | `agentspec-remote` | Namespace where remote `AgentObservation` CRs are created. Created automatically if it does not exist. |

---

## Pod annotation reference

Annotations set on individual **Pods** (or via `spec.template.metadata.annotations` on a Deployment) to control injection and sidecar behaviour.

| Annotation | Values | Description |
|------------|--------|-------------|
| `agentspec.io/inject` | `"true"` / `"false"` | Opt-in (`annotation` mode) or opt-out (`default` mode) of sidecar injection. |
| `agentspec.io/agent-name` | any string | Agent name used to resolve the manifest ConfigMap and OPA policy ConfigMap. Defaults to the pod's `app` label. |
| `agentspec.io/manifest-configmap` | ConfigMap name | Override the manifest ConfigMap name. Default: `{agent-name}-agent-yaml`. |
| `agentspec.io/check-interval` | integer (5–3600) | Health check interval in seconds for the injected sidecar. |
| `agentspec.io/opa-proxy-mode` | `enforce` / `track` / `off` | Per-pod override of `webhook.opa.proxyMode`. Takes precedence over the cluster default. |

### Example Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gymcoach
spec:
  template:
    metadata:
      annotations:
        agentspec.io/inject: "true"
        agentspec.io/agent-name: gymcoach
        agentspec.io/opa-proxy-mode: enforce   # override cluster default
    spec:
      containers:
        - name: gymcoach
          image: my-registry/gymcoach:latest
```

---

## Recommended production values

```yaml
operator:
  image:
    tag: "v0.2.0"   # pin to a specific release

webhook:
  enabled: true
  injectMode: annotation    # explicit opt-in per workload
  sidecarImage: ghcr.io/agentspec/sidecar@sha256:<digest>   # pin to digest

  namespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values: [kube-system, kube-public, kube-node-lease]

  excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease

  certManager:
    enabled: true

  opa:
    enabled: true
    image: openpolicyagent/opa@sha256:<digest>   # pin to digest
    proxyMode: track    # start with track, switch to enforce once policies are verified
    policyConfigMapSuffix: opa-policy
```

## See also

- [OPA Behavioral Policy Enforcement](../concepts/opa.md)
- [Generate OPA policies — step-by-step guide](../guides/opa-policy.md)
- [Sidecar Runbook](../RUNBOOK.md)
