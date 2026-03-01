# UAT Wow-Effect 5 — Cross-Runtime in k9s `:ao` Table

**Phase:** 6 (`RemoteAgentWatcher`)
**Status:** ✅ DONE — Phase 6 implemented

---

## Goal

Demonstrate the "Datadog moment": a single k9s `:ao` table shows AI agents from multiple
runtimes side by side — in-cluster pods (Tier 0 sidecar), AWS Bedrock agents (Tier 1 push),
and Google Vertex AI agents (Tier 1 push) — all with live health and compliance grades.

---

## Architecture

```
k9s :ao
┌─────────────────────────────────────────────────────────────────────┐
│  NAME                PHASE    GRADE  SCORE  MODEL  SOURCE      RUNTIME  │
│  gymcoach            Healthy  A      94     pass   agent-sdk   k8s      │
│  trading-bot         Degraded D      45     fail   man-static  k8s      │
│  bedrock-assistant   Healthy  B      82     pass   agent-sdk   bedrock  │
│  vertex-trader       Degraded D      45     fail   agent-sdk   vertex   │
└─────────────────────────────────────────────────────────────────────┘
         ↑                    ↑                       ↑
    Kopf probes          Operator              RemoteAgentWatcher
    sidecar :4001        reads .status          polls control plane
    (in-cluster)         (set by c-plane)       /api/v1/agents → upserts CRs
                              ↑
                         POST /api/v1/heartbeat
                         (SDK push from Bedrock/Vertex)
```

---

## Step-by-Step Demo

```bash
# Preconditions:
# - Operator installed (Phase 1)
# - Control plane running (Phase 3)
# - SDK push mode in Bedrock + Vertex agents (Phase 4)
# - RemoteAgentWatcher enabled in operator (Phase 6)

# 0. Create the control-plane secret (admin key for GET /api/v1/agents)
kubectl -n agentspec-system create secret generic agentspec-control-plane \
  --from-literal=apiKey="${CONTROL_PLANE_ADMIN_KEY}"

# 1. Upgrade operator with RemoteAgentWatcher enabled
helm upgrade agentspec packages/operator/helm/agentspec-operator/ \
  --namespace agentspec-system \
  --set controlPlane.enabled=true \
  --set controlPlane.url=https://control-plane.agentspec.io \
  --set controlPlane.pollInterval=30

# Helm creates the agentspec-remote namespace automatically.
kubectl get namespace agentspec-remote

# 2. Deploy in-cluster demo agents
kubectl apply -f packages/operator/demo/

# 3. Simulate Bedrock agent phoning home
AGENTSPEC_URL=https://control-plane.agentspec.io \
AGENTSPEC_KEY=bedrock-key \
python bedrock_agent.py &   # runs with SDK startPushMode()

# 4. Simulate Vertex AI agent phoning home
AGENTSPEC_URL=https://control-plane.agentspec.io \
AGENTSPEC_KEY=vertex-key \
python vertex_agent.py &    # runs with SDK startPushMode()

# 5. Check control plane knows about all agents
curl -s -H "X-Admin-Key: ${CONTROL_PLANE_ADMIN_KEY}" \
  https://control-plane.agentspec.io/api/v1/agents \
  | jq '.[] | {agentName, runtime, phase, grade}'

# 6. Verify CRs were created in agentspec-remote namespace
kubectl get agentobservations -n agentspec-remote

# 7. Open k9s and navigate to :ao
k9s
# → press : → type ao → Enter
# → ALL agents appear in one table, regardless of runtime
# → Table auto-refreshes every 5s

# 8. Drill down on a Bedrock agent (Shift-H in k9s)
# → kubectl port-forward isn't needed — control plane serves the health report
# → Plugin calls GET /api/v1/agents/{name}/health (new control plane endpoint)
```

---

## Expected k9s Output

```
NAME                NAMESPACE       PHASE    GRADE  SCORE  MODEL  VIOLATIONS  SOURCE      CHECKED
gymcoach            demo            Healthy  A      94     pass   0           agent-sdk   12s
trading-bot         demo            Degraded D      45     fail   5           man-static  8s
voice-assistant     demo            Unhealthy F     12     skip   9           man-static  3m
bedrock-assistant   agentspec-remote Healthy  B      82     pass   2           agent-sdk   5s
vertex-trader       agentspec-remote Degraded D      45     fail   5           agent-sdk   1m
```

The `agentspec-remote` namespace contains CRs for agents that can't have sidecars.
The operator treats them identically to in-cluster agents.

---

## Troubleshooting

- Remote agents not appearing: check `RemoteAgentWatcher` logs in operator pod
- Stale status: `RemoteAgentWatcher` poll interval may be too long (default 30s)
- Namespace missing: create `agentspec-remote` namespace and give operator RBAC
- Grade not updating: ensure heartbeat interval in SDK is shorter than k9s refresh

---

## Implementation Notes (Phase 6) — DONE

New file in `packages/operator/`:
- `remote_watcher.py` — `RemoteAgentWatcher` class
  - Polls `GET /api/v1/agents` on the control plane every N seconds (X-Admin-Key auth)
  - For each agent, upserts `AgentObservation` CR in `agentspec-remote` namespace
  - CR `spec.source = "control-plane"` signals operator NOT to probe sidecar
  - `_seen_at` cache skips k8s upsert when `lastSeen` is unchanged (idempotent)
  - Rate-limit guard: >500 agents processed in batches of 100
  - RFC-1123 validation rejects dotted/uppercase names with a warning (no crash)
  - API key never logged (`[REDACTED]` in all error messages)

Operator changes (`operator.py`):
- `@kopf.on.startup()` starts `RemoteAgentWatcher` when `CONTROL_PLANE_URL` + `CONTROL_PLANE_KEY` are set
- `@kopf.on.cleanup()` stops the watcher on shutdown
- `reconcile_agent_health` daemon: early return when `spec.source == "control-plane"`

Helm chart changes:
- `values.yaml`: `controlPlane.enabled/url/apiKey/pollInterval/namespace` section
- `deployment.yaml`: `CONTROL_PLANE_URL`, `CONTROL_PLANE_KEY` (from Secret), `CONTROL_PLANE_POLL_INTERVAL` env vars
- `clusterrole.yaml`: `namespaces: [get, create]` when `controlPlane.enabled`
- `crd.yaml`: `spec.source` field (`sidecar` | `control-plane`)
- `namespace.yaml`: conditional `agentspec-remote` namespace

Control plane endpoint (Phase 3):
- `GET /api/v1/agents/{name}/health` — returns last known HealthReport for drill-down
