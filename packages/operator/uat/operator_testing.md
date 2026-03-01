# AgentSpec Operator — Testing Guide

## Goal

Verify that the AgentSpec Kubernetes operator correctly:

1. **Installs** — CRD and operator deploy cleanly via Helm
2. **Watches** — `AgentObservation` CRs are picked up immediately on create/resume
3. **Probes** — sidecar `/health/ready` and `/gap` endpoints are called every `spec.checkInterval` seconds
4. **Patches** — `.status` (phase, grade, score, violations, conditions) is updated with each probe result
5. **Degrades gracefully** — when the sidecar is unreachable, phase becomes `Unknown` instead of crashing
6. **Guards SSRF** — invalid `sidecarServiceName` (dotted, uppercase, IP) is rejected with `PermanentError`
7. **Shows live in k9s** — `:ao` table renders all 7 columns with the correct values

---

## Architecture Under Test

```
k9s  →  :ao  →  live table (Phase | Grade | Score | Model | Violations | Source | Checked)
                       ↑
         AgentObservation .status  (patched by operator every 30s)
                       ↑
         Kopf daemon  →  GET sidecar :4001/health/ready
                      →  GET sidecar :4001/gap
                       ↑
         agentspec-sidecar  (port 4001, running as sidecar container in agent pod)
```

The three demo agents have intentionally different compliance profiles:

| Agent | Expected phase | Expected grade | Reason |
|-------|---------------|---------------|--------|
| `gymcoach` | Healthy | A | Full guardrails, model key set |
| `trading-bot` | Degraded | D | No guardrails, model key unset |
| `voice-assistant` | Unhealthy | F | Minimal manifest, nothing set |

---

## Related Guides

| Guide | Phase | What it covers |
|-------|-------|---------------|
| `operator_testing.md` (this file) | 1 | CRD, Kopf reconciler, SSRF guards, k9s demo |
| `webhook_testing.md` | 2 | MutatingWebhook, sidecar inject, cert-manager TLS |
| `wow-1-zero-touch-inject.md` | 2 | Zero-touch inject demo (wow-effect 1) |
| `verify.sh` | 1 | Automated Phase 1 verification script |
| `verify-webhook.sh` | 2 | Automated Phase 2 verification script |

---

## Test Levels

### Level 1 — Unit Tests (no cluster, runs in <10 s)

Pure Python, mocked I/O. Covers `score_to_grade`, `build_status_patch`, `_sidecar_url`
SSRF guards, `make_unavailable_probe`, and `probe_agent` with a mocked HTTP client.

```bash
# From packages/operator/
pip install -r requirements-dev.txt
pytest tests/ -v
```

Expected output:
```
tests/test_status.py::TestScoreToGrade::test_100_is_A        PASSED
tests/test_status.py::TestScoreToGrade::test_90_is_A         PASSED
...
tests/test_operator.py::TestSidecarUrlRejectsDottedNames::test_ip_address_rejected  PASSED
...
76 passed in X.XXs
```

---

### Level 2 — Operator Smoke Test (local cluster, no sidecar image)

Tests that the operator itself deploys, the CRD is installed, and the operator
reconciles AgentObservation CRs — even when the sidecar is unreachable (expected
behaviour: phase=`Unknown`, `ConnectError` logged at `ERROR` level).

#### 2a. Cluster setup (kind)

```bash
# Install kind if needed: https://kind.sigs.k8s.io/
kind create cluster --name agentspec --config uat/kind-cluster.yaml

# Verify
kubectl cluster-info --context kind-agentspec
```

#### 2b. Build the operator image locally

```bash
# From packages/operator/
docker build -t agentspec-operator:dev .

# Load into kind (no registry needed)
kind load docker-image agentspec-operator:dev --name agentspec
```

#### 2c. Install the operator via Helm

