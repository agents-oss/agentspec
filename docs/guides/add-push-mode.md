# Add Push Mode

Enable your agent to proactively report its health and compliance state to a control plane,
instead of waiting to be probed.

## Overview

AgentSpec supports two health reporting patterns:

| Pattern | How it works | When to use |
|---------|-------------|-------------|
| **Pull** (`AgentSpecReporter`) | Control plane polls `/agentspec/health` on your agent | Agent is reachable on a stable URL |
| **Push** (`startPushMode`) | Agent pushes reports to a control plane URL on a timer | Agent is behind NAT, runs as a job, or the control plane cannot reach the agent |

Push mode is configured via two env vars written to `.env.agentspec` when you generate with `--push`:

```
AGENTSPEC_URL=https://your-control-plane/agents/report
AGENTSPEC_KEY=your-api-key
```

## Prerequisites

- [ ] `agent.yaml` exists and passes `agentspec validate`
- [ ] TypeScript: `@agentspec/sdk` installed; Python: `agentspec` SDK installed
- [ ] A control plane URL that accepts `POST` with a JSON health payload

## TypeScript SDK

### 1. Generate with `--push`

```bash
agentspec generate agent.yaml --framework langgraph --push
```

This writes `.env.agentspec` alongside the generated code:

```
AGENTSPEC_URL=https://your-control-plane/agents/report
AGENTSPEC_KEY=your-api-key
```

Fill in the real values before deploying.

### 2. Call `startPushMode` in your agent

```typescript
import { loadManifest, startPushMode, stopPushMode } from '@agentspec/sdk'

const { manifest } = loadManifest('./agent.yaml')

// Fire immediately and every 30 seconds
startPushMode({
  manifest,
  url: process.env.AGENTSPEC_URL!,
  apiKey: process.env.AGENTSPEC_KEY!,
  intervalMs: 30_000,
})

// Graceful shutdown
process.on('SIGTERM', () => {
  stopPushMode()
  process.exit(0)
})
```

### 3. API

```typescript
import { startPushMode, stopPushMode, isPushModeActive } from '@agentspec/sdk'

// Options
interface PushModeOptions {
  manifest: AgentManifest   // loaded via loadManifest()
  url: string               // POST endpoint on your control plane
  apiKey: string            // Bearer token sent in Authorization header
  intervalMs?: number       // default: 30_000 (30 seconds)
}

startPushMode(opts)   // idempotent — calling twice is a no-op
stopPushMode()        // clears the interval
isPushModeActive()    // returns boolean
```

The payload POSTed to `url` on each interval:

```json
{
  "health": { /* HealthReport from getReport() */ },
  "gap":    { /* AuditResult from runAudit(manifest) */ }
}
```

Total payload is capped at **64 KB**. API keys are redacted in all log/error output.

## Python SDK

### Sync agents

```python
from agentspec import AgentSpecReporter

reporter = AgentSpecReporter.from_yaml("agent.yaml")

# Push immediately and every 30 seconds (daemon thread)
reporter.start_push_mode(
    url=os.environ["AGENTSPEC_URL"],
    api_key=os.environ["AGENTSPEC_KEY"],
    interval_seconds=30,
)

# Shutdown
reporter.stop_push_mode()
```

### Async agents (FastAPI / asyncio)

```python
import asyncio
from agentspec import AgentSpecReporter

reporter = AgentSpecReporter.from_yaml("agent.yaml")

# Detects running event loop and uses asyncio.create_task automatically
reporter.start_push_mode(
    url=os.environ["AGENTSPEC_URL"],
    api_key=os.environ["AGENTSPEC_KEY"],
    interval_seconds=30,
)
```

### FastAPI lifespan example

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from agentspec import AgentSpecReporter

reporter = AgentSpecReporter.from_yaml("agent.yaml")

@asynccontextmanager
async def lifespan(app: FastAPI):
    reporter.start_push_mode(
        url=os.environ["AGENTSPEC_URL"],
        api_key=os.environ["AGENTSPEC_KEY"],
    )
    yield
    reporter.stop_push_mode()

app = FastAPI(lifespan=lifespan)
```

## Configuration reference

| Env var | Required | Description |
|---------|----------|-------------|
| `AGENTSPEC_URL` | Yes | `POST` endpoint on your control plane |
| `AGENTSPEC_KEY` | Yes | Bearer token — sent as `Authorization: Bearer <key>` |

The interval defaults to **30 seconds** and can be overridden in code. There is no env var for
the interval — configure it at the call site.

## Troubleshooting

**Push mode fires once then stops**
: Check that `stopPushMode()` is not called prematurely. Call `isPushModeActive()` to verify
  the timer is still running.

**401 Unauthorized from control plane**
: Verify `AGENTSPEC_KEY` matches the key expected by the control plane. The SDK sends
  `Authorization: Bearer <key>`.

**Payload rejected (413 / too large)**
: The SDK caps payloads at 64 KB. If your health report is unusually large, check for
  large tool descriptions or overly verbose audit messages in your manifest.

**No logs / silent failure**
: Push errors are logged to `console.error` (TypeScript) or the standard logger (Python).
  Ensure your logging configuration captures stderr.

## See also

- [Add runtime health (pull mode)](./add-runtime-health.md)
- [CLI Reference — `--push` flag](../reference/cli.md#agentspec-generate)
- [CI Integration](./ci-integration.md)
