# Phase 3 — Control Plane Service

**Status: ✅ DONE**
**Depends on:** Phase 1 (operator + AgentObservation CRD)

---

## Goal

A lightweight HTTP service that acts as the convergence point for remote agents (Bedrock,
Vertex, Docker, local) that cannot host a sidecar. Agents register once, then push periodic
`HealthReport` + `GapReport` via heartbeat. The control plane upserts `AgentObservation` CRs
so remote agents appear in k9s `:ao` alongside in-cluster ones.

This is the **infrastructure prerequisite** for Phase 4 (SDK push mode) and Phase 6
(RemoteAgentWatcher). It can be deployed standalone or alongside the operator.

---

## Why This Phase

The sidecar model only works in k8s where we control the pod spec. Every other runtime
(Bedrock, Vertex, Modal, Fly.io) needs the agent to push data to us. This phase builds
the receiver. Without it, phases 4 and 6 have nothing to push to / read from.

---

## Deliverables

| Deliverable | File(s) | Status |
|-------------|---------|--------|
| FastAPI control plane service | `packages/control-plane/` (new) | ✅ |
| Agent registration endpoint | `POST /api/v1/register` | ✅ |
| Heartbeat endpoint | `POST /api/v1/heartbeat` | ✅ |
| Agent list endpoint | `GET /api/v1/agents` | ✅ |
| Per-agent health report endpoint | `GET /api/v1/agents/{name}/health` | ✅ |
| SQLite/PostgreSQL data model | `db/models.py` | ✅ |
| JWT API key issuance | `auth/keys.py` | ✅ |
| k8s CR upsert via `kubernetes-asyncio` | `k8s/upsert.py` | ✅ |
| Helm chart (or docker-compose) | `packages/control-plane/docker-compose.yml` | ✅ |
| Unit + integration tests | `tests/` | ✅ 85 tests |
| UAT guide update (wow-2) | `packages/operator/uat/wow-2-phone-home.md` | ✅ |

---

## Files to Create

```
packages/control-plane/
├── main.py               # FastAPI app + lifespan (DB init, k8s client)
├── api/
│   ├── register.py       # POST /api/v1/register
│   ├── heartbeat.py      # POST /api/v1/heartbeat
│   └── agents.py         # GET /api/v1/agents, GET /api/v1/agents/{name}/health
├── auth/
│   └── keys.py           # JWT issuance + verification (python-jose)
├── db/
│   ├── base.py           # SQLAlchemy async engine (SQLite dev / PostgreSQL prod)
│   └── models.py         # Agent, Heartbeat tables
├── k8s/
│   └── upsert.py         # Upsert AgentObservation CR in agentspec-remote namespace
├── schemas.py            # Pydantic request/response models
├── Dockerfile
├── requirements.txt
├── requirements-dev.txt
├── pytest.ini
└── tests/
    ├── conftest.py
    ├── test_register.py
    ├── test_heartbeat.py
    ├── test_agents.py
    └── test_k8s_upsert.py
```

---

## API Contract

### `POST /api/v1/register`

Register a new agent. Returns a JWT API key scoped to this agent.

**Request:**
```json
{
  "agentName": "bedrock-assistant",
  "runtime": "bedrock",             // bedrock | vertex | docker | local | k8s
  "manifest": { ... }               // agent.yaml contents (optional)
}
```

**Response:**
```json
{
  "agentId": "agt_abc123",
  "apiKey": "eyJhbGc...",           // JWT, scoped to this agentId
  "expiresAt": null                 // null = no expiry (revocable via DELETE)
}
```

---

### `POST /api/v1/heartbeat`

Push health + gap data. Auth: `Authorization: Bearer <apiKey>`.

**Request:**
```json
{
  "health": { /* HealthReport — same shape as sidecar /health/ready */ },
  "gap":    { /* GapReport   — same shape as sidecar /gap */ }
}
```

**Response:** `204 No Content`

**Side effects:**
1. Stores heartbeat in DB (timestamp, health, gap payloads)
2. Upserts `AgentObservation` CR in `agentspec-remote` namespace with `.status` from heartbeat
3. Updates `Agent.lastSeen` + `Agent.phase`

---

### `GET /api/v1/agents`

List all known agents (in-cluster + remote). Used by `RemoteAgentWatcher` (Phase 6).