```bash
helm install agentspec helm/agentspec-operator \
  --namespace agentspec-system \
  --create-namespace \
  --set operator.image.repository=agentspec-operator \
  --set operator.image.tag=dev \
  --set operator.image.pullPolicy=Never   # use the locally loaded image

# Verify operator is running
kubectl get pods -n agentspec-system
kubectl logs -n agentspec-system deploy/agentspec-operator -f
```

Expected log output (within 10s):
```
[2026-...] AgentSpec operator started
```

#### 2d. Deploy the demo AgentObservations

```bash
kubectl apply -f demo/

# Verify CRs exist
kubectl get agentobservation -n demo

# Within 5s you should see Pending status
kubectl get ao -n demo
# NAME              PHASE     GRADE  SCORE  MODEL  VIOLATIONS  SOURCE  CHECKED
# gymcoach          Pending   <none> <none> <none> <none>      <none>  <none>
```

#### 2e. Verify SSRF guard

```bash
# Apply a CR with a dotted sidecarServiceName — operator must reject it permanently
kubectl apply -f - <<EOF
apiVersion: agentspec.io/v1
kind: AgentObservation
metadata:
  name: ssrf-test
  namespace: demo
spec:
  agentRef:
    name: ssrf-test
  sidecarServiceName: "169.254.169.254"   # metadata endpoint — must be rejected
  sidecarPort: 80
EOF

# Operator logs should show PermanentError within seconds
kubectl logs -n agentspec-system deploy/agentspec-operator | grep ssrf-test
# Expected: [ssrf-test] invalid spec — sidecarServiceName '169.254.169.254' is not a valid DNS label ...

# Cleanup
kubectl delete agentobservation ssrf-test -n demo
```

#### 2f. Run the automated verify script

```bash
bash uat/verify.sh --namespace agentspec-system --demo-namespace demo
```

At this level, checks 1–5 should all pass. Checks 6 (expected grade/phase) will
show `WARN` because the sidecar image isn't available yet — that is expected.

---

### Level 3 — Full End-to-End Demo (cluster + sidecar image)

Tests the complete stack: operator probes a running sidecar which in turn probes
the agent, and the live k9s table shows the correct compliance grades.

#### 3a. Build and load the sidecar image

```bash
# From repo root (AgentBoot monorepo)
pnpm --filter @agentspec/sidecar build
docker build -t ghcr.io/agentspec/sidecar:0.1.0 -f packages/sidecar/Dockerfile .
kind load docker-image ghcr.io/agentspec/sidecar:0.1.0 --name agentspec
```

#### 3b. Update demo deployments to use IfNotPresent pull policy

The demo manifests are pinned to `sidecar:0.1.0`. Since we loaded the image
into kind directly, add `imagePullPolicy: Never` to the sidecar container
(or patch on the fly):

```bash
kubectl patch deployment gymcoach -n demo --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/1/imagePullPolicy","value":"Never"}]'
kubectl patch deployment trading-bot -n demo --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/1/imagePullPolicy","value":"Never"}]'
kubectl patch deployment voice-assistant -n demo --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/1/imagePullPolicy","value":"Never"}]'
```

#### 3c. Wait for pods to be ready

```bash
kubectl get pods -n demo -w
# NAME                             READY   STATUS    RESTARTS
# gymcoach-xxxxx                   2/2     Running   0
# trading-bot-xxxxx                2/2     Running   0
# voice-assistant-xxxxx            2/2     Running   0
```

#### 3d. Watch in k9s

```
k9s
```

Type `:ao` and press Enter. The live table should appear within 35s (5s initial delay + 30s first probe):

```
NAME              PHASE      GRADE  SCORE  MODEL  VIOLATIONS  SOURCE         CHECKED
gymcoach          Healthy    A      94     pass   0           agent-sdk      12s
trading-bot       Degraded   D      45     fail   5           manifest-st    8s
voice-assistant   Unhealthy  F      12     skip   9           manifest-st    3m
```

Press `Shift-H` on any row to see the full health JSON (requires k9s plugin — see Helm NOTES.txt).
Press `Shift-G` to see the gap analysis.

