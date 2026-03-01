# AgentSpec Webhook — Testing Guide (Phase 2)

## Goal

Verify that the Phase 2 MutatingWebhook correctly:

1. **Injects** — pods annotated `agentspec.io/inject: "true"` get the sidecar container appended
2. **Ignores** — un-annotated pods are NOT mutated
3. **Idempotent** — pods with the sidecar already present are not double-injected
4. **Creates CR** — `AgentObservation` is auto-created in the same namespace as the pod
5. **TLS** — webhook server runs on `:9443` with cert-manager self-signed cert
6. **Non-blocking** — `failurePolicy: Ignore` means a dead webhook never blocks pod scheduling
7. **GC** — `AgentObservation` CR is auto-deleted when the pod is deleted (ownerReference)

---

## Architecture Under Test

```
kubectl apply (Pod with agentspec.io/inject=true)
        ↓
kube-apiserver  →  MutatingWebhookConfiguration
        ↓  POST /mutate  (TLS :9443)
webhook.py  (running in operator pod)
        ↓
1. build_sidecar_patch()    →  JSON Patch (sidecar container + volume)
2. _create_agent_observation()  →  AgentObservation CR (ownerRef → pod)
3. build_admission_response()   →  AdmissionReview with base64 patch
        ↓
Pod starts: 2 containers (agent + agentspec-sidecar)
        ↓
Kopf daemon picks up AgentObservation CR → probes → patches .status
        ↓
k9s :ao  →  new row (Pending → Healthy in ~35s)
```

---

## Test Levels

### Level 1 — Unit Tests (no cluster, < 1s)

Pure Python, no HTTP server, no k8s API calls. Covers all pure webhook functions
and the Starlette handler via `TestClient`.

```bash
# From packages/operator/
pip install -r requirements-dev.txt
pytest tests/test_webhook.py -v
```

Expected output:
```
tests/test_webhook.py::TestShouldInject::test_inject_true_annotation_returns_true   PASSED
tests/test_webhook.py::TestShouldInject::test_inject_uppercase_True_returns_false   PASSED
tests/test_webhook.py::TestIsSidecarPresent::test_sidecar_present_returns_true      PASSED
tests/test_webhook.py::TestBuildSidecarPatch::test_sidecar_already_present_is_idempotent PASSED
tests/test_webhook.py::TestMutateHandler::test_annotated_pod_returns_200_with_patch PASSED
tests/test_webhook.py::TestMutateHandler::test_oversized_payload_returns_413        PASSED
tests/test_webhook.py::TestMutateHandler::test_healthz_returns_ok                  PASSED
...
41 passed in 0.1s
```

Full suite (including Phase 1 regression):
```bash
pytest tests/ -v
# Expected: 121 passed
```

---

### Level 2 — Helm Lint (no cluster, requires helm CLI)

Verifies that all Helm templates render without errors when webhook is enabled.

```bash
# Install helm if needed: https://helm.sh/docs/intro/install/
helm version

# Lint with webhook disabled (default)
helm lint helm/agentspec-operator

# Lint with webhook + cert-manager enabled
helm lint helm/agentspec-operator \
  --set webhook.enabled=true \
  --set webhook.certManager.enabled=true

# Lint with webhook enabled, cert-manager disabled + custom caBundle
helm lint helm/agentspec-operator \
  --set webhook.enabled=true \
  --set webhook.certManager.enabled=false \
  --set webhook.caBundle="dGVzdA=="
```

Expected output for each:
```
==> Linting helm/agentspec-operator
[INFO] Chart.yaml: icon is recommended

1 chart(s) linted, 0 chart(s) failed
```

Dry-run render to spot template issues:
```bash
helm template agentspec helm/agentspec-operator \
  --namespace agentspec-system \
  --set webhook.enabled=true \
  --set webhook.certManager.enabled=true \
  | grep -E "^(kind|  name):" | sort
```

Expected kinds (in addition to Phase 1):
```
kind: Certificate
kind: ClusterRole
kind: ClusterRoleBinding
kind: Deployment
kind: Issuer
kind: MutatingWebhookConfiguration
kind: Service
kind: ServiceAccount
```

