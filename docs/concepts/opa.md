# Behavioral Policy Enforcement with OPA

The AgentSpec SDK verifies *declarations* — it can confirm that an API key is set and a Redis instance is reachable. But it cannot verify that declared behavior actually occurs at runtime: guardrails firing, memory TTLs enforced, cost limits applied.

OPA (Open Policy Agent) closes that gap by enforcing behavioral policies derived from `agent.yaml` on every request.

## The Verification Ceiling

`agentspec health` and `agentspec audit` operate on the manifest alone. A well-declared, correctly wired agent earns grade A — but that grade reflects *declarations*, not *execution*.

| Manifest field | SDK today | OPA |
|---|---|---|
| `guardrails.input[pii-detector]` | Declared ✓ | Invoked on every request ✓ |
| `guardrails.output[toxicity-filter, threshold=0.7]` | Not checked | Score < threshold enforced ✓ |
| `model.costControls.maxMonthlyUSD` | Not checked | Denied above limit ✓ |
| `memory.shortTerm.ttlSeconds` | TCP reachable ✓ | TTL value verified on write ✓ |
| `tools[annotations.destructiveHint]` | Not checked | User confirmation required ✓ |

**Grade A from manifest alone = correctly declared, correctly wired.**
**Grade A with OPA = correctly declared, correctly wired, and verified on every request.**

## How It Works

### 1. Generate a Rego policy bundle from `agent.yaml`

```bash
agentspec generate-policy agent.yaml --out policies/
```

Produces:

```
policies/
├── policy.rego    # Rego rules derived from manifest declarations
└── data.json      # Thresholds and lists (toxicityThreshold, destructiveTools, etc.)
```

The CLI reads your manifest and generates one Rego rule per behavioral declaration. For example:

```yaml
# agent.yaml
spec:
  guardrails:
    input:
      - type: pii-detector
        action: scrub
  model:
    costControls:
      maxMonthlyUSD: 50
```

Produces:

```rego
# policy.rego
package agentspec.agent.my_agent

import rego.v1

deny contains "pii_detector_not_invoked" if {
    input.request_type == "llm_call"
    not "pii-detector" in input.guardrails_invoked
}

deny contains "monthly_cost_limit_exceeded" if {
    input.request_type == "llm_call"
    input.cost_today_usd >= data.maxMonthlyUSD / 30
}
```

### 2. Run OPA alongside your agent

Add OPA as a sidecar. It reads the generated policy bundle and listens on port 8181:

```yaml
# docker-compose.yml
services:
  my-agent:
    build: .

  opa:
    image: openpolicyagent/opa:0.70.0-static
    command: ["run", "--server", "--bundle", "/policies", "--addr", ":8181"]
    volumes:
      - ./policies:/policies:ro
    ports:
      - "8181:8181"

  agentspec-sidecar:
    image: ghcr.io/agentspec/sidecar:latest
    environment:
      OPA_URL: http://opa:8181
      # ...
```

### 3. Check OPA health

```bash
curl http://localhost:8181/health
# {"status":"ok"}

# Query the deny set directly
curl -X POST http://localhost:8181/v1/data/agentspec/agent/my_agent/deny \
  -H "Content-Type: application/json" \
  -d '{"input": {"request_type": "llm_call", "guardrails_invoked": [], "cost_today_usd": 0}}'
# {"result": ["pii_detector_not_invoked"]}
```

### 4. See OPA violations in `/gap`

When `OPA_URL` is set in the sidecar, the `/gap` endpoint includes OPA policy violations alongside the standard manifest gap analysis:

```bash
curl http://localhost:4001/agentspec/gap | jq '.issues[] | select(.source == "opa")'
```

```json
{
  "property": "guardrails.input.pii-detector",
  "severity": "high",
  "message": "pii_detector_not_invoked: pii-detector declared but not invoked on last LLM call",
  "source": "opa"
}
```

## Framework Sub-SDKs: the other half

OPA evaluates an input document on every request. That document needs to contain live runtime data — which guardrails were invoked, how many tokens were used, which tools were called. The sidecar builds a partial input from the manifest and probe data; for full behavioral coverage you also need a **framework sub-SDK** that intercepts the agent's execution path.

The `agentspec-langgraph` Python package provides this for LangGraph agents. It intercepts tool calls, LLM calls, and guardrail invocations and reports them as events that populate the OPA input document.