#### 3e. Run the full verify script

```bash
bash uat/verify.sh --namespace agentspec-system --demo-namespace demo
```

All checks including section 7 (expected grades) should now pass.

---

## Manual Probe Verification

Test the sidecar endpoints directly without going through the operator:

```bash
# Port-forward the gymcoach sidecar service
kubectl port-forward svc/gymcoach-sidecar -n demo 4001:4001 &

# Health check
curl -s localhost:4001/health/ready | python3 -m json.tool
# Expected: { "status": "ready", "source": "agent-sdk", ... }

# Gap analysis
curl -s localhost:4001/gap | python3 -m json.tool
# Expected: { "score": 94, "issues": [], "source": "agent-sdk", ... }

# Kill the port-forward when done
kill %1
```

---

## Operator Recovery Scenarios

### Scenario A — Sidecar goes down mid-watch

```bash
# Scale sidecar to 0 replicas
kubectl scale deployment gymcoach -n demo --replicas=0

# Watch operator switch gymcoach to Unknown
kubectl get ao gymcoach -n demo -w
# PHASE changes: Healthy → Unknown (within 30s)

# Restore
kubectl scale deployment gymcoach -n demo --replicas=1
# PHASE recovers: Unknown → Healthy (within 35s)
```

### Scenario B — CR deleted and re-applied

```bash
kubectl delete agentobservation gymcoach -n demo

# Daemon is cancelled immediately (cancellation_timeout=5s)
kubectl logs -n agentspec-system deploy/agentspec-operator | tail -5

# Re-apply
kubectl apply -f demo/gymcoach/agentobservation.yaml

# Status should return to Healthy within 35s
kubectl get ao gymcoach -n demo -w
```

### Scenario C — Operator restart

```bash
kubectl rollout restart deploy/agentspec-operator -n agentspec-system
kubectl rollout status deploy/agentspec-operator -n agentspec-system

# Kopf on.resume fires for all existing CRs — status briefly returns to Pending
# then recovers on first probe (within 35s)
kubectl get ao -n demo
```

### Scenario D — Invalid sidecarPort (port range guard)

```bash
kubectl apply -f - <<EOF
apiVersion: agentspec.io/v1
kind: AgentObservation
metadata:
  name: port-test
  namespace: demo
spec:
  agentRef:
    name: port-test
  sidecarServiceName: test-sidecar
  sidecarPort: 80
EOF

# Operator must log PermanentError and stop retrying
kubectl logs -n agentspec-system deploy/agentspec-operator | grep port-test
# Expected: [port-test] invalid spec — sidecarPort 80 is out of the allowed range 1024–65535

kubectl delete agentobservation port-test -n demo
```

---

## Teardown

```bash
# Remove demo agents
kubectl delete -f demo/

# Uninstall operator
helm uninstall agentspec -n agentspec-system
kubectl delete namespace agentspec-system

# The CRD is kept by default (helm.sh/resource-policy: keep).
# To also remove the CRD:
kubectl delete crd agentobservations.agentspec.io

# Destroy the kind cluster
kind delete cluster --name agentspec
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| All agents stuck in `Pending` | Operator not running | `kubectl get pods -n agentspec-system` |
| `Unknown` phase immediately | Sidecar pod not ready / image pull error | `kubectl get pods -n demo` |
| `ConnectError` in operator logs | Sidecar service name mismatch | Check `spec.sidecarServiceName` matches Service name |
| `PermanentError` in operator logs | Invalid `sidecarServiceName` or `sidecarPort` | Fix CR spec (dotted name, port < 1024) |
| k9s `:ao` shows no rows | CRD not installed or no CRs in cluster | `kubectl get agentobservation -A` |
| Probe succeeds but grade is wrong | Sidecar returning stale data | Restart the sidecar pod |
| `ImagePullBackOff` on sidecar | Image not pushed / wrong tag | Build and load image (Level 3 setup) |
