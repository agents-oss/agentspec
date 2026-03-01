# Runtime Introspection

AgentSpec's health check CLI (`agentspec health`) runs pre-flight checks before you start your agent. **Runtime introspection** is the complementary half: your running agent continuously self-reports its live health state, and the AgentSpec sidecar reads it.

## How It Works

```
┌─────────────────────────────────────┐
│           Your Agent Process        │
│                                     │
│  AgentSpecReporter                  │
│    └─ runs checks every 30s         │
│    └─ caches HealthReport           │
│    └─ GET /agentspec/health ────────┼──► sidecar probeAgent()
└─────────────────────────────────────┘         │
                                                 ▼
                                    ┌────────────────────────┐
                                    │   Sidecar Control Plane │
                                    │   GET /health/ready     │
                                    │   GET /explore          │
                                    │   GET /gap              │
                                    └────────────────────────┘
```

The **SDK** (`@agentspec/sdk`) exports `AgentSpecReporter` — a class you mount in your agent server. It runs the same health checks as the CLI but from inside the process, where full connectivity is available (real DB connections, real API reachability).

The **sidecar** (`agentspec-sidecar`) probes `GET /agentspec/health` on every request to its diagnostic endpoints. All three endpoints reflect live agent state when the SDK is integrated, and fall back to static manifest analysis when it isn't.

## The /agentspec/health Endpoint

When `AgentSpecReporter` is mounted, your agent exposes:

```
GET /agentspec/health
```

Response (`HealthReport`):

```json
{
  "agentName": "gymcoach",
  "timestamp": "2026-02-28T10:00:00.000Z",
  "status": "healthy",
  "summary": { "passed": 5, "failed": 0, "warnings": 0, "skipped": 0 },
  "checks": [
    { "id": "env:GROQ_API_KEY",   "category": "env",     "status": "pass", "severity": "error" },
    { "id": "model:groq/llama-3.3-70b-versatile", "category": "model", "status": "pass",
      "severity": "error", "latencyMs": 91 },
    { "id": "service:redis",      "category": "service", "status": "pass", "severity": "info",
      "latencyMs": 2 },
    { "id": "service:postgres",   "category": "service", "status": "pass", "severity": "info",
      "latencyMs": 3 },
    { "id": "tool:log-workout",   "category": "tool",    "status": "pass", "severity": "info" }
  ]
}
```

**Status values:**

| Status | Meaning |
|--------|---------|
| `pass` | Check succeeded |
| `fail` | Check failed — see `message` and `remediation` |
| `skip` | Check could not run (e.g. `$env:VAR` unset; the `env` check covers it separately) |

## Two Modes: `manifest-static` and `agent-sdk`

The sidecar operates in one of two modes on every request. The `source` field in every response tells you which is active:

```json
{ "source": "manifest-static" }  // agent has no /agentspec/health endpoint
{ "source": "agent-sdk" }        // live probe succeeded
```

### `manifest-static` — zero agent changes required

The sidecar reads `agent.yaml` and infers everything from the declaration alone. No data comes from the running agent process. This works for **any** agent with no code changes.

**What it can detect:**

| Check | How |
|-------|-----|
| `$env:VAR` references | Checks the **sidecar container's** environment, not the agent's |
| `$secret:*` references | Whether a secret backend is configured |
| `requires.services` TCP connectivity | Raw TCP connect to the declared address |
| MCP server TCP reachability | TCP connect to the MCP server host/port |
| Memory backend TCP connectivity | TCP connect to Redis/Postgres address |

**What it cannot detect:**

| Blind spot | Why |
|-----------|-----|
| Tool handler registration | The sidecar has no visibility into the agent process |
| Model API key correctness | A wrong literal key (e.g. `apiKey: sk-invalid`) scores the same as a valid one |
| Real service health | TCP connect succeeds even when Redis has no memory left or Postgres rejects auth |
| Agent-side env vars | If your agent container has `OPENAI_API_KEY` set but the sidecar container does not, the env check still **fails** |
| Runtime token/memory usage | No behavioral data is available |

**Grade ceiling in `manifest-static` mode:**

The `/gap` score always deducts 20 points (`healthcheckable`) because the sidecar probes `GET /health` on the agent's upstream URL and it returns no response, and 10 points (`discoverable`) because `/capabilities` also returns nothing. These two violations alone cap the maximum achievable score at **70 / grade C** for any agent that does not expose those endpoints.

