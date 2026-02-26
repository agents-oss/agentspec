# Migrating BudgetBud to AgentSpec

This guide shows how to capture an existing agent's configuration in an `agent.yaml` manifest.
BudgetBud is a personal finance Telegram bot with 10 tools, Redis memory, Postgres, Langfuse, and deepeval.

## Analysis: What BudgetBud Has

| Component | Current location | AgentSpec field |
|-----------|-----------------|-----------------|
| Model | `GROQ_API_KEY` + groq client | `spec.model.provider: groq` |
| Fallback | `AZURE_OPENAI_API_KEY` | `spec.model.fallback` |
| System prompt | `backend/app/prompts/system_prompt.txt` | `spec.prompts.system: $file:prompts/system_prompt.txt` |
| Tools (10) | `tool_implementations.py` | `spec.tools[]` |
| Short-term memory | Redis (Upstash) `REDIS_URL` | `spec.memory.shortTerm.backend: redis` |
| Long-term memory | Postgres `DATABASE_URL` | `spec.memory.longTerm` |
| Sub-agents | `observer.yaml`, `reflector.yaml` | `spec.subagents[]` |
| API | FastAPI on port 8000 | `spec.api.type: rest` |
| Evaluation | deepeval | `spec.evaluation.framework: deepeval` |
| Observability | Langfuse | `spec.observability.tracing.backend: langfuse` |
| Guardrails | `guardrails.py` topic filter | `spec.guardrails.input[].type: topic-filter` |

## The Manifest

The complete manifest is at [`examples/budgetbud/agent.yaml`](../../examples/budgetbud/agent.yaml).

Key sections:

```yaml
spec:
  model:
    provider: groq
    id: llama-3.3-70b-versatile
    apiKey: $env:GROQ_API_KEY
    fallback:
      provider: azure
      id: gpt-4
      apiKey: $env:AZURE_OPENAI_API_KEY
      triggerOn: [rate_limit, timeout, error_5xx]
      maxRetries: 2
    costControls:
      maxMonthlyUSD: 200
      alertAtUSD: 150

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
      ttlDays: 90
    hygiene:
      piiScrubFields: [account_number, ssn, credit_card, bank_account]
      auditLog: true
```

## Step 1: Validate

```bash
npx agentspec validate examples/budgetbud/agent.yaml
```

## Step 2: Health Check (in BudgetBud repo, with env vars set)

```bash
cd /path/to/budgetbud
npx agentspec health agent.yaml
```

This verifies:
- `GROQ_API_KEY`, `DATABASE_URL`, `REDIS_URL` are set
- All `$file:` references exist (system prompt, eval datasets)
- Groq API is reachable
- Redis is reachable
- Postgres is reachable

## Step 3: Audit

```bash
npx agentspec audit agent.yaml
```

BudgetBud's full manifest scores ~85/100 (grade B) because:
- ✓ Fallback model declared (MODEL-01)
- ✓ Cost controls set (MODEL-03)
- ✓ PII scrub configured (SEC-LLM-06, MEM-01)
- ✓ Guardrails configured (SEC-LLM-01, SEC-LLM-02)
- ✓ Evaluation + CI gate (SEC-LLM-09, EVAL-02)
- ✗ API keys use `$env:` instead of `$secret:` (SEC-LLM-10)
- ✗ No vector store namespace (MEM-04)

## Step 4: Generate LangGraph Code

```bash
npm install @agentspec/adapter-langgraph
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
```

This produces a LangGraph version of BudgetBud, preserving all tools, memory, and guardrail structure.

## Step 5: Add to AGENTS.md

```markdown
## Agent Manifest

This project uses [AgentSpec](https://agentspec.io) for agent configuration.
See [agent.yaml](./agent.yaml) for the full manifest.

```bash
npx agentspec health   # Check runtime dependencies
npx agentspec audit    # Compliance report (OWASP LLM Top 10)
```
```
