# Phase 4 — SDK `startPushMode()` (TypeScript + Python mirror)

**Status: ⬜ TODO**
**Depends on:** Phase 3 (control plane service running and accepting heartbeats)

---

## Goal

Add `startPushMode()` to the existing `AgentSpecReporter` class (TypeScript SDK) and create
a Python mirror (`agentspec-python` package). With two env vars (`AGENTSPEC_URL` +
`AGENTSPEC_KEY`), any agent on any runtime self-reports to the control plane — no sidecar,
no kubectl, no cluster access required.

This is the **minimum integration** for managed runtimes (Bedrock, Vertex, Modal, Fly.io):
add two env vars, agent appears in k9s.

---

## Why This Phase

Phase 3 builds the receiver; Phase 4 builds the sender. Together they complete the
"phone home" path. The SDK already generates `HealthReport` and `GapReport` via
`AgentSpecReporter` — push mode just adds a periodic POST to the control plane.

The TypeScript SDK is already used by agents built with agentspec. The Python mirror
targets agents built directly with `openai`, `anthropic`, or `langchain` — the majority
of real-world deployments.

---

## Deliverables

| Deliverable | File(s) | Status |
|-------------|---------|--------|
| `AgentSpecReporter.startPushMode()` | `packages/sdk/src/reporter/push.ts` | ⬜ |
| `AgentSpecReporter.stopPushMode()` | `packages/sdk/src/reporter/push.ts` | ⬜ |
| TypeScript SDK tests for push mode | `packages/sdk/src/__tests__/push.test.ts` | ⬜ |
| Python SDK package | `packages/sdk-python/` (new) | ⬜ |
| Python `AgentSpecReporter.start_push_mode()` | `packages/sdk-python/agentspec/reporter.py` | ⬜ |
| Python tests | `packages/sdk-python/tests/` | ⬜ |
| CLI `agentspec generate --push` flag | `packages/cli/src/commands/generate.ts` (update) | ⬜ |
| Documentation | `packages/sdk/README.md` push mode section | ⬜ |

---

## TypeScript API

### New method on `AgentSpecReporter`

```typescript
// packages/sdk/src/reporter/push.ts

export interface PushModeOptions {
  /** Control plane URL, e.g. https://control-plane.agentspec.io */
  controlPlaneUrl: string
  /** Agent API key issued by POST /api/v1/register */
  apiKey: string
  /** How often to push, in seconds. Default: 30 */
  intervalSeconds?: number
  /** Called when a push fails (does not stop push mode) */
  onError?: (err: Error) => void
}

// On AgentSpecReporter:
startPushMode(opts: PushModeOptions): void
stopPushMode(): void
isPushModeActive(): boolean
```

### Usage

```typescript
import { AgentSpecReporter } from '@agentspec/sdk'
import manifest from './agent.yaml'

const reporter = new AgentSpecReporter(manifest)

reporter.startPushMode({
  controlPlaneUrl: process.env.AGENTSPEC_URL!,
  apiKey: process.env.AGENTSPEC_KEY!,
  intervalSeconds: 30,
  onError: (err) => console.warn('[agentspec] push failed:', err.message),
})

// Agent logic here...

// On shutdown:
reporter.stopPushMode()
```

### Internal implementation

```typescript
private _pushInterval?: NodeJS.Timeout

startPushMode(opts: PushModeOptions): void {
  if (this._pushInterval) return   // idempotent
  const push = async () => {
    const health = await this.getReport()
    const gap = await this._buildGapReport()
    await fetch(`${opts.controlPlaneUrl}/api/v1/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ health, gap }),
    }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })
  }
  push().catch(opts.onError ?? console.error)   // fire immediately
  this._pushInterval = setInterval(() => push().catch(opts.onError ?? console.error),
    (opts.intervalSeconds ?? 30) * 1000)
}

stopPushMode(): void {
  if (this._pushInterval) {
    clearInterval(this._pushInterval)
    this._pushInterval = undefined
  }
}
```

---

## Python API

### New package: `packages/sdk-python/`

```
packages/sdk-python/
├── agentspec/
│   ├── __init__.py         # exports AgentSpecReporter
│   ├── reporter.py         # AgentSpecReporter class
│   ├── manifest.py         # load_manifest() — reads agent.yaml
│   ├── checks/             # Python ports of SDK checks (env, model, service)
│   │   ├── env_check.py
│   │   ├── model_check.py
│   │   └── service_check.py
│   └── types.py            # HealthReport, GapReport, HealthCheck Pydantic models
├── tests/
│   ├── conftest.py
│   ├── test_reporter.py
│   └── test_push_mode.py
├── pyproject.toml
└── README.md
```

### Python usage

```python
from agentspec import AgentSpecReporter
import os, signal, sys