```
Score ceiling (manifest-static):
  100
  − 20  healthcheckable  (agent has no GET /health)
  − 10  discoverable     (agent has no GET /capabilities)
  ────
   70   → grade C at best
```

Grade A requires `agent-sdk` mode, or an agent that genuinely exposes `/health` and `/capabilities` endpoints on its upstream port.

---

### `agent-sdk` — live data from the running process

When `AgentSpecReporter` is mounted and `GET /agentspec/health` returns a valid `HealthReport`, the sidecar uses that data instead of its own static analysis. All three diagnostic endpoints switch to live mode.

**What it additionally detects:**

| Check | How |
|-------|-----|
| Tool handler registration | `tool:<name>` checks from the agent's own registry |
| Model API key validity | Live HTTP call to the provider API from inside the agent process |
| Service health at protocol level | Driver-level ping (Redis `PING`, Postgres `SELECT 1`) with real latency |
| Agent-side env resolution | Env vars read from `process.env` inside the agent container |
| Missing checks (spec vs reporter mismatch) | Gap engine cross-references spec declarations against reported check IDs |

**Grade F is only reachable in `agent-sdk` mode** — enough failing `high`/`critical` checks from the live report can push the score below 45.

### Endpoint behaviour by mode

| Endpoint | `manifest-static` | `agent-sdk` |
|----------|-------------------|-------------|
| `GET /health/ready` | Env + service TCP checks from sidecar env | Full `HealthReport` from agent process |
| `GET /explore` | Manifest field values only; tool/service status `unknown` | Enriched with live check results and latency |
| `GET /gap` | Static violations (healthcheckable, discoverable, auditable, evaluated) | All static violations + live env/model/service/tool failures cross-referenced against spec |

## When to integrate the SDK

| Situation | Recommendation |
|-----------|---------------|
| Agent has no HTTP server (e.g. a script or batch job) | Stay with `manifest-static` — no integration possible |
| Agent already runs a web server (FastAPI, Express, Fastify…) | Integrate — one route, ~5 lines |
| You need to verify your model API key is actually working | Integrate — `manifest-static` cannot detect a wrong key |
| You need tool registration status in the gap report | Integrate — invisible in `manifest-static` |
| You want grade A compliance scores | Integrate — grade C is the ceiling without it |
| You have strict env var separation between containers | Integrate — sidecar checks its own env, not the agent's |

## /gap Live Analysis

With the SDK integrated, `GET /gap` uses the live `HealthReport` to detect real problems — not hypothetical ones from the manifest alone:

```json
{
  "score": 75,
  "source": "agent-sdk",
  "issues": [
    {
      "severity": "high",
      "property": "model.apiKey",
      "description": "Cannot check model endpoint: API key reference not resolved ($env:GROQ_API_KEY)",
      "recommendation": "Ensure the model API key environment variable is set..."
    },
    {
      "severity": "medium",
      "property": "auditable",
      "description": "No guardrails declared in spec",
      "recommendation": "Add spec.guardrails with input/output rules..."
    }
  ]
}
```

**Model check severity mapping:**

| Model check result | Gap issue severity | Meaning |
|--------------------|--------------------|---------|
| `fail` | `critical` | API key set but endpoint unreachable |
| `skip` | `high` | API key env var not set at all |
| `pass` | *(no issue)* | Endpoint reachable |

## Check Categories (Runtime)

These categories only appear in runtime `HealthReport`s (not in CLI pre-flight output):

| Category | Source | What it checks |
|----------|--------|----------------|
| `tool` | `AgentSpecReporter` | Tool handler is registered in the agent process |
| `service` | `AgentSpecReporter` | TCP connectivity for `spec.requires.services` entries |
| `model` | `AgentSpecReporter` | Provider API endpoint reachable (resolves `$env:` at runtime) |

## Caching and Refresh

`AgentSpecReporter` caches the last `HealthReport` to avoid hammering external APIs on every request to `/agentspec/health`.

| Option | Default | Description |
|--------|---------|-------------|
| `refreshIntervalMs` | 30 000 | Background refresh interval |
| `staleAfterMs` | 60 000 | Max age before synchronous re-check on next `getReport()` call |

After `stop()` is called (e.g. during graceful shutdown), `getReport()` returns the last cached report without running new checks.

## Next Step

→ [Add Runtime Health to your agent](/guides/add-runtime-health)