---

### Level 3 — Cluster Smoke Test (kind cluster, no sidecar image)

Tests that the webhook intercepts pod creation and the annotation routing is
correct — even before the sidecar image is available. Sidecar container will
`ImagePullBackOff` but the injection itself is verified.

#### 3a. Prerequisites

```bash
# Phase 1 operator already installed
helm status agentspec -n agentspec-system

# cert-manager installed
kubectl get pods -n cert-manager
# cert-manager-xxx    1/1  Running
```

#### 3b. Upgrade operator with webhook enabled

```bash
# Build fresh image with webhook.py included
docker build -t agentspec-operator:dev .
kind load docker-image agentspec-operator:dev --name agentspec

helm upgrade agentspec helm/agentspec-operator \
  --namespace agentspec-system \
  --set operator.image.repository=agentspec-operator \
  --set operator.image.tag=dev \
  --set operator.image.pullPolicy=Never \
  --set webhook.enabled=true \
  --set webhook.certManager.enabled=true
```

Wait for the cert to be issued:
```bash
kubectl wait --for=condition=Ready \
  certificate/agentspec-operator-webhook-cert \
  -n agentspec-system \
  --timeout=60s
```

Verify the `MutatingWebhookConfiguration` is registered:
```bash
kubectl get mutatingwebhookconfigurations agentspec-operator-inject
# NAME                          WEBHOOKS   AGE
# agentspec-operator-inject     1          <age>
```

#### 3c. Test — annotated pod gets sidecar injected

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: webhook-test-annotated
  namespace: default
  annotations:
    agentspec.io/inject: "true"
    agentspec.io/agent-name: webhook-test
spec:
  containers:
    - name: agent
      image: python:3.12-slim
      command: ["python", "-c", "import time; time.sleep(3600)"]
EOF

# Verify sidecar was appended
kubectl get pod webhook-test-annotated -o jsonpath='{.spec.containers[*].name}'
# Expected: agent agentspec-sidecar

# Verify AgentObservation was created
kubectl get agentobservation webhook-test -n default
# NAME           PHASE    GRADE  SCORE  ...
# webhook-test   Pending  ...
```

#### 3d. Test — un-annotated pod is NOT mutated

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: webhook-test-clean
  namespace: default
spec:
  containers:
    - name: agent
      image: python:3.12-slim
      command: ["python", "-c", "import time; time.sleep(3600)"]
EOF

kubectl get pod webhook-test-clean -o jsonpath='{.spec.containers[*].name}'
# Expected: agent    (sidecar must NOT be present)
```

#### 3e. Test — failurePolicy: Ignore (webhook failure doesn't block pods)

```bash
# Scale operator to 0 (kills the webhook server)
kubectl scale deployment agentspec-operator -n agentspec-system --replicas=0

# Pod creation should still succeed
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: webhook-test-failopen
  namespace: default
  annotations:
    agentspec.io/inject: "true"
spec:
  containers:
    - name: agent
      image: python:3.12-slim
      command: ["python", "-c", "import time; time.sleep(3600)"]
EOF

# Pod must be created (sidecar absent, but pod not blocked)
kubectl get pod webhook-test-failopen
# STATUS: Pending or Running (not Error/Blocked)

# Restore operator
kubectl scale deployment agentspec-operator -n agentspec-system --replicas=1
```

#### 3f. Test — ownerReference GC

```bash
# Delete the annotated pod from 3c
kubectl delete pod webhook-test-annotated -n default

# AgentObservation should disappear within a few seconds (k8s GC via ownerRef)
sleep 5
kubectl get agentobservation webhook-test -n default 2>&1
# Expected: Error from server (NotFound): ...
```

#### 3g. Cleanup

```bash
kubectl delete pod webhook-test-annotated webhook-test-clean webhook-test-failopen \
  --ignore-not-found -n default
kubectl delete agentobservation webhook-test --ignore-not-found -n default
```

---

### Level 4 — Full E2E Demo (kind + sidecar image)

The wow-1 UAT — see `uat/wow-1-zero-touch-inject.md` for the complete walkthrough
with the sidecar image loaded, k9s `:ao` table live view, and GC verification.

