# Migrating an Existing Agent to AgentSpec

This guide walks through the process of capturing an existing agent's architecture in an `agent.yaml` manifest. We use a gym coaching assistant as the example — the same steps apply to any agent.

---

## Step 1: Inventory Your Agent

Before writing `agent.yaml`, audit your agent's components:

| Question | Where to find it |
|----------|-----------------|
| What model does it use? | Env vars (`OPENAI_API_KEY`), config files |
| Is there a fallback model? | Code (`if rate_limit: use_fallback()`) |
| What tools does it call? | Tool function files, API clients |
| What MCP servers? | `.mcp.json`, server configs |
| Short-term memory? | Redis, SQLite, or in-memory |
| Long-term memory? | Postgres, MongoDB |
| Vector store? | pgvector, Pinecone, Weaviate |
| Guardrails? | Input/output validation code |
| Observability? | Langfuse, LangSmith, OpenTelemetry |
| Evaluation? | deepeval, Braintrust datasets |
| Sub-agents? | Separate agent processes/files |

---

## Step 2: Write the Manifest

### Gym Coach Example

A typical fitness coaching agent has:
- **Model**: Groq Llama (fast, cheap) with Azure GPT-4 fallback
- **Tools**: log-workout, get-progress-summary, create-workout-plan (10+ functions)
- **Memory**: Redis (short-term), Postgres (long-term, 90-day retention)
- **Guardrails**: Topic filter (fitness-only), PII scrub (medical data)
- **Evaluation**: deepeval with hallucination < 5%
- **Observability**: Langfuse

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: gymcoach
  version: 1.0.0
  description: "AI fitness coach — workout plans, session tracking, nutrition guidance"
  tags: [fitness, coaching, health]

spec:
  model:
    provider: groq
    id: llama-3.3-70b-versatile
    apiKey: $env:GROQ_API_KEY
    parameters:
      temperature: 0.3
      maxTokens: 500
    fallback:
      provider: azure
      id: gpt-4
      apiKey: $env:AZURE_OPENAI_API_KEY
      triggerOn: [rate_limit, timeout, error_5xx]
      maxRetries: 2
    costControls:
      maxMonthlyUSD: 200
      alertAtUSD: 150

  prompts:
    system: $file:prompts/system.md
    fallback: "I'm experiencing difficulties. Please try again."
    hotReload: true

  tools:
    - name: log-workout
      type: function
      description: "Log a completed training session"
      module: $file:tools/workouts.py
      function: log_workout
      annotations:
        readOnlyHint: false
        destructiveHint: false

    - name: get-progress-summary
      type: function
      description: "Get training progress by muscle group for a period"
      module: $file:tools/analytics.py
      function: get_progress_summary
      annotations:
        readOnlyHint: true
        idempotentHint: true

    - name: delete-workout
      type: function
      description: "Delete a logged training session"
      module: $file:tools/workouts.py
      function: delete_workout
      annotations:
        readOnlyHint: false
        destructiveHint: true    # <-- required for SEC-LLM-08

  memory:
    shortTerm:
      backend: redis
      maxTurns: 20
      maxTokens: 8000
      ttlSeconds: 3600
      connection: $env:REDIS_URL

    longTerm:
      backend: postgres
      connectionString: $env:DATABASE_URL
      table: sessions
      ttlDays: 90

    hygiene:
      piiScrubFields: [date_of_birth, medical_conditions, injury_history]
      auditLog: true

  guardrails:
    input:
      - type: topic-filter
        blockedTopics: [illegal_activity, self_harm]
        action: reject
        message: "I can only help with fitness and training topics."
      - type: prompt-injection
        action: reject
        sensitivity: high
    output:
      - type: hallucination-detector
        threshold: 0.8
        action: retry
        maxRetries: 2
      - type: toxicity-filter
        threshold: 0.7
        action: reject

  evaluation:
    framework: deepeval
    datasets:
      - name: workout-qa
        path: $file:eval/workout-qa.jsonl
    metrics: [faithfulness, hallucination, answer_relevancy]
    thresholds:
      hallucination: 0.05
    ciGate: true

  observability:
    tracing:
      backend: langfuse
      endpoint: $env:LANGFUSE_HOST
      publicKey: $env:LANGFUSE_PUBLIC_KEY
      secretKey: $secret:langfuse-secret
      sampleRate: 1.0

  compliance:
    packs:
      - owasp-llm-top10
      - model-resilience
      - memory-hygiene
      - evaluation-coverage
    auditSchedule: weekly

  requires:
    envVars:
      - GROQ_API_KEY
      - DATABASE_URL
      - REDIS_URL
      - LANGFUSE_HOST
      - LANGFUSE_PUBLIC_KEY
    services:
      - type: postgres
        connection: $env:DATABASE_URL
      - type: redis
        connection: $env:REDIS_URL
    minimumMemoryMB: 512
```

---

## Step 3: Validate

```bash
agentspec validate agent.yaml
```

Fix any schema errors before continuing. Common mistakes:
- Tool `name` has uppercase or spaces → must be lowercase slug
- `version` is not semver → `1.0.0` not `v1`
- `temperature` > 2 → must be `0..2`

---

## Step 4: Health Check

```bash
export GROQ_API_KEY=gsk_...
export DATABASE_URL=postgres://...
export REDIS_URL=redis://...

agentspec health agent.yaml
```

Common failures:
- `env:REDIS_URL not set` → set env var
- `memory.shortTerm:redis — Connection refused` → start Redis
- `file:eval/workout-qa.jsonl not found` → create dataset or remove from manifest

---

## Step 5: Audit

```bash
agentspec audit agent.yaml
```

The well-configured gym coach above scores **~88/100 (B)**:

| Pack | Score | Notes |
|------|-------|-------|
| owasp-llm-top10 | 80% | SEC-LLM-10: uses `$env:` not `$secret:` |
| model-resilience | 100% | Fallback, retries, cost controls all configured |
| memory-hygiene | 100% | PII scrub, TTL, audit log all set |
| evaluation-coverage | 85% | CI gate enabled, hallucination threshold set |

To reach grade A (90+), move API keys to `$secret:` references.

---

## Step 6: Generate LangGraph Code

```bash
export ANTHROPIC_API_KEY=your-api-key-here
agentspec generate agent.yaml --framework langgraph --output ./generated/
```

The adapter maps every manifest field to production-ready Python:
- `spec.model.fallback` → `primary_llm.with_fallbacks([fallback_llm])`
- `spec.memory.shortTerm.backend: redis` → `RedisSaver` checkpointer
- `spec.guardrails` → `guardrails.py` with `run_input_guardrails()` / `run_output_guardrails()`
- `spec.observability.tracing.backend: langfuse` → `LangfuseCallback` handler

---

## Step 7: Add to AGENTS.md

Add this block to your project's `AGENTS.md`:

```markdown
## Agent Manifest
This project uses [AgentSpec](https://agentspec.io) for agent configuration.
See [agent.yaml](./agent.yaml) for the full manifest.

Run `agentspec health` to verify all runtime dependencies.
Run `agentspec audit` for the OWASP LLM Top 10 compliance report.
```

---

## Checklist

- [ ] `agentspec validate agent.yaml` exits 0
- [ ] `agentspec health agent.yaml` shows all `error` checks passing
- [ ] `agentspec audit agent.yaml` scores ≥ 75 (grade B)
- [ ] `agent.yaml` committed to the repo
- [ ] `AGENTS.md` references `agent.yaml`
- [ ] CI pipeline runs `agentspec validate` and `agentspec audit`
