# Probe Coverage

What AgentSpec can and cannot verify for each `agent.yaml` field — and how to move from declarations to runtime proof.

## Evidence Tiers

Every AgentSpec check is labelled with one of three evidence tiers:

| Tier | Badge | What it means |
|------|-------|---------------|
| **Declarative** | `[D]` | Manifest analysis only — we read the YAML. No I/O required. |
| **Probed** | `[P]` | Health check verified at infrastructure level (TCP/HTTP reachability). Run `agentspec health`. |
| **Behavioral** | `[B]` | Runtime events confirmed actual execution. Requires sdk-langgraph + EventPush. |

**Important:** The grade (A–F) is based on **declarative** checks only. `[D]` violations are real violations you can fix by editing `agent.yaml`. `[P]` and `[B]` labels are informational — they tell you *how much evidence backs the finding*, not whether the grade changes.

---

## Field Coverage Matrix

### Model

| Field | `[D]` Audit Rule | `[P]` Health Check | `[B]` Behavioral |
|-------|-----------------|-------------------|------------------|
| `spec.model.provider` | SEC-LLM-05 (provider declared) | — | — |
| `spec.model.id` | MODEL-02 (no `latest`), SEC-LLM-05 | — | — |
| `spec.model.apiKey` | — | HTTP GET to provider `/v1/models` | — |
| `spec.model.fallback` | MODEL-01, MODEL-04 | HTTP GET to fallback provider | — |
| `spec.model.costControls.maxMonthlyUSD` | SEC-LLM-04, MODEL-03 | — | `ModelCallEvent(token_count)` aggregated |

### Guardrails

| Field | `[D]` Audit Rule | `[P]` Health Check | `[B]` Behavioral |
|-------|-----------------|-------------------|------------------|
| `spec.guardrails.input[].type` | SEC-LLM-01 (`prompt-injection`/`topic-filter`) | — | `GuardrailEvent(invoked=true)` |
| `spec.guardrails.output[].threshold` | SEC-LLM-02 (output guardrail declared) | — | `GuardrailEvent(score)` |
| `spec.guardrails` (absent) | SEC-LLM-01, SEC-LLM-02 | — | — |

### Memory

| Field | `[D]` Audit Rule | `[P]` Health Check | `[B]` Behavioral |
|-------|-----------------|-------------------|------------------|
| `spec.memory.shortTerm.backend` | — | TCP connect (Redis/Postgres) | — |
| `spec.memory.shortTerm.ttlSeconds` | MEM-02 (TTL declared) | — | `MemoryWriteEvent(ttl_seconds)` |
| `spec.memory.shortTerm.maxTokens` | MEM-05 | — | — |
| `spec.memory.longTerm.connectionString` | — | TCP connect | — |
| `spec.memory.longTerm.ttlDays` | MEM-02 | — | — |
| `spec.memory.hygiene.piiScrubFields` | MEM-01, SEC-LLM-06 | — | `MemoryWriteEvent(pii_scrubbed)` |
| `spec.memory.hygiene.auditLog` | MEM-03 | — | — |
| `spec.memory.vector.namespace` | MEM-04 | TCP connect | — |

### Tools

| Field | `[D]` Audit Rule | `[P]` Health Check | `[B]` Behavioral |
|-------|-----------------|-------------------|------------------|
| `spec.tools[].annotations.readOnlyHint` | SEC-LLM-07 | — | — |
| `spec.tools[].annotations.destructiveHint` | SEC-LLM-08, SEC-LLM-07 | — | `ToolCallEvent(name)` + `user_confirmed` |
| `spec.tools[].name` (registered) | — | Agent SDK reports `tool:{name}` check | — |

### MCP

| Field | `[D]` Audit Rule | `[P]` Health Check | `[B]` Behavioral |
|-------|-----------------|-------------------|------------------|
| `spec.mcp.servers[].url` | — | HTTP GET | — |
| `spec.mcp.servers[].command` | — | `which <cmd>` | — |

### Evaluation

| Field | `[D]` Audit Rule | `[P]` Health Check | `[B]` Behavioral |
|-------|-----------------|-------------------|------------------|
| `spec.evaluation.datasets[]` | EVAL-01 (declared) | `existsSync($file:)` | `agentspec evaluate` run |
| `spec.evaluation.framework` | SEC-LLM-09 | — | Framework CLI exit code |
| `spec.evaluation.ciGate` | SEC-LLM-09, EVAL-02 | — | `agentspec evaluate` exit code |
| `spec.evaluation.thresholds.hallucination` | EVAL-03 | — | `agentspec evaluate --framework` |

