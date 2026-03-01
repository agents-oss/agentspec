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

## Fail-open by default

OPA is **additive and fail-open**:

- If `OPA_URL` is not set → sidecar behaves as before, no OPA calls
- If OPA is unreachable → `/gap` returns the same results as without OPA; OPA violations are omitted
- OPA violations appear in the `/gap` issues list but do not block agent traffic on their own

To enforce OPA at the request level (block LLM calls that violate policy), use `GuardrailMiddleware.enforce_opa()` with `fail_closed=True` in your agent code. This gives you **admission control** — requests are denied before reaching the LLM.

## See also

- [Generate OPA policies — step-by-step guide](../guides/opa-policy.md)
- [LangGraph Runtime Instrumentation](../adapters/langgraph.md#runtime-behavioral-instrumentation)
- [CLI: agentspec generate-policy](../reference/cli.md)
- [Sidecar Runbook: OPA section](../RUNBOOK.md)
