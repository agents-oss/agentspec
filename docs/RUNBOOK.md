# AgentSpec Runbook

Operational reference for running `agentspec-sidecar` alongside an agent in production.

## Deployment

### Docker Compose (recommended for local and dev)

Use `agentspec generate --deploy k8s` or supply your own `docker-compose.yml`. A typical layout:

```yaml
services:
  my-agent:
    build: .
    ports:
      - "8000:8000"

  agentspec-sidecar:
    image: ghcr.io/agentspec/sidecar:latest
    ports:
      - "4000:4000"   # proxy (traffic)
      - "4001:4001"   # control plane (diagnostics)
    environment:
      UPSTREAM_URL: http://my-agent:8000
      MANIFEST_PATH: /manifest/agent.yaml
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    volumes:
      - ./agent.yaml:/manifest/agent.yaml:ro
    depends_on:
      - my-agent
```

### Kubernetes

Generate manifests from your `agent.yaml`:

```bash
agentspec generate agent.yaml --framework langgraph --deploy k8s --output ./out/
```

Apply:
```bash
kubectl apply -f out/k8s/configmap.yaml
# Fill out/k8s/secret.yaml.example → out/k8s/secret.yaml, then:
kubectl apply -f out/k8s/secret.yaml
kubectl apply -f out/k8s/deployment.yaml
kubectl apply -f out/k8s/service.yaml
```

The generated Deployment always includes `agentspec-sidecar` as a sidecar container pre-wired at ports 4000 (proxy) and 4001 (control plane).

### Helm

```bash
agentspec generate agent.yaml --framework langgraph --deploy helm --output ./out/
helm install my-agent ./out/ -f out/values.yaml --set image.tag=latest
helm upgrade  my-agent ./out/ -f out/values.yaml
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `UPSTREAM_URL` | **Yes** | `http://localhost:8000` | Agent's base HTTP URL |
| `MANIFEST_PATH` | No | `/manifest/agent.yaml` | Path to agent.yaml in the container |
| `PROXY_PORT` | No | `4000` | Sidecar proxy listen port |
| `CONTROL_PLANE_PORT` | No | `4001` | Control plane listen port |
| `ANTHROPIC_API_KEY` | No | — | Enables LLM gap analysis (`GET /agentspec/gap`) |
| `AUDIT_RING_SIZE` | No | `1000` | Max audit ring entries retained in memory |
| `OPA_URL` | No | — | OPA base URL (e.g. `http://localhost:8181`). When set, `/gap` calls OPA for behavioral violations. Fails-open if OPA is unreachable. |

`UPSTREAM_URL` and `MANIFEST_PATH` must be set correctly. The sidecar will fail to start if `UPSTREAM_URL` is not a valid `http://` or `https://` URL, or if port values are non-integer.

---

## Ports

| Port | Service | Endpoint examples |
|------|---------|-------------------|
| 4000 | Proxy | All agent traffic — transparent pass-through with audit hooks |
| 4001 | Control plane | `GET /agentspec/health/ready`, `GET /agentspec/explore`, `GET /agentspec/gap` |

Route user/client traffic to **port 4000**. Route monitoring and diagnostic tooling to **port 4001**.

---

## Health Checks

### Liveness

```bash
curl http://localhost:4001/agentspec/health/ready
# 200 → ready, 503 → not ready
```

### Readiness (Kubernetes probe)

```yaml
readinessProbe:
  httpGet:
    path: /agentspec/health/ready
    port: 4001
  initialDelaySeconds: 5
  periodSeconds: 10
livenessProbe:
  httpGet:
    path: /agentspec/health/ready
    port: 4001
  initialDelaySeconds: 15
  periodSeconds: 30
```

### Agent SDK endpoint (optional but recommended)

If the agent mounts `AgentSpecReporter` (see [Add Runtime Health](./guides/add-runtime-health.md)), the sidecar probes `GET /agentspec/health` on the upstream and enriches all three control plane responses with live data. Without it, responses fall back to static manifest analysis.

