# MCP Server Reference

Use AgentSpec tools directly from Claude Code, Cursor, Windsurf, or any MCP-compatible AI editor.

## Install

```bash
# Claude Code
claude mcp add agentspec -- npx -y @agentspec/mcp

# Cursor / Windsurf — add to your MCP config:
{
  "mcpServers": {
    "agentspec": {
      "command": "npx",
      "args": ["-y", "@agentspec/mcp"]
    }
  }
}
```

For cluster mode, add env vars so all tools automatically query the control plane:

```json
{
  "mcpServers": {
    "agentspec": {
      "command": "npx",
      "args": ["-y", "@agentspec/mcp"],
      "env": {
        "AGENTSPEC_CONTROL_PLANE_URL": "http://localhost:8080",
        "AGENTSPEC_ADMIN_KEY": "your-admin-key"
      }
    }
  }
}
```

Port-forward the control plane first:
```bash
kubectl port-forward svc/agentspec-operator-control-plane -n agentspec-system 8080:80
```

---

## What to ask

The MCP server exposes 8 tools. Here are the typical questions that trigger each one.

### Agent discovery

> "What agents do I have?"
> "List all agents in the cluster"
> "Which agents have active heartbeats?"

Tool: `agentspec_list_agents` — scans local `agent.yaml` files or fetches registered agents from the control plane. In cluster mode, shows heartbeat status per agent and a summary of how many are actively pushing.

### Health diagnostics

> "Is my agent healthy?"
> "What's wrong with budget-assistant?"
> "Check if the model API key is working"

Tool: `agentspec_health` — runs health checks against a local manifest, a live sidecar, or the operator's stored data.

### Compliance audit

> "How compliant is my agent?"
> "What's the audit score for agent.yaml?"
> "Run OWASP LLM top 10 checks on my agent"

Tool: `agentspec_audit` — runs compliance rules and returns score, grade, and violations. Can enrich results with proof records from the sidecar or operator.

### Compliance proof

> "Show me the proof records for budget-assistant"
> "What evidence has been submitted for SEC-LLM-01?"

Tool: `agentspec_proof` — fetches compliance proof records (external evidence submitted against specific audit rules).

### Gap analysis

> "What's the gap between my manifest and runtime?"
> "Are all declared tools actually registered?"
> "Is the model reachable?"

Tool: `agentspec_gap` — compares what the manifest declares vs what the agent actually has at runtime (tools, services, model, memory).

### Manifest validation

> "Validate my agent.yaml"
> "Is this manifest valid?"
> "Check agent.yaml for schema errors"

Tool: `agentspec_validate` — validates a manifest against the AgentSpec schema. Returns errors with paths and fix suggestions.

### Manifest diff

> "What changed between the old and new manifest?"
> "Compare these two agent.yaml files"

Tool: `agentspec_diff` — returns a JSON diff between two `agent.yaml` files.

### Code generation

> "Generate a LangGraph agent from this manifest"
> "Scaffold a CrewAI project from agent.yaml"
> "Generate Mastra code from my spec"

Tool: `agentspec_generate` — generates framework-specific code (LangGraph, CrewAI, Mastra) from a manifest.

### Scanning

> "Scan this directory and generate an agent.yaml"
> "What would the manifest look like for this codebase?"

Tool: `agentspec_scan` — analyzes source code and generates a draft `agent.yaml` manifest.

---

## Common workflow

A typical diagnostic session flows like this:

```
1. "What agents do I have?"          → agentspec_list_agents
2. "Is budget-assistant healthy?"    → agentspec_health
3. "What's the gap?"                 → agentspec_gap
4. "Run a compliance audit"          → agentspec_audit
5. "Show proof records"              → agentspec_proof
```

---

## Tools reference

### `agentspec_validate`

Validate an `agent.yaml` manifest against the AgentSpec schema.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `file` | Yes | Path to `agent.yaml` |

### `agentspec_health`

