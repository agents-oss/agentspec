# Operating Modes

AgentSpec provides two distinct runtime access modes for querying live agent data:
**Sidecar mode** and **Operator mode**.

Understanding which mode to use — and how to configure it — removes the primary
source of confusion when working with VS Code, MCP, and the CLI.

---

## The Two Modes at a Glance

| Property | Sidecar Mode | Operator Mode |
|---|---|---|
| **When to use** | Local dev, or cluster agent via per-agent port-forward | K8s cluster with AgentSpec Operator deployed |
| **URL target** | `http://localhost:4001` (direct or port-forwarded per agent) | Operator service URL (one URL for all agents) |
| **Data freshness** | **Live** — computed fresh on each request | **Stored** — last heartbeat (up to `RATE_LIMIT_SECONDS` stale) |
| **Endpoints** | `GET /gap`, `GET /proof`, `GET /health/ready`, `GET /explore` | `GET /api/v1/agents/{name}/gap`, `/proof`, `/health` |
| **Auth** | None (port-forward is already a trust boundary) | `X-Admin-Key` header |
| **VS Code config** | `agentspec.sidecarUrl` | `agentspec.cluster.controlPlaneUrl` + `agentspec.cluster.adminKey` |

---

## Sidecar Mode

**Sidecar mode** connects directly to a single agent's sidecar process (port 4001).

### When to use

- Local development (agent running on your machine)
- Cluster agent accessed via `kubectl port-forward` to port 4001
- No AgentSpec Operator deployed

### URL target

The sidecar runs at port 4001 inside the agent's pod. In local development, this
is usually `http://localhost:4001` directly. In a cluster without the Operator,
you port-forward per agent:

```bash
kubectl port-forward -n my-namespace deployment/budget-assistant 4001:4001
# → http://localhost:4001
```

VS Code does this automatically when you right-click a cluster agent and the
`agentspec.cluster.controlPlaneUrl` setting is **not** set.

### Data

All endpoints return **live** data computed at request time:

- `GET /gap` — declared vs runtime gap (fresh comparison)
- `GET /proof` — compliance proof records
- `GET /health/ready` — live health checks
- `GET /explore` — runtime capabilities

### VS Code configuration

```json
// .vscode/settings.json
{
  "agentspec.sidecarUrl": "http://localhost:4001"
}
```

Leave `agentspec.cluster.controlPlaneUrl` empty. When you right-click a cluster
agent in the AgentSpec Agents view, the extension port-forwards automatically.

### MCP configuration

Install the MCP server in your AI editor:

**Claude Code / Cursor / Windsurf** — add to your MCP config:
```json
{
  "mcpServers": {
    "agentspec": {
      "command": "npx",
      "args": ["-y", "@agentspec/mcp"]
    }
  }
}
```

**Claude Code** (via `claude mcp add`):
```bash
claude mcp add agentspec -- npx -y @agentspec/mcp
```

In sidecar mode no env vars are needed — tool arguments point directly at the sidecar.

Tool arguments for sidecar mode:
```json
// agentspec_health
{ "sidecarUrl": "http://localhost:4001" }

// agentspec_audit
{ "file": "agent.yaml", "sidecarUrl": "http://localhost:4001" }

// agentspec_gap
{ "sidecarUrl": "http://localhost:4001" }
```

---

## Operator Mode

**Operator mode** connects to the AgentSpec Operator — a cluster-wide REST API
that aggregates data from all agents via heartbeat pushes.

### When to use

- K8s cluster with the AgentSpec Operator deployed
- You want a **single URL** to access all agents (no per-agent port-forward)
- Slightly stale data (stored last heartbeat) is acceptable

### URL target

The Operator service exposes a REST API. Access it via:

**Local cluster** (kind, minikube, etc.):
```bash
kubectl port-forward svc/agentspec-operator -n agentspec 8080:80
# → http://localhost:8080
```

**Production** (ingress / load balancer):
```
https://agentspec.mycompany.com
```

One port-forward / URL gives access to **all agents**. No per-agent tunnels needed.

### Data

All endpoints return **stored** data from the last heartbeat push:

- `GET /api/v1/agents/{name}/gap` — last known gap report
- `GET /api/v1/agents/{name}/proof` — proof records
- `GET /api/v1/agents/{name}/health` — last health check result

### VS Code configuration

```json
// .vscode/settings.json
{
  "agentspec.cluster.controlPlaneUrl": "http://localhost:8080",
  "agentspec.cluster.adminKey": ""
}
```

Or set the key via environment variable:
```bash
export AGENTSPEC_ADMIN_KEY=your-key
```