See [LangGraph Runtime Instrumentation](../adapters/langgraph.md#runtime-behavioral-instrumentation) for the full integration guide.

## Behavioral observation pipeline

OPA needs to know what the agent *actually did* — which guardrails fired, which tools were called. This data comes from the `agentspec-langgraph` sub-SDK via one of two reporting paths:

### HeaderReporting — Agent response headers

`AgentSpecMiddleware` (FastAPI/Starlette) sets internal headers on the agent's HTTP response after each request completes:

```
X-AgentSpec-Guardrails-Invoked: pii-detector,toxicity-filter
X-AgentSpec-Tools-Called: plan-workout
X-AgentSpec-User-Confirmed: true
```

The sidecar proxy reads these in its `onResponse` callback, then **strips them before forwarding to the client**. Clients never see these headers.

```python
from fastapi import FastAPI
from agentspec_langgraph import AgentSpecMiddleware

app = FastAPI()
app.add_middleware(AgentSpecMiddleware, guardrail_middleware=guardrail_mw)
```

### EventPush — Out-of-band event push

`SidecarClient` pushes a batch of behavioral events to `POST /agentspec/events` after each request. This is fire-and-forget and swallows all errors.

```python
from agentspec_langgraph import GuardrailMiddleware, SidecarClient

sidecar = SidecarClient(url="http://localhost:4001")
middleware = GuardrailMiddleware(agent_name="gymcoach")

async with middleware.new_request_context(
    request_id=request.headers.get("x-request-id"),
    sidecar_client=sidecar,
) as ctx:
    content = ctx.wrap("pii-detector", pii_fn)(user_input)
# → On exit: events pushed to POST /agentspec/events
```

EventPush always records behavioral data regardless of `OPA_PROXY_MODE`. HeaderReporting (response headers) triggers OPA evaluation in the proxy.

## Per-request proxy enforcement (HeaderReporting)

The sidecar proxy (port 4000) evaluates OPA on agent response headers when `OPA_URL` is set. The mode is controlled by the `OPA_PROXY_MODE` env var:

| Mode | Trigger | Behaviour |
|------|---------|-----------|
| `track` (default) | Agent response headers present | Record violations in the audit ring; add `X-AgentSpec-OPA-Violations` response header; forward the response to client. Safe for initial rollout — never blocks. |
| `enforce` | Agent response headers present | If OPA denies: sidecar replaces agent response with `403 PolicyViolation`. Agent always processes the request; only the client-visible response is blocked. |
| `off` | — | Skip proxy OPA checks entirely. `/gap` still calls OPA if `OPA_URL` is set. |

> **Note:** If the agent does not set `X-AgentSpec-*` response headers (e.g. not using sdk-langgraph), OPA is not called and the request passes through regardless of mode. Use EventPush (`SidecarClient`) for agents that cannot use middleware.

Configure globally (docker-compose or Helm):

```yaml
# docker-compose.yml
agentspec-sidecar:
  environment:
    OPA_URL: http://opa:8181
    OPA_PROXY_MODE: enforce
```

```yaml
# Helm values.yaml (operator injects OPA + sidecar automatically)
webhook:
  opa:
    enabled: true
    proxyMode: enforce
```

Override per-pod with annotation: `agentspec.io/opa-proxy-mode: enforce`.

### 403 PolicyViolation response

When `enforce` mode blocks a request based on agent response headers, the sidecar replaces the upstream response with a 403:

```
HTTP/1.1 403 Forbidden
X-AgentSpec-OPA-Violations: pii_detector_not_invoked
Content-Type: application/json
```

```json
{
  "error": "PolicyViolation",
  "blocked": true,
  "violations": ["pii_detector_not_invoked"],
  "message": "Request blocked by OPA policy: pii_detector_not_invoked"
}
```

### Enforcement model

| Path | Mechanism | Real-time blocking |
|------|-----------|-------------------|
| `off` | No OPA calls | — |
| `track` (HeaderReporting) | Record violations in audit ring + `X-AgentSpec-OPA-Violations` header | Never blocks |
| `enforce` (HeaderReporting) | OPA evaluates agent response headers; if deny → 403 to client | ✅ Yes (client-side) |
| EventPush | OPA evaluates pushed events retroactively; updates audit ring | ❌ No (observation) |
| Agent-side | `GuardrailMiddleware.enforce_opa()` raises `PolicyViolationError` | ✅ Yes (in-process) |

## Framework sub-SDKs: the other half

OPA evaluates an input document on every request. That document needs live runtime data — which guardrails were invoked, how many tokens were used, which tools were called. The sidecar builds a partial input from the manifest and probe data; for full behavioral coverage you also need a **framework sub-SDK** that intercepts the agent's execution path.

The `agentspec-langgraph` Python package provides this for LangGraph agents. It intercepts tool calls, LLM calls, and guardrail invocations and reports them via HeaderReporting (response headers) or EventPush (out-of-band event push).

See [LangGraph Runtime Instrumentation](../adapters/langgraph.md#runtime-behavioral-instrumentation) for the full integration guide.

## Fail-open behaviour

- `OPA_URL` not set → no OPA calls; sidecar behaves as before
- OPA unreachable → proxy **fails open** (forwards the request) with a warning log; `/gap` omits OPA violations
- OPA reachable, no `deny` entries → request forwarded normally

## See also

- [Generate OPA policies — step-by-step guide](../guides/opa-policy.md)
- [Operator Helm Values Reference](../reference/operator-helm-values.md)
- [LangGraph Runtime Instrumentation](../adapters/langgraph.md#runtime-behavioral-instrumentation)
- [CLI: agentspec generate-policy](../reference/cli.md)
- [Sidecar Runbook: OPA section](../RUNBOOK.md)
