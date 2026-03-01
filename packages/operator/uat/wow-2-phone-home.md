# UAT Wow-Effect 2 — Agent Phones Home from Managed Runtime

**Phase:** 3 (Control plane service — ✅ DONE) + 4 (SDK `startPushMode()` — ⬜ TODO)
**Status:** ✅ Phase 3 runnable now — Phase 4 steps marked `[Phase 4]`

---

## Goal

Demonstrate that an AI agent deployed to AWS Bedrock or Google Vertex AI (where we can't
inject a sidecar) can still appear in the k9s `:ao` table. The agent uses the agentspec SDK
to push health + gap data to the control plane, which upserts an `AgentObservation` CR.

---

## Architecture

```
Agent (Bedrock/Vertex/Docker)
  SDK: reporter.startPushMode({ url: AGENTSPEC_URL, apiKey: AGENTSPEC_KEY })
       ↓  every 30s
POST /api/v1/heartbeat  { health: HealthReport, gap: GapReport }
       ↓
Control plane (packages/control-plane/) — FastAPI
  → stores in DB
  → upserts AgentObservation CR in agentspec-remote namespace
       ↓
Kopf operator sees the CR (agentspec-remote namespace)
  → reads .status set by control plane (no probe needed — agent pushes)
       ↓
k9s :ao table — remote agent appears alongside in-cluster agents
```

---

## Prerequisites

| Requirement | Check command |
|------------|---------------|
| Docker + Compose v2 | `docker compose version` |
| `curl` + `jq` | `curl --version && jq --version` |
| Port 8000 free | `lsof -i :8000` (expect no output) |

---

## Step-by-Step Demo

### 1. Start the Control Plane

```bash
cd packages/control-plane

export JWT_SECRET="$(openssl rand -hex 32)"
export AGENTSPEC_ADMIN_KEY="$(openssl rand -hex 16)"

echo "Admin key: $AGENTSPEC_ADMIN_KEY"   # save this

docker compose up --build -d

# Wait for healthy (~30s)
docker compose ps
# control-plane   running (healthy)
```

Smoke test:
```bash
curl -s http://localhost:8000/docs | grep -q "Swagger" && echo "OK" || echo "FAIL"
```

---

### 2. Register a Remote Agent

```bash
ADMIN_KEY="$AGENTSPEC_ADMIN_KEY"

REGISTER=$(curl -s -X POST http://localhost:8000/api/v1/register \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{
    "agentName": "bedrock-assistant",
    "runtime": "bedrock",
    "manifest": {"spec": {"model": {"name": "anthropic.claude-3-sonnet-20240229-v1:0"}}}
  }')

echo "$REGISTER" | jq .
```

Expected:
```json
{
  "agentId": "agt_<uuid>",
  "apiKey": "eyJhbGc...",
  "expiresAt": "2026-04-01T..."
}
```

- [ ] `agentId` starts with `agt_`
- [ ] `apiKey` is a non-empty JWT
- [ ] `expiresAt` is ~30 days from now (not null)

```bash
AGENT_KEY=$(echo "$REGISTER" | jq -r '.apiKey')
```

---

### 3. Send a Heartbeat (simulating the remote agent)

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:8000/api/v1/heartbeat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_KEY" \
  -d '{
    "health": {
      "status": "ready",
      "agentName": "bedrock-assistant",
      "checks": [
        {"name": "model", "status": "pass", "message": "claude-3-sonnet reachable"}
      ]
    },
    "gap": {
      "score": 88,
      "grade": "B",
      "findings": []
    }
  }'
# Expected: 204
```

- [ ] Response is `204 No Content`

> **Phase 4**: In production this call is made automatically every 30s by
> `reporter.startPushMode()` inside the agent process.

---

### 4. List Agents

```bash
curl -s http://localhost:8000/api/v1/agents \
  -H "X-Admin-Key: $ADMIN_KEY" | jq .
```

Expected (trimmed):
```json
[
  {
    "agentId": "agt_<uuid>",
    "agentName": "bedrock-assistant",
    "runtime": "bedrock",
    "phase": "Healthy",
    "grade": "B",
    "score": 88,
    "lastSeen": "<recent timestamp>"
  }
]
```

- [ ] `phase` is `"Healthy"` (heartbeat status was `"ready"`)
- [ ] `grade` is `"B"` (score 88 → B ≥ 75)
- [ ] `score` is `88`
- [ ] `lastSeen` is within the last minute

---

### 5. Inspect Last Health Report

```bash
curl -s http://localhost:8000/api/v1/agents/bedrock-assistant/health \
  -H "X-Admin-Key: $ADMIN_KEY" | jq .
```

- [ ] `status` is `"ready"`
- [ ] `agentName` is `"bedrock-assistant"`
- [ ] `checks` array present with at least one entry

---

### 6. Security Checks

```bash
# Unauthenticated GET /agents → must reject
curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:8000/api/v1/agents
# Expected: 401 or 403

# Invalid JWT on heartbeat → must reject
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:8000/api/v1/heartbeat \
  -H "Authorization: Bearer totally.invalid.token" \
  -H "Content-Type: application/json" \
  -d '{"health":{},"gap":{}}'