When `agentspec.cluster.controlPlaneUrl` is set and you right-click a cluster
agent, the extension uses the Operator instead of spawning a per-agent
port-forward.

### MCP configuration

For operator mode, port-forward the control plane service to your local machine:

```bash
kubectl port-forward svc/agentspec-operator -n agentspec 8080:80
```

Then configure the MCP server with env vars so all tools automatically use the cluster:

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

| Env var | Description |
|---|---|
| `AGENTSPEC_CONTROL_PLANE_URL` | Control plane URL (e.g. `http://localhost:8080` after port-forward) |
| `AGENTSPEC_ADMIN_KEY` | The admin key for the control plane API. This is the same value as `controlPlane.apiKey` in the Helm chart (`values.yaml`). Empty by default — if you didn't set it during install, omit it or leave it as `""`. |

This is the same key used in three places:

| Where | Setting | Purpose |
|---|---|---|
| Control plane deployment | `AGENTSPEC_ADMIN_KEY` env var | The control plane checks this on every admin request |
| Helm chart | `controlPlane.apiKey` in `values.yaml` | The operator uses this to poll `GET /api/v1/agents` |
| MCP server config | `AGENTSPEC_ADMIN_KEY` env var | Your editor uses this to query the control plane |

If you installed with the default Helm values (`controlPlane.apiKey: ""`), the control plane has no admin key set and returns **503** on admin endpoints. To enable them, set the key:

```bash
# Generate a key
openssl rand -hex 32

# Set it on the control plane (pick one):
# Helm upgrade:
helm upgrade agentspec-operator oci://ghcr.io/agents-oss/charts/agentspec-operator \
  --set controlPlane.apiKey=<your-key> \
  --namespace agentspec-system

# Or create the secret directly:
kubectl create secret generic agentspec-control-plane \
  --namespace=agentspec-system \
  --from-literal=apiKey=<your-key>
```

Then use the same key in your MCP config.

With these env vars set, all cluster-aware tools (`agentspec_list_agents`, `agentspec_health`, `agentspec_audit`, `agentspec_gap`, `agentspec_proof`) automatically query the cluster. Per-call arguments still override env vars when needed.

Tools that only work locally (`agentspec_validate`, `agentspec_scan`, `agentspec_generate`, `agentspec_diff`) are unaffected.

You can still pass tool arguments explicitly to override the defaults:
```json
// agentspec_health — override to target a specific agent
{ "agentName": "budget-assistant" }

// agentspec_list_agents — no args needed, fetches all cluster agents
{}

// agentspec_audit — local manifest + cluster proofs
{ "file": "agent.yaml", "agentName": "budget-assistant" }
```

---

## Port-Forward: Not a Third Mode

Port-forward is a **transport detail**, not a separate mode:

| Mode | Port-forward scope | kubectl command |
|---|---|---|
| **Sidecar** | Per agent (one process per agent) | `kubectl port-forward deployment/<name> <local>:4001` |
| **Operator** | Per cluster (one process, all agents) | `kubectl port-forward svc/agentspec-operator -n agentspec 8080:80` |

VS Code manages sidecar port-forwards automatically (idle cleanup on deactivate).
Operator port-forward is a one-time manual step.

---

## Decision Guide

```
Do you have the AgentSpec Operator deployed?
│
├─ No (local dev / no operator)
│   └── Use Sidecar mode
│       • agentspec.sidecarUrl = http://localhost:4001
│       • Or right-click cluster agent (VS Code auto port-forwards)
│
└─ Yes (cluster with operator)
    └── Use Operator mode
        • agentspec.cluster.controlPlaneUrl = https://agentspec.mycompany.com
        • agentspec.cluster.adminKey = (your key or AGENTSPEC_ADMIN_KEY env)
        • One URL covers all agents — no per-agent port-forward
```

---

## Live vs Stored Data Trade-off

| Concern | Sidecar (live) | Operator (stored) |
|---|---|---|
| Gap accuracy | Exact at request time | Up to `RATE_LIMIT_SECONDS` stale |
| Scalability | 1 tunnel per agent | 1 tunnel for entire cluster |
| Works without cluster | ✅ (local dev) | ❌ (requires operator) |
| Proof submission | ✅ (POST /proof/rule/:id) | ✅ (POST via operator API) |
| Identity verification | ✅ (via GET /explore) | ✅ (agent name from cluster node) |

For production compliance dashboards, Operator mode is preferred. For local
debugging with exact live data, use Sidecar mode.

---

## See Also

- [Health Checks](./health-checks.md) — what each check category means
- [Compliance & Proof](./compliance.md) — evidence levels and proof records
- [Runtime Introspection](./runtime-introspection.md) — sidecar endpoints reference