### Observability

| Field | `[D]` Audit Rule | `[P]` Health Check | `[B]` Behavioral |
|-------|-----------------|-------------------|------------------|
| `spec.observability.tracing.backend` | OBS-01 | — | Actual spans emitted (not yet probed) |
| `spec.observability.logging.structured` | OBS-02 | — | — |
| `spec.observability.logging.redactFields` | OBS-03 | — | — |

### Infrastructure

| Field | `[D]` Audit Rule | `[P]` Health Check | `[B]` Behavioral |
|-------|-----------------|-------------------|------------------|
| `spec.requires.envVars[]` + `$env:*` refs | — | `process.env` lookup | — |
| `$file:*` refs (prompts, datasets) | — | `existsSync` | — |
| `spec.requires.services[]` | — | TCP connect | — |
| `spec.subagents[].ref.a2a.url` | — | HTTP GET | — |

---

## How to Read Audit Output

The `agentspec audit` command now shows evidence badges next to each violation:

```
  Violations (4)

  [critical] [D] SEC-LLM-06 — Sensitive data disclosure: PII scrub in memory hygiene
    Long-term memory declared without piiScrubFields — PII may be persisted.
    Path: /spec/memory/hygiene/piiScrubFields
    → Add spec.memory.hygiene.piiScrubFields: [ssn, credit_card, bank_account]

  Evidence Breakdown
    [D] Declarative  18/22  (manifest declarations)
    [P] Probed        N/A   (run `agentspec health <file>` for live infrastructure checks)
    [B] Behavioral    N/A   (no runtime events — deploy with sdk-langgraph + EventPush)
```

- **`[D]` violations** — fix them by updating `agent.yaml`. No deployment needed.
- **`[P]` issues** (in `/gap` endpoint) — fix infrastructure: set env vars, start services.
- **`[B]` issues** (in `/gap` endpoint) — fix runtime wiring: connect guardrails, tool handlers.

---

## How to Move Up the Evidence Ladder

### `[D]` → `[P]`: Run Health Checks

```bash
agentspec health agent.yaml
```

This performs TCP/HTTP probes for every declared dependency (model API key, Redis, Postgres, MCP servers, services). Results appear in the `/gap` endpoint of the sidecar.

### `[P]` → `[B]`: Deploy with EventPush

Install `agentspec-langgraph` (Python SDK) and wire it into your agent:

```python
from agentspec_langgraph import SidecarClient, GuardrailMiddleware

sidecar = SidecarClient(base_url="http://localhost:4001")
guardrail = GuardrailMiddleware(sidecar)

# Each LLM call reports GuardrailEvent, ToolCallEvent, MemoryWriteEvent
```

Once EventPush is active, the sidecar's `/gap` endpoint will include `[B]` evidence for:
- Whether guardrails are actually invoked on every request
- Whether destructive tools require user confirmation
- Whether memory TTL is applied correctly

### Evaluate Your Agent with Real Data

```bash
agentspec evaluate agent.yaml \
  --url http://localhost:4000 \
  --dataset golden-qa
```

This sends your declared JSONL dataset to the live agent and scores actual outputs — the only way to get behavioral evidence for evaluation quality.

---

## Frequently Asked Questions

**Q: Does a `[D]` violation mean my agent is insecure?**

Not necessarily. It means the manifest doesn't *declare* the protection. If the protection is implemented in code but not in the manifest, the audit will flag it. Keeping the manifest in sync with the implementation is the point of AgentSpec.

**Q: Will fixing `[D]` violations change my grade?**

Yes. All audit rules (and therefore all grade calculations) are currently `[D]` — declarative. Fixing them improves your score.

**Q: Can I suppress a violation I can't fix?**

Yes. Add a suppression with a reason:

```yaml
spec:
  compliance:
    suppressions:
      - rule: SEC-LLM-10
        reason: "Using $env: by design — no Vault available in this environment"
        approvedBy: "security@example.com"
        expires: "2026-12-31"
```

**Q: Are `[P]` and `[B]` issues included in the grade?**

No. The grade is based on `[D]` declarative rules only. `[P]` and `[B]` issues appear in the sidecar's `/gap` endpoint and are informational.

---

## See Also

- [Compliance & Audit](./compliance.md) — scoring, packs, suppressions
- [Health Checks](./health-checks.md) — full list of `[P]` probed checks
- [Runtime Introspection](./runtime-introspection.md) — sidecar `/gap` endpoint
- [CLI Reference: evaluate](../reference/cli.md#agentspec-evaluate) — running evaluation datasets
