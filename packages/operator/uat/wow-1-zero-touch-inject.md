# UAT Wow-Effect 1 — Zero-Touch Sidecar Inject

**Phase:** 2 (MutatingWebhook)
**Status:** ✅ IMPLEMENTED — Phase 2 complete

---

## Goal

Demonstrate that a developer can deploy an AI agent pod with a single annotation and the
agentspec-sidecar is automatically injected, with an `AgentObservation` CR created. The
agent appears in k9s `:ao` table without any manual sidecar configuration.

---

## Architecture

```
kubectl apply  (pod with annotation agentspec.io/inject=true)
       ↓
MutatingWebhookConfiguration intercepts Pod CREATE (objectSelector + namespaceSelector)
       ↓
webhook.py POST /mutate (TLS :9443, running in operator pod)
       ↓
1. build_sidecar_patch() — JSON Patch: append agentspec-sidecar container + volume
2. _create_agent_observation() — AgentObservation CR (owner ref → pod)
3. build_admission_response() — AdmissionReview with base64 patch
       ↓
Pod starts with 2 containers: agent + agentspec-sidecar
       ↓
Kopf daemon picks up new AgentObservation CR → probes → patches .status
       ↓
k9s :ao table → new row (Pending → Healthy within ~35s)
```

---

## Prerequisites

```bash
# cert-manager installed in cluster
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
kubectl wait --for=condition=Available -n cert-manager deploy --all --timeout=120s

# Operator installed from Phase 1
helm status agentspec -n agentspec-system
```

---

## Step 1 — Upgrade operator with webhook enabled

```bash
helm upgrade agentspec ./helm/agentspec-operator \
  -n agentspec-system \
  --set webhook.enabled=true \
  --set webhook.certManager.enabled=true
```

Verify the webhook is registered:
```bash
kubectl get mutatingwebhookconfigurations agentspec-operator-inject
# → agentspec-operator-inject   1      <age>
```

Verify cert-manager issued the TLS cert:
```bash
kubectl get certificate -n agentspec-system agentspec-operator-webhook-cert
# → READY=True
```

---

## Step 2 — Deploy an annotated agent pod

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: agentspec-manifest
  namespace: default
data:
  agent.yaml: |
    apiVersion: agentspec.io/v1
    kind: AgentSpec
    metadata:
      name: demo-agent
    spec:
      model:
        provider: openai
        name: gpt-4o
---
apiVersion: v1
kind: Pod
metadata:
  name: demo-agent
  namespace: default
  annotations:
    agentspec.io/inject: "true"
    agentspec.io/agent-name: demo-agent
    agentspec.io/manifest-configmap: agentspec-manifest
    agentspec.io/check-interval: "30"
spec:
  containers:
    - name: agent
      image: python:3.12-slim
      command: ["python", "-c", "import time; time.sleep(3600)"]
EOF
```

---

## Step 3 — Verify sidecar injection

```bash
kubectl describe pod demo-agent -n default | grep -A 20 "Containers:"
```

Expected — two containers:
```
Containers:
  agent:
    Image: python:3.12-slim
    ...
  agentspec-sidecar:
    Image: ghcr.io/agentspec/sidecar:latest
    Ports: 4000/TCP, 4001/TCP
    Mounts: /app/agent.yaml from agent-yaml (rw)
```

---

## Step 4 — Verify AgentObservation CR

```bash
kubectl get ao demo-agent -n default
```

Expected (within 35 seconds):
```
NAME         PHASE    GRADE  SCORE  MODEL  VIOLATIONS  SOURCE     CHECKED
demo-agent   Healthy  A      94     pass   0           agent-sdk  5s
```

---

## Step 5 — Watch live in k9s

```bash
k9s
# → :ao
# → demo-agent row appears and transitions Pending → Healthy
```

---

## Step 6 — Verify owner-reference GC

```bash
kubectl delete pod demo-agent -n default
kubectl get ao demo-agent -n default   # should be gone within seconds
# → Error from server (NotFound): agentobservations.agentspec.io "demo-agent" not found
```

---

## Expected k9s `:ao` output

```
NAME         PHASE    GRADE  SCORE  MODEL    VIOLATIONS  SOURCE      CHECKED
demo-agent   Healthy  A      94     pass     0           agent-sdk   5s
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Webhook not intercepting | `kubectl get mutatingwebhookconfigurations` — cert-manager annotation present? |
| `READY=False` on Certificate | `kubectl describe certificate -n agentspec-system` — cert-manager running? |
| Sidecar not in pod | `kubectl logs -n agentspec-system deploy/agentspec-operator` — look for `[webhook]` lines |
| AgentObservation not created | Check RBAC: SA must have `create` on `agentobservations` |
| Webhook TLS errors | Verify cert Secret exists: `kubectl get secret agentspec-webhook-tls -n agentspec-system` |
| Pod blocked (should NOT happen) | `failurePolicy: Ignore` — webhook failure is always non-blocking |

---

## Annotation Reference

| Annotation | Required | Default | Description |
|-----------|----------|---------|-------------|
| `agentspec.io/inject` | yes (`"true"`) | — | Opt-in trigger |
| `agentspec.io/agent-name` | no | pod name | Overrides AgentObservation CR name |
| `agentspec.io/manifest-configmap` | no | `agentspec-manifest` | ConfigMap containing `agent.yaml` |
| `agentspec.io/check-interval` | no | `30` | Probe interval in seconds |