reporter = AgentSpecReporter.from_yaml("agent.yaml")

reporter.start_push_mode(
    control_plane_url=os.environ["AGENTSPEC_URL"],
    api_key=os.environ["AGENTSPEC_KEY"],
    interval_seconds=30,
)

# Agent logic here...

def shutdown(sig, frame):
    reporter.stop_push_mode()
    sys.exit(0)

signal.signal(signal.SIGTERM, shutdown)
```

### Python implementation notes

- `asyncio.create_task()` for the background push loop (avoids blocking threads)
- If no running event loop (sync agent): use `threading.Timer` instead
- Auto-detect: `asyncio.get_running_loop()` — use async path if loop exists, else threading

---

## CLI Integration

Update `agentspec generate` to optionally emit `.env.agentspec`:

```bash
agentspec generate agent.yaml --push
```

Generates additional file `.env.agentspec`:
```
AGENTSPEC_URL=https://control-plane.agentspec.io
AGENTSPEC_KEY=<placeholder — paste key from agentspec register>
```

And adds SDK push mode bootstrap to the generated `main.py` (framework-specific snippet).

This closes the loop: `generate` → deploy with env vars → agent phones home → appears in k9s.

---

## Architecture

```
Agent process (any runtime)
  AgentSpecReporter.startPushMode() / start_push_mode()
       ↓  every 30s
  getReport()  →  runs all health checks (env, model, mcp, service...)
  buildGapReport()  →  scores manifest against compliance matrix
       ↓
  POST /api/v1/heartbeat  { health, gap }
  Authorization: Bearer <AGENTSPEC_KEY>
       ↓
  Control plane (Phase 3)
  → DB write + CR upsert
       ↓
  k9s :ao  →  remote agent row updates live
```

---

## Acceptance Criteria

### TypeScript SDK
- [ ] `reporter.startPushMode({...})` sends first heartbeat within 1s
- [ ] Interval fires every `intervalSeconds` (±1s)
- [ ] `reporter.stopPushMode()` cancels interval immediately
- [ ] Calling `startPushMode()` twice is idempotent (no double interval)
- [ ] HTTP 401/5xx triggers `onError` callback, does NOT stop push mode
- [ ] All new tests pass: `npm test` in `packages/sdk/`
- [ ] Existing 122 SDK tests still pass (no regression)

### Python SDK
- [ ] `reporter.start_push_mode(...)` works in both async and sync contexts
- [ ] `reporter.stop_push_mode()` cleans up background task/timer
- [ ] `HealthReport` Pydantic model matches TypeScript SDK shape exactly
- [ ] All tests pass: `pytest tests/ -v` in `packages/sdk-python/`

### End-to-end
- [ ] Local agent with env vars → heartbeat appears in control plane DB
- [ ] Control plane upserts CR → agent visible in k9s `:ao`
- [ ] UAT wow-2 demo reproducible (see `uat/wow-2-phone-home.md`)

---

## Security Considerations

- `AGENTSPEC_KEY` must never be logged (mask in debug output)
- Push payload capped at 64 KB client-side (mirrors server limit in Phase 3)
- `onError` callback receives sanitized error (no API key in stack traces)
- Python: `threading.Timer` version uses `daemon=True` so it doesn't prevent process exit

---

## Test Plan

### TypeScript unit tests (`packages/sdk/src/__tests__/push.test.ts`)
- Push fires immediately on `startPushMode()`
- Interval fires at correct cadence (vi.useFakeTimers)
- `stopPushMode()` clears interval
- `onError` called on HTTP 401 (mock fetch to return 401)
- Idempotent: second `startPushMode()` call ignored
- Mock `global.fetch` (same pattern as existing gap.test.ts)

### Python unit tests (`packages/sdk-python/tests/test_push_mode.py`)
- Async mode: uses `asyncio.create_task`
- Sync mode: uses `threading.Timer`
- Stop cancels background task/timer
- Heartbeat payload matches expected shape
