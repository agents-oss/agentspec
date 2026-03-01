# AgentSpec

**One declarative manifest. Everything else follows.**

`agent.yaml` is the single source of truth for your agent — its model, memory, tools, guardrails, evaluation, and observability, all in one place. Every AgentSpec capability flows from that file: validate it, health-check it, score it for compliance, drive agentic code generation from it, and attach a distributed control plane sidecar to it at runtime.

```bash
npm install -g @agentspec/cli

agentspec validate agent.yaml   # schema check
agentspec health   agent.yaml   # runtime dependency check
agentspec audit    agent.yaml   # OWASP LLM Top 10 score
agentspec generate agent.yaml   # agentic code generation (LLM-driven)
```

[Quick Start](/quick-start) · [Manifest Schema](/reference/manifest-schema) · [GitHub](https://github.com/agentspec/agentspec)

---

## What it does

| | |
|---|---|
| **One declarative manifest** | `agent.yaml` captures model, memory, tools, MCP, guardrails, evaluation, and observability in a single, portable, machine-readable file. It is the only place you need to change when your agent's architecture changes. |
| **Agentic code generation** | `agentspec generate` passes the manifest as a precise, token-efficient context to an LLM agent. The standard structure eliminates hallucinated configs and ambiguous wiring — the LLM generates correct, idiomatic code for any framework without bespoke per-framework adapters. |
| **Runtime health checks** | `agentspec health` verifies every env var, file reference, model API endpoint, MCP server, and service dependency before your agent starts — all derived from the manifest. |
| **Distributed control plane** | `agentspec-sidecar` loads as a Docker init container alongside your agent. It proxies all traffic, maintains an audit ring, and exposes a control plane with live gap analysis (`/gap`), capability discovery (`/explore`), and runtime health probing (`/health/ready`) — all grounded in the same `agent.yaml`. |
| **Compliance scoring** | `agentspec audit` scores against OWASP LLM Top 10, memory hygiene, model resilience, and evaluation coverage — derived entirely from manifest declarations. |
| **Behavioral policy enforcement** | `agentspec generate-policy` converts manifest declarations into a Rego bundle for OPA. Deploy OPA as a sidecar and get per-request enforcement of guardrail invocation, cost limits, TTLs, and tool confirmations — visible in the sidecar's `/gap` endpoint. |

## Why AgentSpec?

| Problem | Solution |
|---|---|
| Agent config scattered across code, env files, and docs | One `agent.yaml` captures everything |
| No way to know if dependencies are ready before startup | `agentspec health` checks all services and model endpoints at once |
| Manual compliance review | `agentspec audit` scores against OWASP LLM Top 10 |
| Framework code generation wastes tokens on boilerplate and hallucinations | `agentspec generate` gives the LLM a complete, structured manifest — token-efficient and standard-conformant |
| No visibility into a running agent's live state | `agentspec-sidecar` exposes `/gap`, `/explore`, and `/health/ready` backed by live runtime introspection |
| Agents not discoverable by other agents | `agentspec export --format agentcard` produces an A2A AgentCard |

## Architecture

`agent.yaml` is the root. Every tool in the AgentSpec ecosystem reads from it — nothing is configured twice.

```
agent.yaml  (single source of truth)
    │
    ├──validate────────▶  schema check (Zod)
    ├──health──────────▶  pre-flight dependency check
    ├──audit───────────▶  OWASP LLM Top 10 compliance score
    ├──generate────────▶  LLM agent reads manifest → outputs framework code
    │   ├──deploy k8s──▶  k8s/ Deployment + Service + ConfigMap + Secret (deterministic)
    │   └──deploy helm─▶  full Helm chart with agentspec-sidecar (Claude-generated)
    ├──generate-policy─▶  Rego bundle → OPA sidecar (behavioral enforcement)
    │                         deny if guardrail not invoked
    │                         deny if cost limit exceeded
    │                         deny if TTL mismatch
    └──runtime─────────▶  agentspec-sidecar (Docker init)
                              ├── :4000  proxy  (audit ring, traffic hooks)
                              └── :4001  control plane
                                      ├── GET /health/ready   (live agent health)
                                      ├── GET /explore        (capability discovery)
                                      └── GET /gap            (gap analysis + OPA violations)
```

## Relationship to existing standards

```
agent.yaml  ──extends──▶   AGENTS.md          (reference from AGENTS.md)
agent.yaml  ──declares──▶  MCP servers         (spec.mcp.servers[])
agent.yaml  ──exports──▶   A2A / AgentCard
agent.yaml  ──drives───▶   agentic generation  (LLM reads manifest, outputs any framework)
agent.yaml  ──implements──▶ AgentSkills        (spec.skills[])
agent.yaml  ──monitored─▶  agentspec-sidecar   (distributed control plane via Docker init)
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