Run or fetch health checks for an agent.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `file` | No | Path to `agent.yaml` (local mode) |
| `agentName` | No | Agent name in the operator (operator mode) |
| `controlPlaneUrl` | No | Operator URL. Required with `agentName`. |
| `adminKey` | No | `X-Admin-Key` for the operator API |
| `sidecarUrl` | No | Direct sidecar URL (e.g. `http://localhost:4001`) |

Three modes: pass `file` for local checks, `sidecarUrl` for live sidecar data, or `agentName` + `controlPlaneUrl` for operator-stored data.

### `agentspec_audit`

Run compliance audit and return score, grade, and violations.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `file` | Yes | Path to `agent.yaml` |
| `pack` | No | Compliance pack (e.g. `owasp-llm-top10`) |
| `agentName` | No | Agent name for operator proof lookup |
| `controlPlaneUrl` | No | Operator URL. Required with `agentName`. |
| `adminKey` | No | `X-Admin-Key` for the operator API |
| `sidecarUrl` | No | Sidecar URL to fetch proof records |

### `agentspec_gap`

Fetch the declared-vs-runtime gap report for an agent.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentName` | No | Agent name in the control plane |
| `controlPlaneUrl` | No | Control plane URL. Required with `agentName`. |
| `adminKey` | No | `X-Admin-Key` for the control plane API |
| `sidecarUrl` | No | Direct sidecar URL for local dev |

### `agentspec_proof`

Fetch compliance proof records for an agent.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentName` | No | Agent name in the control plane |
| `controlPlaneUrl` | No | Control plane URL. Required with `agentName`. |
| `adminKey` | No | `X-Admin-Key` for the control plane API |
| `sidecarUrl` | No | Direct sidecar URL for local dev |

### `agentspec_list_agents`

List agents from the cluster or local filesystem.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `dir` | No | Directory to scan for `agent.yaml` files (local mode, default: cwd) |
| `controlPlaneUrl` | No | Control plane URL for cluster mode |
| `adminKey` | No | `X-Admin-Key` for the control plane API |

In cluster mode (when `controlPlaneUrl` is set or `AGENTSPEC_CONTROL_PLANE_URL` env is present), returns registered agents with heartbeat status. Otherwise, scans the filesystem.

### `agentspec_scan`

Scan a source directory and generate an `agent.yaml` manifest.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `dir` | Yes | Directory to scan |

### `agentspec_generate`

Generate framework code from an `agent.yaml`.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `file` | Yes | Path to `agent.yaml` |
| `framework` | Yes | Target framework: `langgraph`, `crewai`, or `mastra` |
| `out` | No | Output directory |

### `agentspec_diff`

Compare two `agent.yaml` files and return a JSON diff.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `from` | Yes | Path to the base `agent.yaml` |
| `to` | Yes | Path to the new `agent.yaml` |

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `AGENTSPEC_CONTROL_PLANE_URL` | Default control plane URL for all cluster-aware tools |
| `AGENTSPEC_ADMIN_KEY` | Default admin key for the control plane API |

When set, all cluster-aware tools (`list_agents`, `health`, `audit`, `gap`, `proof`) automatically query the cluster. Per-call arguments override env vars.

Local-only tools (`validate`, `scan`, `generate`, `diff`) are unaffected.

---

## Transports

The MCP server supports two transports:

| Transport | When | How |
|-----------|------|-----|
| **stdio** (default) | Spawned by `npx` / editor MCP config | Line-delimited JSON-RPC on stdin/stdout |
| **HTTP** | Persistent server | `npx @agentspec/mcp --http` → `POST http://localhost:3666/mcp` |

HTTP mode also serves `GET /health` for readiness checks.

## See also

- [Operating Modes](../concepts/operating-modes.md) — sidecar vs operator mode
- [CLI Reference](./cli.md) — equivalent CLI commands
- [Quick Start](../quick-start.md) — install and first use
