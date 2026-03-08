# The agent.yaml Manifest

The `agent.yaml` manifest is the central artifact of AgentSpec. It describes everything about your agent in a single, portable, machine-readable file.

## Structure

AgentSpec follows the Kubernetes `apiVersion/kind/metadata/spec` idiom:

```yaml
apiVersion: agentspec.io/v1    # always this value
kind: AgentSpec                 # always this value
metadata:
  name: my-agent                # required: slug (a-z, 0-9, -)
  version: 1.0.0                # required: semver
  description: "..."            # required
spec:
  model: ...                    # required: the LLM configuration
  prompts: ...                  # required: system prompt
  tools: ...                    # optional: function tools
  mcp: ...                      # optional: MCP servers
  memory: ...                   # optional: short/long-term/vector
  subagents: ...                # optional: sub-agent routing
  api: ...                      # optional: API exposure
  skills: ...                   # optional: AgentSkills
  guardrails: ...               # optional: input/output filters
  evaluation: ...               # optional: evaluation config
  observability: ...            # optional: tracing/metrics
  compliance: ...               # optional: compliance packs
  requires: ...                 # optional: runtime requirements
```

## Reference Syntax

Values can reference external resources using `$` prefixes:

| Syntax | Resolves to | Fails if missing |
|--------|-------------|-----------------|
| `$env:VAR_NAME` | Environment variable | Yes |
| `$secret:name` | Secret manager | Yes |
| `$file:path` | File relative to `agent.yaml` | Yes |
| `$func:now_iso` | Built-in function | Yes (unknown func) |

### Examples

```yaml
spec:
  model:
    apiKey: $env:GROQ_API_KEY              # env var
    apiKey: $secret:prod-groq-key          # secret manager

  prompts:
    system: $file:prompts/system.md        # file reference
    variables:
      - name: current_date
        value: "$func:now_iso"             # built-in function

  mcp:
    servers:
      - env:
          DATABASE_URL: $env:DATABASE_URL  # nested env ref
```

### Secret Backends

Configure the secret backend via `AGENTSPEC_SECRET_BACKEND` env var:

```bash
AGENTSPEC_SECRET_BACKEND=vault    # HashiCorp Vault
AGENTSPEC_SECRET_BACKEND=aws      # AWS Secrets Manager
AGENTSPEC_SECRET_BACKEND=gcp      # GCP Secret Manager
AGENTSPEC_SECRET_BACKEND=azure    # Azure Key Vault
AGENTSPEC_SECRET_BACKEND=env      # env vars (default)
```

In `env` mode, `$secret:my-key` maps to `AGENTSPEC_SECRET_MY_KEY` env var.

## Validation

AgentSpec validates manifests using a Zod schema. Every field is type-checked and constraints are enforced:

- `metadata.name` must match `/^[a-z0-9-]+$/`
- `metadata.version` must be semver (`1.0.0`)
- Model `parameters.temperature` must be `0..2`
- Tool names must be lowercase slugs

```bash
agentspec validate agent.yaml
```

## IDE Autocomplete

Add the JSON Schema to your editor for full autocomplete on `agent.yaml`:

**VSCode** — add to `.vscode/settings.json`:
```json
{
  "yaml.schemas": {
    "https://agentspec.io/schemas/v1/agent.schema.json": "agent.yaml"
  }
}
```

**Local schema** (after build):
```json
{
  "yaml.schemas": {
    "./schemas/v1/agent.schema.json": "agent.yaml"
  }
}
```

## Extending AGENTS.md

Reference your `agent.yaml` from `AGENTS.md`:

```markdown
## Agent Manifest
This project uses [AgentSpec](https://agentspec.io) for agent configuration.
See [agent.yaml](./agent.yaml) for the full manifest.

```bash
agentspec health   # Check runtime dependencies
agentspec audit    # Compliance report
```
```
