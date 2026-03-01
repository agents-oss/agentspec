# Generate and Enforce OPA Policies from agent.yaml

Generate a Rego policy bundle from your `agent.yaml`, run OPA as a sidecar, and see behavioral violations in `/gap`.

## Prerequisites

- [ ] `agent.yaml` with guardrails, cost controls, or memory TTLs declared
- [ ] `agentspec` CLI installed (`npm install -g @agentspec/cli`)
- [ ] OPA CLI or Docker image (`openpolicyagent/opa:0.70.0-static`)
- [ ] `agentspec-sidecar` running alongside your agent

## Step 1 — Generate the policy bundle

```bash
agentspec generate-policy agent.yaml --out policies/
```

This reads your manifest and emits:

```
policies/
├── policy.rego    # Rego rules (one rule per behavioral declaration)
└── data.json      # Thresholds and reference data
```

You can also output the bundle as JSON for inspection:

```bash
agentspec generate-policy agent.yaml --json
```

### What gets generated

| `agent.yaml` declaration | Generated Rego rule |
|---|---|
| `guardrails.input[type=pii-detector]` | `deny["pii_detector_not_invoked"]` if not in `guardrails_invoked` |
| `guardrails.output[type=toxicity-filter, threshold=0.7]` | `deny["toxicity_threshold_exceeded"]` if `toxicity_score >= 0.7` |
| `model.costControls.maxMonthlyUSD: 50` | `deny["monthly_cost_limit_exceeded"]` if cost exceeds daily limit |
| `model.costControls.maxTokensPerDay: 100000` | `deny["daily_token_limit_exceeded"]` if `tokens_today >= 100000` |
| `memory.shortTerm.ttlSeconds: 3600` | `deny["memory_ttl_mismatch"]` if write TTL != 3600 |
| `tools[annotations.destructiveHint=true]` | `deny["destructive_tool_without_confirmation"]` if no user_confirmed |

Rules not triggered by your manifest are omitted — the generated bundle is minimal.

### Agent name sanitization

OPA Rego package names cannot contain hyphens. The CLI automatically converts:

```
agent name: fitness-tracker  →  package: agentspec.agent.fitness_tracker
```

The OPA query URL in the sidecar applies the same conversion.

## Step 2 — Run OPA

### Docker Compose

```yaml
services:
  my-agent:
    build: .
    ports:
      - "8000:8000"

  opa:
    image: openpolicyagent/opa:0.70.0-static
    command:
      - run
      - --server
      - --bundle
      - /policies
      - --addr
      - :8181
    volumes:
      - ./policies:/policies:ro
    ports:
      - "8181:8181"

  agentspec-sidecar:
    image: ghcr.io/agentspec/sidecar:latest
    environment:
      UPSTREAM_URL: http://my-agent:8000
      MANIFEST_PATH: /manifest/agent.yaml
      OPA_URL: http://opa:8181
    volumes:
      - ./agent.yaml:/manifest/agent.yaml:ro
```

### Kubernetes

Add a ConfigMap with the policy bundle and an OPA sidecar container:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-agent-opa-policy
data:
  policy.rego: |
    # paste output of: agentspec generate-policy agent.yaml --out /dev/stdout
  data.json: |
    { "toxicityThreshold": 0.7, "destructiveTools": [] }
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: my-agent
          # ...
        - name: opa
          image: openpolicyagent/opa:0.70.0-static
          args: ["run", "--server", "--bundle", "/policies", "--addr", ":8181"]
          ports:
            - containerPort: 8181
          volumeMounts:
            - name: opa-policy
              mountPath: /policies
        - name: agentspec-sidecar
          image: ghcr.io/agentspec/sidecar:latest
          env:
            - name: OPA_URL
              value: http://localhost:8181
          # ...
      volumes:
        - name: opa-policy
          configMap:
            name: my-agent-opa-policy
```

## Step 3 — Verify OPA is running

```bash
# Health check
curl http://localhost:8181/health
# {"status":"ok"}

# Manual policy query (empty guardrails_invoked — should trigger a deny)
curl -s -X POST http://localhost:8181/v1/data/agentspec/agent/my_agent/deny \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "request_type": "llm_call",
      "guardrails_invoked": [],
      "cost_today_usd": 0,
      "tokens_today": 0
    }
  }' | jq .
# {"result": ["pii_detector_not_invoked"]}
```

## Step 4 — See OPA violations in /gap

The sidecar's `/gap` endpoint automatically calls OPA when `OPA_URL` is set:

```bash
curl http://localhost:4001/agentspec/gap | jq .
```

```json
{
  "source": "manifest-static",
  "issues": [
    {
      "property": "guardrails.input.pii-detector",
      "severity": "high",
      "message": "pii_detector_not_invoked: pii-detector declared but not invoked on last LLM call",
      "source": "opa"
    }
  ]
}
```

OPA violations are additive — they appear alongside standard manifest gap issues and do not replace them. If OPA is unreachable, the `/gap` response is identical to the version without OPA.

## Step 5 — Enforce at request time (optional)

For admission control — blocking LLM calls that violate policy before they reach the model — use `GuardrailMiddleware` from the `agentspec-langgraph` Python package:

```python
from agentspec_langgraph import GuardrailMiddleware, PolicyViolationError

middleware = GuardrailMiddleware(
    opa_url="http://localhost:8181",
    agent_name="my-agent",
    fail_closed=True,  # raise PolicyViolationError instead of fail-open
)

# Wrap each declared guardrail
check_pii = middleware.wrap("pii-detector", your_pii_scrubber)

async def call_model(state):
    # Run guardrails — events are recorded
    user_input = check_pii(state["messages"][-1].content)

    # Enforce OPA before LLM call — raises PolicyViolationError if denied
    try:
        middleware.enforce_opa(
            model_id="groq/llama-3.3-70b-versatile",
            guardrails_declared=["pii-detector"],  # from agent.yaml
        )
    except PolicyViolationError as e:
        return {"messages": [{"role": "assistant", "content": f"Request blocked: {e}"}]}

    # ... call LLM
```

See [LangGraph Runtime Instrumentation](../adapters/langgraph.md#runtime-behavioral-instrumentation) for the full sub-SDK reference.

## Demo cluster

The demo cluster (`make demo`) ships with OPA already wired for two agents:

| Agent | OPA policy | Guardrail rule |
|---|---|---|
| `gymcoach` | `agentspec.agent.gymcoach` | pii-detector required, toxicity threshold 0.7 |
| `fitness-tracker` | `agentspec.agent.fitness_tracker` | pii-detector + memory TTL 3600s |

```bash
# After: make demo
make demo-opa   # verify OPA health + run a sample policy query for each agent
```

## See also

- [Behavioral policy enforcement with OPA](../concepts/opa.md)
- [LangGraph Runtime Instrumentation](../adapters/langgraph.md#runtime-behavioral-instrumentation)
- [Sidecar Runbook](../RUNBOOK.md)
