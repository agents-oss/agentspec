# Quick Start

Get your first AgentSpec manifest validated and health-checked in 5 minutes.

## Prerequisites

- [ ] Node.js 20+
- [ ] pnpm (or npm / yarn)

## 1. Initialize a manifest

```bash
npx agentspec init
```

The interactive wizard asks for your agent name, model provider, and which features to enable. It creates `agent.yaml` in the current directory.

Alternatively, create `agent.yaml` manually:

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: my-agent
  version: 0.1.0
  description: "My first AgentSpec agent"

spec:
  model:
    provider: openai
    id: gpt-4o-mini
    apiKey: $env:OPENAI_API_KEY
    parameters:
      temperature: 0.7
      maxTokens: 2000

  prompts:
    system: $file:prompts/system.md
    fallback: "I'm having trouble. Please try again."

  requires:
    envVars:
      - OPENAI_API_KEY
```

## 2. Create your system prompt

```bash
mkdir prompts
echo "You are a helpful assistant." > prompts/system.md
```

## 3. Validate the manifest

```bash
npx agentspec validate agent.yaml
```

Expected output:
```
  AgentSpec Validate
  ──────────────────────
  ✓ Manifest valid — my-agent v0.1.0 (agentspec.io/v1)

  Provider : openai/gpt-4o-mini
  Tools    : 0
  MCP      : 0 servers
  Memory   : none
```

## 4. Set your env vars

```bash
export OPENAI_API_KEY=sk-...
```

## 5. Run health checks

```bash
npx agentspec health agent.yaml
```

Expected output:
```
  AgentSpec Health — my-agent
  ────────────────────────────
  Status: ● healthy

  ENV
    ✓ env:OPENAI_API_KEY

  FILE
    ✓ file:prompts/system.md

  MODEL
    ✓ model:openai/gpt-4o-mini (142ms)
```

## 6. Run compliance audit

```bash
npx agentspec audit agent.yaml
```

The audit scores your agent against OWASP LLM Top 10 and other compliance packs.
A minimal agent will score ~45/100 (grade D). Add guardrails, evaluation, and fallback to improve.

## 7. Generate LangGraph code

```bash
npm install @agentspec/adapter-langgraph
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
```

Generated files:
```
generated/
├── agent.py          # LangGraph agent with tools, memory, guardrails
├── requirements.txt  # All Python dependencies
├── .env.example      # Required env vars
└── README.md         # Setup instructions
```

## Next Steps

- [Add tools](./guides/add-tools.md)
- [Add memory](./guides/add-memory.md)
- [Add guardrails](./guides/add-guardrails.md)
- [Integrate with CI](./guides/ci-integration.md)
- [Full manifest reference](./reference/manifest-schema.md)