---

## Monitoring

### Key endpoints to scrape

| Endpoint | Port | What to watch |
|----------|------|---------------|
| `GET /agentspec/health/ready` | 4001 | `status` field: `ready` / `degraded` / `not-ready` |
| `GET /agentspec/explore` | 4001 | `source` field: `agent-sdk` = live, `manifest-static` = fallback |
| `GET /agentspec/gap` | 4001 | `issues` array length; any `severity: critical` |

### Audit ring

```bash
curl http://localhost:4001/agentspec/audit          # last N requests
curl http://localhost:4001/agentspec/audit?limit=50 # last 50
```

The ring is a fixed-size in-memory circular buffer (`AUDIT_RING_SIZE`, default 1000). It is not persisted across restarts.

---

## Common Issues

### Sidecar starts but `/health/ready` returns 503

**Cause:** Upstream agent is not reachable at `UPSTREAM_URL`.

**Fix:**
1. Verify `UPSTREAM_URL` points to the correct host and port.
2. Check the agent container started and is listening: `kubectl logs <agent-pod>` / `docker logs <agent-container>`.
3. Check network policy if running in Kubernetes — sidecar must reach the agent on its container port.

---

### `UPSTREAM_URL` startup error

**Symptom:** `Invalid UPSTREAM_URL: "..." — must use http: or https: protocol`

**Fix:** Set `UPSTREAM_URL` to a full `http://` or `https://` URL. Do not omit the scheme.

---

### `/agentspec/gap` returns `"source": "manifest-static"` and no LLM analysis

**Cause 1:** `ANTHROPIC_API_KEY` is not set.
**Fix:** Set `ANTHROPIC_API_KEY` in the sidecar's environment.

**Cause 2:** Agent does not expose `GET /agentspec/health` (no `AgentSpecReporter` mounted).
**Fix (optional):** Mount `AgentSpecReporter` — see [Add Runtime Health](./guides/add-runtime-health.md). The sidecar degrades gracefully without it; LLM gap analysis will use manifest-only data.

---

### Model check always shows `status: skip`

**Cause:** The `$env:` API key reference in the manifest is not resolved (env var not set in the agent's process environment).

**Fix:** Ensure the env var named by `spec.model.apiKey` (e.g. `OPENAI_API_KEY`) is set in the agent container's environment and that `AgentSpecReporter` is running.

---

### Audit ring is empty

**Cause:** No traffic has flowed through the proxy yet, or the sidecar was restarted (ring is in-memory only).

This is expected on a fresh start. The ring fills as requests pass through port 4000.

---

## Rollback

### Docker Compose

```bash
# Pin to a previous image tag
docker pull ghcr.io/agentspec/sidecar:v0.1.0
# Update docker-compose.yml image tag, then:
docker compose up -d agentspec-sidecar
```

### Kubernetes

```bash
kubectl rollout undo deployment/<agent-name>
# or pin to a specific revision:
kubectl rollout undo deployment/<agent-name> --to-revision=2
```

### Helm

```bash
helm rollback <release-name> <revision>
helm history  <release-name>   # list revisions
```

---

## Building and Publishing the Sidecar Image

```bash
# From repo root (pnpm workspace)
pnpm --filter @agentspec/sidecar build

# Docker build (multi-stage, from repo root)
docker build -f packages/sidecar/Dockerfile -t ghcr.io/agentspec/sidecar:latest .

# Publish
docker push ghcr.io/agentspec/sidecar:latest
```

---

## See Also

- [Add Runtime Health](./guides/add-runtime-health.md) — mount `AgentSpecReporter` in your agent
- [CLI Reference](./reference/cli.md) — `agentspec generate --deploy k8s|helm`
- [CONTRIB.md](./CONTRIB.md) — development setup and scripts
