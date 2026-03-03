# E2E Testing the Demo Cluster

Run a full behavioral validation of the demo cluster — proxy injection, guardrail headers,
OPA decisions, audit ring entries, and gap scores — with a single command.

## Overview

The e2e suite lives in `packages/operator/uat/e2e/` and uses **pytest + httpx**.
Tests are written in two styles:

| Style | When to use |
|-------|-------------|
| **YAML scenarios** | HTTP request/response assertions — add a new `.yaml` file, no Python needed |
| **Python test modules** | Multi-step flows that need kubectl, dynamic assertions, or conditional logic |

The YAML scenario runner is a thin pytest parametrize wrapper — dropping a new `.yaml` file
in `scenarios/` is all it takes to add a new test.

## Prerequisites

- [ ] `kind`, `kubectl`, `helm`, `docker` installed and on `$PATH`
- [ ] Demo cluster running: `make demo-cluster demo-operator demo-deploy`
- [ ] Python 3.11+ with pip

## Run the suite

```bash
# Bring up the demo cluster (idempotent — no-op if already running)
make demo-provision

# Run all e2e tests
make demo-e2e

# Or run directly with pytest
cd packages/operator/uat/e2e
pip install -e .
pytest -v
```

The cluster is **not torn down** after the suite — it stays up for faster iteration.
Run `make demo-down` manually when you're done.

## Run a single scenario or module

```bash
cd packages/operator/uat/e2e

# Run one YAML scenario by stem name
pytest test_scenarios.py -v -k "01-proxy-passthrough"

# Run all scenarios
pytest test_scenarios.py -v

# Run gap-score assertions only
pytest test_gap_scores.py -v

# Run OPA enforce-mode test only
pytest test_opa_enforce.py -v
```

## Directory layout

```
packages/operator/uat/e2e/
├── conftest.py              # cluster fixture, port-forward fixture, YAML loader
├── test_scenarios.py        # parametrized YAML runner
├── test_gap_scores.py       # /gap grade assertions for all 5 agents
├── test_opa_enforce.py      # enforce-mode 403 test (kubectl patch)
├── scenarios/
│   ├── 01-proxy-passthrough.yaml   # basic proxy passthrough, health check
│   ├── 02-audit-ring.yaml          # audit ring populated after /chat
│   ├── 03-header-reporting.yaml    # AgentSpecMiddleware sets X-AgentSpec-* headers
│   ├── 04-event-push.yaml          # SidecarClient pushes to /agentspec/events
│   └── 05-opa-track.yaml           # OPA track mode records decisions, never blocks
└── pyproject.toml           # pytest, httpx, pyyaml, pytest-asyncio
```

## Demo cluster agents

| Agent | Namespace | Grade | Score | Proxy port | Control port |
|-------|-----------|-------|-------|-----------|--------------|
| `gymcoach` | demo | A | 100 | 4000 | 4001 |
| `trading-bot` | demo | D | 55 | 4002 | 4003 |
| `voice-assistant` | demo | C | 60 | 4004 | 4005 |
| `fitness-tracker` | demo | A | 100 | 4006 | 4007 |
| `research-agent` | demo | F | 20 | 4008 | 4009 |

Grade is derived from score: A≥90, B≥75, C≥60, D≥45, F<45.

`fitness-tracker` is the primary agent for OPA and behavioral observation tests — it has
a loaded OPA policy and uses the `agentspec-langgraph` sub-SDK (both HeaderReporting and
EventPush paths).

---

## YAML scenario schema

Each file in `scenarios/` follows this schema.  All fields except `name`, `agent`,
`proxy_port`, `control_port`, and `steps` are optional.

```yaml
name: "Human-readable test name"   # shown in pytest output
agent: gymcoach                     # deployment name in the 'demo' namespace
proxy_port: 4000                    # local port for kubectl port-forward to :4000
control_port: 4001                  # local port for kubectl port-forward to :4001

steps:
  - name: "Step description"        # shown in assertion error messages
    endpoint: proxy                 # "proxy" (port 4000) or "control" (port 4001)
    method: POST                    # HTTP method (default: GET)
    path: /chat                     # path appended to the base URL
    body:                           # optional JSON body (sent as application/json)
      message: "hello"
    expect:
      status: 200                   # assert HTTP status code
      headers_absent:               # headers that must NOT be present
        - x-agentspec-tools-called
      headers_present:              # headers that must be present
        - x-agentspec-guardrails-invoked
      jq: ".[0].requestId"          # dot/bracket path into the JSON response body
      not_null: true                # assert the jq result is not null/None
      equals: "POST"                # assert the jq result equals this value
      contains: "pii"               # assert the jq result string contains this
      body_contains: "PolicyViol"   # raw string that must appear in the response body
```

### Control plane route paths

The sidecar control plane (port 4001) exposes these routes — note there is **no `/agentspec/` prefix**:

| Route | Method | Description |
|-------|--------|-------------|
| `/health/live` | GET | Liveness probe (`{"status":"live"}`) |
| `/health/ready` | GET | Readiness + manifest health checks |
| `/gap` | GET | Compliance gap score + issues |
| `/audit` | GET | Audit ring (all proxied requests) |
| `/explore` | GET | Runtime capabilities (agent + model + tools) |
| `/capabilities` | GET | A2A AgentCard |
| `/events` | POST | EventPush — receive behavioral events |

### `endpoint` values

| Value | Resolves to |
|-------|-------------|
| `proxy` (default) | `http://localhost:<proxy_port>` — the sidecar proxy |
| `control` | `http://localhost:<control_port>` — the sidecar control plane |