```bash
# Run the automated verification script
bash uat/verify-webhook.sh --namespace agentspec-system --target-namespace default
```

---

## Webhook Server Direct Tests

Test the `/mutate` and `/healthz` endpoints directly via `kubectl exec` or port-forward.

```bash
# Port-forward the webhook port (TLS — use -k for self-signed cert)
kubectl port-forward -n agentspec-system deploy/agentspec-operator 9443:9443 &

# Health check
curl -sk https://localhost:9443/healthz
# {"status":"ok"}

# Simulate an annotated pod AdmissionReview
curl -sk -X POST https://localhost:9443/mutate \
  -H "Content-Type: application/json" \
  -d '{
    "request": {
      "uid": "test-uid-1",
      "name": "my-pod",
      "namespace": "default",
      "object": {
        "metadata": {
          "annotations": {"agentspec.io/inject": "true"}
        },
        "spec": {
          "containers": [{"name": "agent", "image": "python:3.12"}]
        }
      }
    }
  }' | python3 -m json.tool
# Expected: "allowed": true, "patch": "<base64>", "patchType": "JSONPatch"

# Simulate an un-annotated pod — must return allowed:true with NO patch
curl -sk -X POST https://localhost:9443/mutate \
  -H "Content-Type: application/json" \
  -d '{
    "request": {
      "uid": "test-uid-2",
      "name": "plain-pod",
      "namespace": "default",
      "object": {
        "metadata": {},
        "spec": {
          "containers": [{"name": "agent", "image": "python:3.12"}]
        }
      }
    }
  }' | python3 -m json.tool
# Expected: "allowed": true, NO "patch" field

kill %1  # stop port-forward
```

---

## Recovery Scenarios

### Scenario A — Webhook pod restarts mid-deploy

```bash
# Kill the operator pod while a batch of pods is being created
kubectl rollout restart deploy/agentspec-operator -n agentspec-system

# New pods without annotations: must schedule normally (failurePolicy: Ignore)
# New pods with annotation: sidecar may be absent until webhook recovers (~10s)
# Existing injected pods: unaffected (already mutated)
```

### Scenario B — cert-manager cert expires

```bash
# Check cert expiry
kubectl get certificate agentspec-operator-webhook-cert -n agentspec-system \
  -o jsonpath='{.status.notAfter}'

# cert-manager will auto-renew 30 days before expiry (renewBefore: 720h).
# To force renewal manually:
kubectl delete secret agentspec-webhook-tls -n agentspec-system
# cert-manager recreates the secret automatically within seconds.
```

### Scenario C — Disable webhook without downtime

```bash
# Disable webhook (no new injections, existing pods unaffected)
helm upgrade agentspec helm/agentspec-operator \
  -n agentspec-system \
  --set webhook.enabled=false

# MutatingWebhookConfiguration is removed
kubectl get mutatingwebhookconfigurations 2>&1
# Error from server (NotFound): ... (or absent from list)
```

---

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Sidecar NOT injected on annotated pod | `kubectl get mutatingwebhookconfigurations` | Webhook not registered — `webhook.enabled=true`? |
| `certificate not ready` | `kubectl describe certificate ... -n agentspec-system` | cert-manager not installed or webhook |
| `x509: certificate signed by unknown authority` | caBundle not injected | cert-manager annotation on `MutatingWebhookConfiguration`? |
| `AgentObservation` not created | `kubectl logs -n agentspec-system deploy/agentspec-operator \| grep webhook` | RBAC: SA needs `create` on `agentobservations` |
| Pod blocked on creation | `kubectl get events` | Should never happen (`failurePolicy: Ignore`) |
| Double sidecar injection | `kubectl get pod -o yaml \| grep agentspec-sidecar` | Idempotency bug — re-run `pytest tests/test_webhook.py -k idempotent` |
| `413` from webhook | Request body > 1 MiB | kube-apiserver misconfiguration — normal AdmissionReviews are < 100 KiB |
| Webhook logs show `missing uid` | kube-apiserver version mismatch | Ensure k8s >= 1.16 (AdmissionReview v1) |