**Response:**
```json
[
  {
    "agentId": "agt_abc123",
    "agentName": "bedrock-assistant",
    "runtime": "bedrock",
    "phase": "Healthy",
    "grade": "B",
    "score": 82,
    "lastSeen": "2026-03-01T12:00:00Z"
  }
]
```

---

### `GET /api/v1/agents/{name}/health`

Return the last known `HealthReport` for a remote agent. Used by k9s drill-down plugin.

**Response:** Full `HealthReport` JSON (same shape as sidecar `/health/ready`)

---

## Data Model

```python
class Agent(Base):
    __tablename__ = "agents"
    id: str           # agt_{uuid4}
    name: str         # unique per team
    runtime: str      # bedrock | vertex | docker | local
    manifest: dict    # agent.yaml (jsonb)
    api_key_hash: str # SHA-256 of JWT jti (for revocation)
    created_at: datetime
    last_seen: datetime
    phase: str        # Healthy | Degraded | Unhealthy | Unknown
    grade: str
    score: int

class Heartbeat(Base):
    __tablename__ = "heartbeats"
    id: int           # auto-increment
    agent_id: str     # FK → Agent.id
    received_at: datetime
    health: dict      # HealthReport payload (jsonb)
    gap: dict         # GapReport payload (jsonb)
    # Keep last 100 per agent; older rows pruned on insert
```

---

## Architecture

```
Remote agent (Bedrock/Vertex/Docker)
  POST /api/v1/heartbeat  { health, gap }
       ↓  (JWT auth)
control-plane/api/heartbeat.py
       ↓  write to DB
       ↓  k8s/upsert.py → upsert AgentObservation CR in agentspec-remote namespace
       ↓
Kopf operator sees updated CR (agentspec-remote namespace)
  → No probe (spec.source = "control-plane", daemon skips probe)
  → .status already set by upsert
       ↓
k9s :ao  →  remote agent appears with live phase + grade
```

---

## k8s CR Upsert Strategy

`k8s/upsert.py` uses `kubernetes-asyncio` custom objects API:

```python
await custom_objects.patch_namespaced_custom_object_status(
    group="agentspec.io",
    version="v1",
    namespace="agentspec-remote",
    plural="agentobservations",
    name=agent_name,
    body={"status": build_status_patch(probe_result)},
)
```

If CR doesn't exist: `create_namespaced_custom_object()` first with `spec.source = "control-plane"`.

The operator daemon checks `spec.source`:
- `"sidecar"` (default) → probe the sidecar HTTP endpoint
- `"control-plane"` → skip probe, trust `.status` set by upsert

---

## Acceptance Criteria

- [x] `POST /api/v1/register` returns a valid JWT
- [x] `POST /api/v1/heartbeat` with valid JWT → 204, CR upserted in `agentspec-remote`
- [x] `POST /api/v1/heartbeat` with invalid JWT → 401
- [x] `GET /api/v1/agents` returns all registered agents
- [x] `GET /api/v1/agents/{name}/health` returns last health report
- [x] CR upsert is idempotent (PUT semantics, no duplicate CRs)
- [x] SQLite for dev, PostgreSQL connection string for prod (env: `DATABASE_URL`)
- [x] All tests pass: `pytest tests/ -v`
- [x] k8s upsert mocked in unit tests (no real cluster needed)

---

## Security Considerations

- JWT signed with HS256, secret from `JWT_SECRET` env var (fail-closed if unset)
- `jti` (JWT ID) stored hashed in DB — revoke by deleting Agent row
- Rate-limit heartbeat: max 1 per agent per 10 seconds (to prevent DB flooding)
- `agentspec-remote` namespace: read-only for external clients, write-only for control plane
- Heartbeat payload size limit: 64 KB (reject oversized payloads)

---

## Test Plan

### Unit tests (no I/O)
- JWT issuance and verification
- Heartbeat payload validation (schema, size limit)
- `build_status_patch()` round-trip from heartbeat payload

### Integration tests (SQLite in-memory, mocked k8s)
- Register → heartbeat → GET agents full flow
- Duplicate registration idempotency
- Expired/invalid JWT rejection
- k8s upsert called with correct CR shape
- Heartbeat pruning (>100 rows per agent)