### `jq` path syntax

The runner uses a Python implementation of jq-style paths — no `jq` binary required.

| Example path | Meaning |
|---|---|
| `.status` | top-level key `status` |
| `.[0].requestId` | first array element, key `requestId` |
| `.issues[0].rule` | key `issues`, first element, key `rule` |
| `.checks` | top-level key `checks` |

Paths are evaluated against the parsed JSON body (`r.json()`).  If the path resolves to
`None` (key missing or array out of bounds) and `not_null: true` is set, the step fails.

### Step assertion order

Each step assertion runs in this order:
1. `status` — HTTP status code
2. `headers_absent` — all listed headers must be absent
3. `headers_present` — all listed headers must be present
4. `jq` + `not_null` / `equals` / `contains` — JSON body path checks
5. `body_contains` — raw string match on response text

---

## Adding a new YAML scenario

1. Create `packages/operator/uat/e2e/scenarios/<NN>-my-test.yaml`
2. Set `name`, `agent`, `proxy_port`, `control_port`, and `steps`
3. Run `pytest test_scenarios.py -v -k "NN-my-test"` to verify

No Python changes needed.  The loader picks up all `*.yaml` files automatically.

### Example: assert /explore returns tool names

```yaml
name: "Explore endpoint lists declared tools — gymcoach"
agent: gymcoach
proxy_port: 4000
control_port: 4001

steps:
  - name: "GET /agentspec/explore returns 200"
    endpoint: control
    method: GET
    path: /agentspec/explore
    expect:
      status: 200
      jq: ".tools"
      not_null: true

  - name: "Tools list is non-empty"
    endpoint: control
    method: GET
    path: /agentspec/explore
    expect:
      status: 200
      jq: ".tools[0].name"
      not_null: true
```

---

## Python test modules

For tests that need kubectl, multi-step state, or conditional logic, write a standard
pytest module alongside the YAML scenarios.

### `test_gap_scores.py` — gap grade assertions

Asserts `/gap` returns the expected score (and computed grade) for each of the 5 demo
agents.  The `/gap` response has a `score` field (0–100) — grade is computed locally
via `_score_to_grade()` (A≥90, B≥75, C≥60, D≥45, F<45).
For grade D and F agents it also asserts `issues` is non-empty, and that each issue
has the required fields (`property`, `severity`, `description`).

```bash
pytest test_gap_scores.py -v
# test_gap_grade[gymcoach] PASSED
# test_gap_grade[trading-bot] PASSED
# test_gap_grade[voice-assistant] PASSED
# test_gap_grade[fitness-tracker] PASSED
# test_gap_grade[research-agent] PASSED
# test_gap_response_shape PASSED
# test_gap_issues_have_required_fields PASSED
```

### `test_opa_enforce.py` — enforce-mode 403

Patches `fitness-tracker-sidecar` to `OPA_PROXY_MODE=enforce` via `kubectl set env`,
waits for rollout, asserts a guardrail-header-free `/chat` returns `403 PolicyViolation`,
then restores `OPA_PROXY_MODE=track`.

```bash
pytest test_opa_enforce.py -v
# test_opa_enforce_blocks_request_without_guardrail_headers PASSED
# test_opa_enforce_allows_request_with_guardrail_headers PASSED
# test_opa_track_mode_passes_all_requests PASSED
```

> **Note:** `test_opa_enforce.py` takes ~90 s because it waits for two Kubernetes rollouts.
> Run it separately when iterating on OPA policy changes.

---

## Fixtures reference (`conftest.py`)

### `demo_cluster` (session-scoped, autouse)

Runs `make demo-cluster demo-operator demo-deploy` from the repo root once per session.
The make targets are idempotent — already-running clusters are a no-op.
The cluster is **not** torn down on suite completion.

### `port_forward` (function-scoped)

Starts `kubectl port-forward` for one agent and yields `(proxy_url, control_url)`.
Forwards are terminated after each test function.

```python
def test_something(port_forward):
    proxy_url, control_url = port_forward("gymcoach", 4000, 4001)
    r = httpx.get(f"{control_url}/agentspec/health")
    assert r.status_code == 200
```

The fixture waits up to 30 s for the control-plane endpoint to respond before
returning (polls `GET /agentspec/health` every second).

---

## Behavioral observation scenarios

### HeaderReporting (`03-header-reporting.yaml`)

Tests the `AgentSpecMiddleware` path: the agent sets `X-AgentSpec-*` response headers,
the sidecar reads and strips them, and the audit ring records the behavioral data.

```
client → sidecar proxy (4000) → agent → agent response with X-AgentSpec-* headers
                                      ↓
                              sidecar strips headers
                              sidecar writes audit ring entry
                              sidecar calls OPA (if OPA_URL set)
                                      ↓
                              client receives clean response (no X-AgentSpec-* headers)
```

### EventPush (`04-event-push.yaml`)

Tests the `SidecarClient` path: the agent pushes events out-of-band to the sidecar
control plane after each request.

```
client → sidecar proxy (4000) → agent
                                 ↓ (after request completes)
                      agent POST /agentspec/events (port 4001)
                                 ↓
                      sidecar updates audit ring with behavioral data
                      sidecar calls OPA retroactively
```

EventPush always records regardless of `OPA_PROXY_MODE`.

---

## See also

- [OPA Policy Guide](./opa-policy.md) — generate and deploy OPA policies from `agent.yaml`
- [OPA Concepts](../concepts/opa.md) — HeaderReporting vs EventPush, enforcement modes
- [RUNBOOK.md](../../RUNBOOK.md) — operator runbook, port reference, env vars
