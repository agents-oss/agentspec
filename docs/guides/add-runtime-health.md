# Add Runtime Health to Your Agent

This guide shows how to mount `AgentSpecReporter` in your agent server so the AgentSpec sidecar can probe live health state from the running process.

## Install

`AgentSpecReporter` is part of `@agentspec/sdk` — no separate install needed.

```bash
npm install @agentspec/sdk
```

## Fastify

```typescript
import Fastify from 'fastify'
import { loadManifest } from '@agentspec/sdk'
import { AgentSpecReporter, agentSpecFastifyPlugin } from '@agentspec/sdk'

const app = Fastify()
const { manifest } = loadManifest('./agent.yaml')

// Create reporter — refreshes every 30s in the background
const reporter = new AgentSpecReporter(manifest, {
  refreshIntervalMs: 30_000,
})

// Register the /agentspec/health route
await app.register(agentSpecFastifyPlugin(reporter))

// Start background refresh before accepting traffic
reporter.start()

app.addHook('onClose', () => reporter.stop())

await app.listen({ port: 3000 })
```

This registers `GET /agentspec/health` on your Fastify instance. The sidecar will probe this endpoint automatically.

## Express

```typescript
import express from 'express'
import { loadManifest } from '@agentspec/sdk'
import { AgentSpecReporter, agentSpecExpressRouter } from '@agentspec/sdk'

const app = express()
const { manifest } = loadManifest('./agent.yaml')

const reporter = new AgentSpecReporter(manifest, {
  refreshIntervalMs: 30_000,
})

// Mounts GET /agentspec/health
app.use('/agentspec', agentSpecExpressRouter(reporter))

reporter.start()

const server = app.listen(3000, () => {
  console.log('Agent running on :3000')
})

process.on('SIGTERM', () => {
  reporter.stop()
  server.close()
})
```

## Other Frameworks

For any other HTTP framework, use `httpHandler()` directly:

```typescript
const reporter = new AgentSpecReporter(manifest)
reporter.start()

// handler: (req, res) => Promise<void>
// res must have .status(code).json(body)
const handler = reporter.httpHandler()

// Mount at GET /agentspec/health in your framework
myFramework.get('/agentspec/health', handler)
```

## What Gets Checked

`AgentSpecReporter` runs the full check suite from inside your process on every refresh:

| Check | What it verifies |
|-------|-----------------|
| `env:*` | `$env:` references exist in `process.env` |
| `model:*` | Provider API endpoint reachable (resolves `$env:` key at runtime) |
| `service:*` | TCP connectivity for `spec.requires.services` entries |
| `tool:*` | All `spec.tools` entries are registered (always `pass` inside the agent) |

> **Model endpoint probing** — The reporter resolves `$env:VAR` API key references from `process.env` at check time, so model endpoints are actually probed in production. A `skip` status means the env var is not set; `fail` means the endpoint returned a 5xx or timed out.

## Reporter Options

```typescript
const reporter = new AgentSpecReporter(manifest, {
  // How often to re-run checks in the background (default: 30_000 ms)
  refreshIntervalMs: 30_000,

  // Max age of cached report before getReport() triggers a synchronous re-check (default: 60_000 ms)
  staleAfterMs: 60_000,
})
```

## Lifecycle

```typescript
reporter.start()   // starts background refresh, fires first check immediately (non-blocking)
reporter.stop()    // clears the interval; getReport() returns last cached report without re-checking
```

Call `start()` once during server startup and `stop()` during graceful shutdown. Calling `start()` twice is safe — it is idempotent.

## Verifying the Endpoint

```bash
curl http://localhost:3000/agentspec/health | jq .
```

Expected output:

```json
{
  "agentName": "my-agent",
  "timestamp": "2026-02-28T10:00:00.000Z",
  "status": "healthy",
  "summary": { "passed": 4, "failed": 0, "warnings": 0, "skipped": 0 },
  "checks": [
    { "id": "env:GROQ_API_KEY",  "category": "env",     "status": "pass", "severity": "error" },
    { "id": "model:groq/llama-3.3-70b-versatile", "category": "model", "status": "pass",
      "severity": "error", "latencyMs": 88 },
    { "id": "service:redis",     "category": "service", "status": "pass", "severity": "info", "latencyMs": 2 },
    { "id": "tool:my-tool",      "category": "tool",    "status": "pass", "severity": "info" }
  ]
}
```

Once the endpoint is live, the sidecar's `/gap`, `/explore`, and `/health/ready` endpoints automatically switch from static manifest analysis to live probe data.

## Deploying to Kubernetes with the Sidecar

Use `--deploy k8s` to generate Kubernetes manifests that wire the sidecar correctly:

```bash
agentspec generate agent.yaml --framework langgraph --deploy k8s --output ./out/
```

The generated `k8s/deployment.yaml` includes `agentspec-sidecar` pre-configured with the correct `UPSTREAM_URL` and `MANIFEST_PATH`:

```yaml
- name: agentspec-sidecar
  image: ghcr.io/agentspec/sidecar:latest
  ports:
    - containerPort: 4000   # proxy
    - containerPort: 4001   # control plane (/gap, /explore, /health/ready)
  env:
    - name: UPSTREAM_URL
      value: "http://localhost:<agent-port>"
    - name: MANIFEST_PATH
      value: /manifest/agent.yaml
```

Once the pod is running, the sidecar probes `GET /agentspec/health` on the agent container automatically. If your agent has `AgentSpecReporter` mounted (see above), the control plane endpoints serve live data:

```bash
# Check live health via the control plane port
kubectl port-forward svc/<agent-name> 4001:4001
curl http://localhost:4001/agentspec/health/ready
curl http://localhost:4001/agentspec/explore
curl http://localhost:4001/agentspec/gap
```

If `AgentSpecReporter` is not mounted, the sidecar falls back to static manifest analysis (same data as `agentspec health`).

## See Also

- [Runtime Introspection concept](/concepts/runtime-introspection)
- [Health Checks concept](/concepts/health-checks)
- [CLI Reference — `agentspec generate --deploy`](/reference/cli#--deploy-k8s)