# Expected: 401

# Unauthed register (no X-Admin-Key) → must reject
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:8000/api/v1/register \
  -H "Content-Type: application/json" \
  -d '{"agentName":"hacker","runtime":"local"}'
# Expected: 403
```

- [ ] Unauthenticated `GET /agents` → 401 or 403
- [ ] Invalid JWT heartbeat → 401
- [ ] Unauthed register → 403

---

### 7. (Optional) Token Revocation via Key Rotation

```bash
# Re-register same agent — issues new key, revokes old one
NEW_REGISTER=$(curl -s -X POST http://localhost:8000/api/v1/register \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"agentName": "bedrock-assistant", "runtime": "bedrock"}')

NEW_KEY=$(echo "$NEW_REGISTER" | jq -r '.apiKey')

# Old key must now return 401
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:8000/api/v1/heartbeat \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"health":{"status":"ready"},"gap":{"score":90}}'
# Expected: 401

# New key must work
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:8000/api/v1/heartbeat \
  -H "Authorization: Bearer $NEW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"health":{"status":"ready"},"gap":{"score":90}}'
# Expected: 204
```

- [ ] Old token after rotation → 401
- [ ] New token → 204

---

### 8. (Optional) Verify AgentObservation CR in k8s

Requires a cluster with the AgentSpec operator running.

```bash
kubectl get agentobservations -n agentspec-remote

kubectl get agentobservation bedrock-assistant -n agentspec-remote \
  -o jsonpath='{.status}' | jq .
```

Then open k9s:
```
k9s
# type :ao  →  bedrock-assistant appears in agentspec-remote namespace
```

- [ ] CR `bedrock-assistant` exists in `agentspec-remote`
- [ ] `.status.phase` = `"Healthy"`
- [ ] `.status.grade` = `"B"`
- [ ] `.spec.source` = `"control-plane"`

---

### 9. Teardown

```bash
docker compose down -v   # removes containers + postgres_data volume
```

---

## Pass / Fail Criteria

| # | Check | Result |
|---|-------|--------|
| 1 | Control plane starts healthy | ⬜ |
| 2 | Registration returns `agentId` + JWT + non-null `expiresAt` | ⬜ |
| 3 | Heartbeat returns 204 | ⬜ |
| 4 | GET /agents shows Healthy phase, grade B, score 88 | ⬜ |
| 5 | GET /agents/{name}/health returns last health report | ⬜ |
| 6 | Unauthenticated requests rejected (401/403) | ⬜ |
| 7 | (Opt) Old token rejected after key rotation | ⬜ |
| 8 | (Opt) AgentObservation CR upserted in k8s | ⬜ |

**PASS**: Checks 1–6 all green.
**FAIL**: Any of 1–6 red → file an issue with the full `curl -v` output.

---

## Expected k9s `:ao` Output (with cluster)

```
NAME                PHASE    GRADE  SCORE  MODEL  VIOLATIONS  SOURCE         CHECKED
gymcoach            Healthy  A      94     pass   0           agent-sdk      12s
bedrock-assistant   Healthy  B      88     pass   0           control-plane  8s   ← phones home
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `docker compose ps` shows unhealthy | DB init failed | `docker compose logs control-plane` |
| Register returns 403 | Missing / wrong `X-Admin-Key` header | Check `$AGENTSPEC_ADMIN_KEY` value |
| Heartbeat returns 401 | JWT expired or key rotated | Re-register to get a fresh key |
| Heartbeat returns 429 | Rate limit (1 per 10s per agent) | Wait 10s before retrying |
| GET /agents returns 401 | Missing `X-Admin-Key` header | Add `-H "X-Admin-Key: $ADMIN_KEY"` |
| CR not upserted | No k8s cluster / no `agentspec-remote` namespace | Check operator logs (`agentspec-system`) |
| Phase stuck on Unknown | No heartbeat sent yet | Send step 3 first |

---

## Implementation Notes

**Phase 3 — Control plane** (`packages/control-plane/`) — ✅ DONE:
- `POST /api/v1/register` — requires `X-Admin-Key`; creates DB record; issues JWT (30-day exp)
- `POST /api/v1/heartbeat` — Bearer JWT; validates jti hash (revocation); rate-limited 1/10s; upserts CR
- `GET /api/v1/agents` — requires `X-Admin-Key`; for `RemoteAgentWatcher` to poll (Phase 6)
- `GET /api/v1/agents/{name}/health` — requires `X-Admin-Key`; returns last HealthReport JSON
- 85 tests passing (pytest); docker-compose with PostgreSQL for production

**Phase 4 — SDK push mode** (`packages/sdk/src/reporter/push.ts`) — ⬜ TODO:
```typescript
reporter.startPushMode({
  controlPlaneUrl: process.env.AGENTSPEC_URL,
  apiKey: process.env.AGENTSPEC_KEY,
  intervalSeconds: 30,
})
```
When Phase 4 ships, steps 3–5 above happen automatically from the agent process.
Python mirror planned in `packages/sdk-python/agentspec/reporter.py`.
