# AgentSpec

**Universal Agent Manifest System** — define, validate, health-check, audit, and generate any AI agent from a single `agent.yaml` file.

```bash
npx agentspec validate agent.yaml  # Schema validation
npx agentspec health agent.yaml    # Runtime health checks
npx agentspec audit agent.yaml     # Compliance scoring (OWASP LLM Top 10)
npx agentspec generate agent.yaml --framework langgraph
```

---

## The Problem

AI agents are defined across scattered files: environment variables, prompt files, tool modules, and framework-specific configs. There is no portable way to:
- Know if all dependencies are present before starting (`health`)
- Check compliance with OWASP LLM Top 10 automatically (`audit`)
- Generate the same agent for a different framework (`generate`)
- Make agents discoverable and auditable without a control plane

## The Solution

One `agent.yaml` manifest captures everything:

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: budget-assistant
  version: 1.0.0
  description: "Personal finance AI assistant"

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
    costControls:
      maxMonthlyUSD: 200

  prompts:
    system: $file:prompts/system.md

  tools:
    - name: create-expense
      type: function
      description: "Create a new expense record"
      module: $file:tools/expenses.py
      function: create_expense
      annotations:
        readOnlyHint: false
        destructiveHint: false

  memory:
    shortTerm:
      backend: redis
      connection: $env:REDIS_URL
      maxTokens: 8000
      ttlSeconds: 3600
    hygiene:
      piiScrubFields: [ssn, credit_card, bank_account]
      auditLog: true

  guardrails:
    input:
      - type: prompt-injection
        action: reject
    output:
      - type: toxicity-filter
        threshold: 0.7
        action: reject

  evaluation:
    framework: deepeval
    ciGate: true

  compliance:
    packs:
      - owasp-llm-top10
      - model-resilience
      - memory-hygiene
```

---

## Three Properties

| Property | Description |
|----------|-------------|
| **Zero control plane** | Just a file + SDK loaded locally. No server required. |
| **Extends existing standards** | MCP-compatible, AGENTS.md-compatible, A2A/AgentCard exportable. |
| **Framework-agnostic** | Generates LangGraph, CrewAI, Mastra, AutoGen code via adapters. |

---

## Packages

| Package | Description |
|---------|-------------|
| `@agentspec/sdk` | Core: load, health, audit, generate registry |
| `@agentspec/cli` | `agentspec` CLI (npx agentspec) |
| `@agentspec/adapter-langgraph` | LangGraph Python code generator |
| `@agentspec/adapter-crewai` | *(coming soon)* |
| `@agentspec/adapter-mastra` | *(coming soon)* |
| `@agentspec/adapter-autogen` | *(coming soon)* |

---

## Quick Start

```bash
# Create a new manifest
npx agentspec init

# Validate schema
npx agentspec validate agent.yaml

# Check runtime dependencies
npx agentspec health agent.yaml

# Compliance audit (OWASP LLM Top 10)
npx agentspec audit agent.yaml

# Generate LangGraph code
npm install @agentspec/adapter-langgraph
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
```

---

## Health Check Output

```
  AgentSpec Health — budget-assistant
  ─────────────────────────────────────
  Status: ● healthy

  ENV
    ✓ env:GROQ_API_KEY
    ✓ env:DATABASE_URL
    ✓ env:REDIS_URL

  MODEL
    ✓ model:groq/llama-3.3-70b-versatile (94ms)
    ✓ model-fallback:azure/gpt-4 (112ms)

  MEMORY
    ✓ memory.shortTerm:redis (3ms)
    ✓ memory.longTerm:postgres (5ms)
```

## Compliance Audit Output

```
  AgentSpec Audit — budget-assistant
  ────────────────────────────────────
  Score : B  82/100

  Category Scores
    owasp-llm-top10          75% ███████████████░░░░░
    model-resilience         100% ████████████████████
    memory-hygiene            80% ████████████████░░░░

  Violations (2)
    [high] SEC-LLM-10 — API keys use $secret, not $env
    [medium] MEM-04 — Vector store namespace isolated
```

---

## Extending AGENTS.md

```markdown
## Agent Manifest
This project uses [AgentSpec](https://agentspec.io) for agent configuration.
See [agent.yaml](./agent.yaml) for the full manifest.

Run `npx agentspec health` to check runtime dependencies.
Run `npx agentspec audit` for compliance report.
```

---

## Reference Syntax

| Syntax | Resolves to |
|--------|-------------|
| `$env:VAR_NAME` | Environment variable |
| `$secret:name` | Secret manager (Vault/AWS/GCP/Azure) |
| `$file:path` | File relative to `agent.yaml` |
| `$func:now_iso` | Built-in function (timestamp, etc.) |

---

## Documentation

- [Quick Start](./docs/quick-start.md)
- [Manifest Concepts](./docs/concepts/manifest.md)
- [Health Checks](./docs/concepts/health-checks.md)
- [Compliance & Audit](./docs/concepts/compliance.md)
- [LangGraph Adapter](./docs/adapters/langgraph.md)
- [BudgetBud Migration Guide](./docs/guides/migrate-budgetbud.md)
- [CLI Reference](./docs/reference/cli.md)

---

## Tech Stack

TypeScript · pnpm workspaces · Zod · js-yaml · commander · vitest · tsup

---

## License

Apache 2.0
