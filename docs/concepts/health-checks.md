# Health Checks

AgentSpec's health check system verifies that all runtime dependencies are present and reachable before you start your agent.

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
    ✓ model:groq/llama-3.3-70b-versatile (94ms)
    ✗ model-fallback:azure/gpt-4
       Fallback model endpoint unreachable
       → Check AZURE_OPENAI_API_KEY

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
| `env` | All `$env:VAR` references exist | error |
| `file` | All `$file:path` references exist | error |
| `model` | Model API endpoint reachable | error |
| `model-fallback` | Fallback model API reachable | warning |
| `mcp` | MCP server command found / HTTP endpoint reachable | warning |
| `memory` | Redis/Postgres TCP connectivity | warning |
| `subagent` | Sub-agent manifest files exist / A2A endpoints reachable | warning |
| `eval` | Evaluation dataset files exist | info |

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
  "summary": { "passed": 8, "failed": 2, "warnings": 1, "skipped": 0 },
  "checks": [
    {
      "id": "env:GROQ_API_KEY",
      "category": "env",
      "status": "pass",
      "severity": "error"
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
