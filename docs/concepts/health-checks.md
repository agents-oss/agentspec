# Health Checks

AgentSpec's health check system verifies that all runtime dependencies are present and reachable before you start your agent.

> **CLI checks vs runtime introspection** — This page covers pre-flight checks run by the `agentspec health` CLI. For live health reporting from inside a running agent, see [Runtime Introspection](/concepts/runtime-introspection).

## Running Health Checks

```bash
npx agentspec health agent.yaml
```

Output:
```
  AgentSpec Health — budget-assistant
  ─────────────────────────────────────
  Status: ◐ degraded
  Passed: 8  Failed: 2  Skipped: 1

  ENV
    ✓ env:GROQ_API_KEY
    ✓ env:DATABASE_URL
    ✗ env:REDIS_URL
       REDIS_URL is not set
       → Set REDIS_URL in your .env file

  FILE
    ✓ file:prompts/system.md

  MODEL
    ✓ model:groq/llama-3.3-70b-versatile (94ms)   ← GROQ_API_KEY set, endpoint up
    ✗ model-fallback:azure/gpt-4                   ← AZURE_OPENAI_API_KEY set, endpoint errored
       Fallback model endpoint unreachable: HTTP 503
       → Check AZURE_OPENAI_API_KEY and provider status

  MCP
    – mcp:postgres-db (skipped: command not resolved)

  MEMORY
    ✗ memory.shortTerm:redis
       Redis not reachable: Connection refused
       → Check REDIS_URL and ensure Redis is running
```

## Check Categories

| Category | What is checked | Severity if failed |
|---|---|---|
| `env` | All `$env:VAR` references exist in the process environment | error |
| `file` | All `$file:path` references exist on disk | error |
| `model` | Model API endpoint reachable (only when API key env var is set) | error |
| `model-fallback` | Fallback model API reachable | warning |
| `mcp` | MCP server command found / HTTP endpoint reachable | warning |
| `memory` | Redis/Postgres TCP connectivity for `spec.memory` backends | warning |
| `service` | TCP connectivity for each `spec.requires.services` entry | warning |
| `tool` | Tool handler is registered in the running agent process | info |
| `subagent` | Sub-agent manifest files exist / A2A endpoints reachable | warning |
| `eval` | Evaluation dataset files exist | info |

### Model endpoint probing

The `model` check resolves `$env:VAR_NAME` references from the process environment before attempting to contact the provider API:

- **Env var set** → endpoint is probed; `pass` if reachable (any 2xx or 4xx response), `fail` if server returns 5xx or the connection is refused/times out
- **Env var not set** → check status is `skip`; the `env` check surfaces the missing variable independently
- **Non-`$env:` references** (`$secret:`, `$file:`) → always `skip` (cannot be resolved at CLI time)

```
MODEL
  ✓ model:groq/llama-3.3-70b-versatile (94ms)   ← env var set, endpoint reachable
  – model:openai/gpt-4o (skipped)                ← OPENAI_API_KEY not set
  ✗ model-fallback:azure/gpt-4                   ← endpoint returned 503
     Fallback model endpoint unreachable: HTTP 503
     → Check AZURE_OPENAI_API_KEY and provider status
```

### Service TCP checks

The `service` category runs raw TCP connectivity checks — no driver or client library required. Supported service types: `redis`, `postgres`, `mysql`, `mongodb`, `elasticsearch`.

```yaml
spec:
  requires:
    services:
      - type: postgres
        connection: $env:DATABASE_URL   # resolved at runtime
      - type: redis
        connection: redis://redis:6379  # literal — probed directly
```

Loopback (`127.x.x.x`, `::1`, `localhost`) and link-local (`169.254.x.x`, `fe80::/10`) addresses are always skipped to prevent SSRF in container environments.

## Health Status

- **healthy** — all `error` severity checks pass
- **degraded** — all `error` checks pass, some `warning` checks fail
- **unhealthy** — one or more `error` checks fail

## CLI Options

```bash
# Exit code 1 on warnings too (strict mode for CI)
npx agentspec health agent.yaml --fail-on warning

# JSON output for CI processing
npx agentspec health agent.yaml --json

# Skip slow model API checks
npx agentspec health agent.yaml --no-model

# Skip MCP server checks
npx agentspec health agent.yaml --no-mcp
```

## Declaring Runtime Requirements

Use `spec.requires` to explicitly declare dependencies:

```yaml
spec:
  requires:
    envVars:
      - GROQ_API_KEY
      - DATABASE_URL
    services:
      - type: postgres
        connection: $env:DATABASE_URL
      - type: redis
        connection: $env:REDIS_URL
    minimumMemoryMB: 512
```

The `envVars` list is merged with automatically-detected `$env:` references throughout the manifest.

## Output Format (JSON)

```json
{
  "agentName": "budget-assistant",
  "timestamp": "2026-02-26T10:00:00Z",
  "status": "degraded",
  "summary": { "passed": 8, "failed": 2, "warnings": 1, "skipped": 1 },
  "checks": [
    {
      "id": "env:GROQ_API_KEY",
      "category": "env",
      "status": "pass",
      "severity": "error"
    },
    {
      "id": "model:groq/llama-3.3-70b-versatile",
      "category": "model",
      "status": "pass",
      "severity": "error",
      "latencyMs": 94
    },
    {
      "id": "model:openai/gpt-4o",
      "category": "model",
      "status": "skip",
      "severity": "error",
      "message": "Cannot check model endpoint: API key reference not resolved ($env:OPENAI_API_KEY)"
    },
    {
      "id": "service:postgres",
      "category": "service",
      "status": "pass",
      "severity": "info",
      "latencyMs": 3
    },
    {
      "id": "mcp:postgres-db",
      "category": "mcp",
      "status": "fail",
      "severity": "warning",
      "latencyMs": 5001,
      "message": "MCP server postgres-db health check timed out",
      "remediation": "Check that npx @modelcontextprotocol/server-postgres is installed and DATABASE_URL is correct"
    }
  ]
}
```
