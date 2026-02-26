# AgentSpec

**Universal Agent Manifest System** — define your agent once in `agent.yaml` and validate, health-check, audit, and generate code for any framework.

```bash
npm install -g @agentspec/cli

agentspec validate agent.yaml   # schema check
agentspec health   agent.yaml   # runtime dependency check
agentspec audit    agent.yaml   # OWASP LLM Top 10 score
agentspec generate agent.yaml --framework langgraph
```

[Quick Start](/quick-start) · [Manifest Schema](/reference/manifest-schema) · [GitHub](https://github.com/agentspec/agentspec)

---

## What it does

| | |
|---|---|
| **One manifest, any framework** | A single `agent.yaml` captures model, memory, tools, MCP, guardrails, evaluation, and observability. Generate LangGraph, CrewAI, Mastra, or AutoGen code from the same file. |
| **Runtime health checks** | `agentspec health` verifies every env var, file reference, model API endpoint, MCP server, and memory backend before your agent starts. |
| **Compliance scoring** | `agentspec audit` scores against OWASP LLM Top 10, memory hygiene, model resilience, and evaluation coverage — with remediation steps. |
| **Zero control plane** | Just a file and an SDK. No server, no account, no vendor lock-in. Drop into any CI pipeline in one command. |

## Why AgentSpec?

| Problem | Solution |
|---|---|
| Agent config scattered across code, env files, and docs | One `agent.yaml` captures everything |
| No way to know if dependencies are ready | `agentspec health` checks all services at once |
| Manual compliance review | `agentspec audit` scores against OWASP LLM Top 10 |
| Rewriting agents for each framework | `agentspec generate` outputs framework code from the manifest |
| Agents not discoverable by other agents | `agentspec export --format agentcard` produces an A2A AgentCard |

## Relationship to existing standards

```
agent.yaml  ──extends──▶   AGENTS.md          (reference from AGENTS.md)
agent.yaml  ──declares──▶  MCP servers         (spec.mcp.servers[])
agent.yaml  ──exports──▶   A2A / AgentCard
agent.yaml  ──generates──▶ LangGraph / CrewAI / Mastra / AutoGen
agent.yaml  ──implements──▶ AgentSkills        (spec.skills[])
```

AgentSpec **extends** existing standards — it does not replace them.

## Minimal manifest

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: my-agent
  version: 0.1.0
  description: My first AgentSpec agent

spec:
  model:
    provider: openai
    id: gpt-4o-mini
    apiKey: $env:OPENAI_API_KEY

  prompts:
    system: $file:prompts/system.md

  requires:
    envVars: [OPENAI_API_KEY]
```
