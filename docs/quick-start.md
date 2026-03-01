# Quick Start

Get your first AgentSpec manifest validated and health-checked in 5 minutes.

## Prerequisites

- [ ] Node.js 20+
- [ ] pnpm (or npm / yarn)

## 1. Get a manifest

### Option A — initialize from scratch

```bash
npx agentspec init
```

The interactive wizard asks for your agent name, model provider, and which features to enable. It creates `agent.yaml` in the current directory.

### Option B — scan existing code

Already have an agent codebase? Generate the manifest from source:

```bash
export ANTHROPIC_API_KEY=your-api-key-here
npx agentspec scan --dir ./src/ --dry-run   # preview first
npx agentspec scan --dir ./src/             # write agent.yaml
```

Claude reads your `.py` / `.ts` / `.js` files and infers model provider, tools, guardrails,
memory backend, and required env vars. Review the output — it's a starting point, not a final
answer.

### Option C — write manually

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

Generation uses Claude to reason over your manifest and produce complete, production-ready code.
Set your Anthropic API key, then run:

```bash
export ANTHROPIC_API_KEY=your-api-key-here
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
```

Get an API key at [console.anthropic.com](https://console.anthropic.com).

Generated files:
```
generated/
├── agent.py          # LangGraph agent with tools, memory, guardrails
├── requirements.txt  # All Python dependencies
├── .env.example      # Required env vars
└── README.md         # Setup instructions
```

Other supported frameworks: `--framework crewai`, `--framework mastra`.

## 8. Deploy to Kubernetes (optional)

No API key needed — output is deterministic.

```bash
npx agentspec generate agent.yaml --framework langgraph --deploy k8s --output ./generated/
```

This writes `generated/k8s/deployment.yaml`, `service.yaml`, `configmap.yaml`, and `secret.yaml.example`. The Deployment always includes `agentspec-sidecar` pre-wired on ports 4000/4001.

```bash
kubectl apply -f ./generated/k8s/configmap.yaml
# Edit secret.yaml.example → secret.yaml, then:
kubectl apply -f ./generated/k8s/secret.yaml
kubectl apply -f ./generated/k8s/deployment.yaml
kubectl apply -f ./generated/k8s/service.yaml
```

## Next Steps

- [Add tools](./guides/add-tools.md)
- [Add memory](./guides/add-memory.md)
- [Add guardrails](./guides/add-guardrails.md)
- [Add push mode](./guides/add-push-mode.md) — real-time health reporting
- [Integrate with CI](./guides/ci-integration.md) — drift detection + compliance gates
- [Full manifest reference](./reference/manifest-schema.md)
