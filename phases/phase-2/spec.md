# Phase 2 — MutatingWebhook Auto-Inject

**Status: ✅ DONE**
**Depends on:** Phase 1 (operator + CRD installed)

---

## Goal

Zero-touch sidecar injection: a developer annotates a Pod with `agentspec.io/inject: "true"`
and the agentspec-sidecar container is automatically appended by a `MutatingWebhookConfiguration`,
with an `AgentObservation` CR auto-created in the same namespace.

No manual `sidecarServiceName`, no extra Deployment YAML, no Helm values per-agent.
The operator becomes fully self-configuring for in-cluster agents.

---

## Why This Phase

Phase 1 requires the operator + sidecar to be configured manually per-agent.
Phase 2 removes that friction: annotate → deploy → appears in k9s. This is the
"Datadog agent inject" moment — the same UX that made DaemonSet-based observability
ubiquitous. It is also the prerequisite for the wow-1 UAT demo.

---

## Deliverables

| Deliverable | File(s) | Status |
|-------------|---------|--------|
| Webhook server (TLS, `/mutate` endpoint) | `packages/operator/webhook.py` | ✅ |
| `MutatingWebhookConfiguration` Helm template | `helm/.../templates/webhook.yaml` | ✅ |
| cert-manager `Certificate` + `Issuer` template | `helm/.../templates/webhook-cert.yaml` | ✅ |
| Webhook unit tests (patch logic, annotation checks) | `tests/test_webhook.py` | ✅ |
| Helm values for webhook (enable/disable, cert opts) | `values.yaml` additions | ✅ |
| Updated Dockerfile (expose :9443) | `Dockerfile` | ✅ |
| UAT guide for wow-1 | `uat/wow-1-zero-touch-inject.md` (update stub) | ✅ |

---

## Files to Create / Modify

### New files
- `packages/operator/webhook.py` — aiohttp/Starlette webhook server
  - `POST /mutate` — AdmissionReview handler
  - Appends sidecar container + volume mount to Pod spec
  - Creates `AgentObservation` CR via `kubernetes-asyncio`
  - Returns JSON Patch
- `packages/operator/tests/test_webhook.py` — unit tests for patch logic
- `packages/operator/helm/agentspec-operator/templates/webhook.yaml`
  - `MutatingWebhookConfiguration` — intercepts Pod `CREATE` when annotation present
  - `failurePolicy: Ignore` (sidecar inject is best-effort, don't block pods)
- `packages/operator/helm/agentspec-operator/templates/webhook-cert.yaml`
  - cert-manager `Issuer` (self-signed) + `Certificate` for webhook TLS
  - Alternative: `caBundle` auto-inject via cert-manager annotation

### Modified files
- `packages/operator/Dockerfile` — expose port 9443, run webhook + kopf as separate processes
  or start webhook in background thread from operator entrypoint
- `packages/operator/helm/agentspec-operator/values.yaml` — add `webhook:` section
- `packages/operator/requirements.txt` — add `starlette` or keep `aiohttp`

---

## Architecture

```
kubectl apply (Pod with annotation agentspec.io/inject=true)
       ↓
kube-apiserver  →  MutatingWebhookConfiguration
       ↓  POST /mutate  (TLS, :9443)
webhook.py  (running in operator pod)
       ↓
1. Build JSON Patch: append sidecar container + configmap volume
2. Create AgentObservation CR (kubernetes-asyncio)
3. Return AdmissionReview with patch
       ↓
Pod starts with 2 containers: agent + agentspec-sidecar
       ↓
Kopf daemon picks up the new AgentObservation CR → probes → patches .status
       ↓
k9s :ao  →  new row appears (Pending → Healthy in ~35s)
```

### Sidecar inject patch (JSON Patch)
```json
[
  {
    "op": "add",
    "path": "/spec/containers/-",
    "value": {
      "name": "agentspec-sidecar",
      "image": "ghcr.io/agentspec/sidecar:latest",
      "ports": [{"containerPort": 4000}, {"containerPort": 4001}],
      "env": [{"name": "AGENTSPEC_MANIFEST_PATH", "value": "/app/agent.yaml"}],
      "volumeMounts": [{"name": "agent-yaml", "mountPath": "/app/agent.yaml", "subPath": "agent.yaml"}]
    }
  }
]
```

### Annotation spec
| Annotation | Required | Description |
|-----------|----------|-------------|
| `agentspec.io/inject` | yes (`"true"`) | Opt-in trigger |
| `agentspec.io/agent-name` | no | Overrides CR name (defaults to pod name) |
| `agentspec.io/manifest-configmap` | no | ConfigMap name containing `agent.yaml` |
| `agentspec.io/check-interval` | no | Probe interval in seconds (default: 30) |

---

## Acceptance Criteria

- [x] Pod with `agentspec.io/inject: "true"` gets sidecar appended automatically
- [x] Pod without annotation is NOT mutated
- [x] `AgentObservation` CR is auto-created in the same namespace as the pod
- [x] Webhook uses TLS (cert-manager self-signed cert)
- [x] `failurePolicy: Ignore` — webhook failure does not block pod scheduling
- [x] `pytest tests/test_webhook.py -v` → 33 tests pass
- [ ] `helm lint` passes with webhook templates enabled (requires helm CLI)
- [x] Existing 76 tests still pass (109 total, zero regressions)
- [ ] UAT: `kubectl apply` annotated pod → appears in k9s `:ao` within 35s (requires cluster)

---

## TLS Strategy

Use cert-manager (simplest option for k8s-native TLS):

```yaml
# values.yaml
webhook:
  enabled: true
  certManager:
    enabled: true   # requires cert-manager installed in cluster
  # Alternative: provide your own caBundle
  caBundle: ""
```

For dev/CI without cert-manager: use a pre-generated self-signed cert mounted via Secret.

**Risk**: cert-manager is a cluster-level dependency. Helm chart must check and warn if absent.

---

## Security Considerations

- Webhook must validate `AdmissionReview.request.uid` — include in response
- `failurePolicy: Ignore` prevents webhook from becoming a DoS vector
- Sidecar image pinned to SHA digest in production values
- `namespaceSelector` on webhook: skip `kube-system` and `agentspec-system`
- Owner reference on created `AgentObservation` CR → auto-deleted when pod is deleted

---

## Test Plan

### Unit tests (`tests/test_webhook.py`)
- Annotated pod → patch contains sidecar container
- Un-annotated pod → empty patch (no mutation)
- Sidecar already present → idempotent (no double-inject)
- Custom agent-name annotation → CR name matches
- Invalid annotation value (not "true") → no mutation
- Admission response includes correct UID

### Integration tests (requires cluster)
- Apply annotated pod → CR exists → sidecar running
- Delete pod → CR deleted (owner reference GC)
