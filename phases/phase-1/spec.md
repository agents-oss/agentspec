# Phase 1 — k8s Operator (Kopf + CRD + k9s)

**Status: ✅ COMPLETE**

---

## Goal

"One Helm command" demo: install the agentspec operator on a cluster, and every AI agent
pod is automatically monitored — compliance grade, health status, model reachability —
all visible live in k9s as a first-class Kubernetes resource.

---

## Deliverables

| Deliverable | File(s) | Status |
|-------------|---------|--------|
| CRD with 7 `additionalPrinterColumns` | `crds/agentobservation.yaml` | ✅ |
| Pydantic v2 models mirroring SDK types | `models.py` | ✅ |
| Async httpx prober (`/health/ready` + `/gap`) | `prober.py` | ✅ |
| Status patch builder + `score_to_grade()` | `status.py` | ✅ |
| Kopf create/resume + daemon reconciler | `operator.py` | ✅ |
| Dockerfile (Python 3.12-slim, non-root uid 1000) | `Dockerfile` | ✅ |
| Helm chart (CRD + Deployment + RBAC) | `helm/agentspec-operator/` | ✅ |
| 3 demo agents (gymcoach, trading-bot, voice-assistant) | `demo/` | ✅ |
| 76 unit tests (all passing) | `tests/` | ✅ |
| UAT guide + kind cluster config | `uat/` | ✅ |

---

## Files Created / Modified

### New files
- `packages/operator/operator.py` — Kopf daemon + SSRF-guarded `_sidecar_url()`
- `packages/operator/models.py` — Pydantic v2: ReadyReport, GapReport, ProbeResult
- `packages/operator/prober.py` — Async httpx probe with connection pool
- `packages/operator/status.py` — `build_status_patch()`, `score_to_grade()`
- `packages/operator/Dockerfile`
- `packages/operator/requirements.txt`
- `packages/operator/requirements-dev.txt`
- `packages/operator/pytest.ini`
- `packages/operator/crds/agentobservation.yaml`
- `packages/operator/helm/agentspec-operator/Chart.yaml`
- `packages/operator/helm/agentspec-operator/values.yaml`
- `packages/operator/helm/agentspec-operator/templates/*.yaml` (6 templates)
- `packages/operator/demo/namespace.yaml`
- `packages/operator/demo/kustomization.yaml`
- `packages/operator/demo/gymcoach/{deployment,service,agentobservation,agent}.yaml`
- `packages/operator/demo/trading-bot/{deployment,service,agentobservation}.yaml`
- `packages/operator/demo/voice-assistant/{deployment,service,agentobservation}.yaml`
- `packages/operator/tests/conftest.py`
- `packages/operator/tests/test_operator.py` (26 tests: SSRF guards)
- `packages/operator/tests/test_prober.py` (12 tests: prober)
- `packages/operator/tests/test_status.py` (38 tests: status patch)
- `packages/operator/uat/operator_testing.md`
- `packages/operator/uat/kind-cluster.yaml`
- `packages/operator/uat/verify.sh`

---

## Acceptance Criteria (all met)

- [x] `pytest tests/ -v` → 76 passed, 0 failed
- [x] SSRF guards: dotted names, IP addresses, uppercase, invalid ports → ValueError
- [x] CRD `additionalPrinterColumns`: 7 columns render in `kubectl get ao`
- [x] Helm chart lints cleanly (`helm lint`)
- [x] Dockerfile builds and runs as uid 1000
- [x] Demo agents cover A (gymcoach), D (trading-bot), F (voice-assistant) profiles

---

## Architecture

```
k9s :ao  →  AgentObservation CRD (.status)  ←  Kopf daemon  →  sidecar :4001
                                                    |
                                            probe_agent()
                                            /health/ready + /gap
                                            build_status_patch()
```

Key design choices:
- `@kopf.daemon` (not `@kopf.timer`): one daemon per CR, honours per-resource `checkInterval`
- `_sidecar_url()` validates DNS label + port range → rejects SSRF attempts with `PermanentError`
- Module-level `httpx.AsyncClient` with connection pool (max 100 connections)
- `make_unavailable_probe()` creates a synthetic F-grade result on probe failure

---

## Security Findings Fixed

All HIGH + MEDIUM findings from code review addressed before shipping:
- SSRF: DNS label + port range validation in `_sidecar_url()`
- Connection pool: module-level client prevents per-probe connection floods
- Non-root Dockerfile: uid 1000, readOnlyRootFilesystem
- Minimal RBAC: only `agentobservations` + `agentobservations/status` (no cluster-wide secrets)
