# CLI Reference

All AgentSpec CLI commands. Run via `npx agentspec` or install globally: `npm i -g @agentspec/cli`.

## `agentspec init`

Interactive wizard to create `agent.yaml`.

```bash
agentspec init [dir]
```

Options:
- `--yes` — skip prompts, create a minimal manifest

## `agentspec validate`

Validate manifest schema. No I/O — safe for pre-commit hooks.

```bash
agentspec validate <file>
agentspec validate agent.yaml --json
```

Options:
- `--json` — output validation result as JSON

Exit codes: `0` = valid, `1` = invalid

## `agentspec health`

Runtime health checks — calls external services.

```bash
agentspec health <file>
agentspec health agent.yaml --json
agentspec health agent.yaml --fail-on warning    # exit 1 on warnings
agentspec health agent.yaml --no-model           # skip model API check
agentspec health agent.yaml --no-mcp             # skip MCP checks
agentspec health agent.yaml --no-memory          # skip memory checks
```

Options:
- `--json` — output as JSON
- `--format json|table` — output format (default: table)
- `--fail-on error|warning|info` — exit 1 threshold (default: error)
- `--no-model` — skip model API reachability
- `--no-mcp` — skip MCP server checks
- `--no-memory` — skip memory backend checks

Exit codes: `0` = healthy/degraded (by default), `1` = fails `--fail-on` threshold

## `agentspec audit`

Compliance audit against configured packs.

```bash
agentspec audit <file>
agentspec audit agent.yaml --pack owasp-llm-top10
agentspec audit agent.yaml --json --output report.json
agentspec audit agent.yaml --fail-below 70
```

Options:
- `--pack <pack>` — run only this pack
- `--json` — output as JSON
- `--output <file>` — write JSON report to file
- `--fail-below <score>` — exit 1 if score < threshold

Exit codes: `0` = audit complete (check score), `1` = below threshold

## `agentspec generate`

Generate framework-specific agent code using Claude.

```bash
agentspec generate <file> --framework <fw> --output <dir>
agentspec generate agent.yaml --framework langgraph --output ./generated/
agentspec generate agent.yaml --framework crewai --output ./generated/
agentspec generate agent.yaml --framework langgraph --dry-run
```

Options:
- `--framework <fw>` — **required**: `langgraph` | `crewai` | `mastra`
- `--output <dir>` — output directory (default: `./generated`)
- `--dry-run` — print files without writing
- `--deploy <target>` — also generate deployment manifests: `k8s` | `helm`
- `--push` — write `.env.agentspec` with push mode env var placeholders (`AGENTSPEC_URL`, `AGENTSPEC_KEY`)

**Requires `ANTHROPIC_API_KEY`** — generation uses Claude to reason over every manifest field
and produce complete, production-ready code. Get a key at [console.anthropic.com](https://console.anthropic.com).

```bash
export ANTHROPIC_API_KEY=your-api-key-here
agentspec generate agent.yaml --framework langgraph
```

**Optional env vars:**

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-opus-4-6` | Claude model used for generation |
| `ANTHROPIC_BASE_URL` | Anthropic API | Custom proxy or private endpoint |

```bash
# Use a faster/cheaper model
export ANTHROPIC_MODEL=claude-sonnet-4-6
# Route through a proxy
export ANTHROPIC_BASE_URL=https://my-proxy.example.com

agentspec generate agent.yaml --framework langgraph
```

### `--deploy k8s`

Generates plain Kubernetes manifests alongside (or instead of) framework code. **Does not require `ANTHROPIC_API_KEY`** — output is deterministic.

```bash
# Framework code + k8s manifests in one pass
agentspec generate agent.yaml --framework langgraph --deploy k8s

# k8s only (no framework code)
agentspec generate agent.yaml --framework langgraph --deploy k8s --output ./k8s-out/
```

Files written under `<output>/k8s/`:

| File | Contents |
|------|----------|
| `k8s/deployment.yaml` | Agent container + `agentspec-sidecar` sidecar (ports 4000/4001) |
| `k8s/service.yaml` | ClusterIP exposing agent, proxy (4000), and control (4001) ports |
| `k8s/configmap.yaml` | Non-secret config: `AGENT_NAME`, `MODEL_PROVIDER`, `MODEL_ID` |
| `k8s/secret.yaml.example` | Template listing every `$env:` ref — fill with real values and apply separately |

```bash
# Apply to a cluster
kubectl apply -f ./generated/k8s/configmap.yaml
# Fill in real values first:
cp ./generated/k8s/secret.yaml.example ./generated/k8s/secret.yaml
# Edit secret.yaml with base64-encoded values, then:
kubectl apply -f ./generated/k8s/secret.yaml
kubectl apply -f ./generated/k8s/deployment.yaml
kubectl apply -f ./generated/k8s/service.yaml
```

### `--deploy helm`

Generates a full Helm chart using Claude. **Requires `ANTHROPIC_API_KEY`.**

```bash
agentspec generate agent.yaml --framework langgraph --deploy helm
```

Writes a complete Helm chart (Chart.yaml, values.yaml, templates/, \_helpers.tpl, README.md) alongside the framework code. The chart always includes `agentspec-sidecar` as a sidecar container.

```bash
helm install my-agent ./generated/ -f generated/values.yaml
```

Exit codes: `0` = files written, `1` = unknown framework/deploy target, missing API key, or generation error.

## `agentspec export`

Export manifest to other formats.

```bash
agentspec export <file> --format agentcard
agentspec export <file> --format agents-md-block
```

Options:
- `--format agentcard` — Google A2A/AgentCard JSON
- `--format agents-md-block` — AGENTS.md reference block (markdown)

## `agentspec scan`

Scan a source directory and generate an `agent.yaml` manifest using Claude.

```bash
agentspec scan --dir ./src/
agentspec scan --dir ./src/ --out agent.yaml        # explicit output path
agentspec scan --dir ./src/ --update                # overwrite existing agent.yaml
agentspec scan --dir ./src/ --dry-run               # print to stdout, don't write
```

Options:
- `--dir <path>` — **required**: source directory to scan
- `--out <path>` — explicit output path (default: `./agent.yaml` or `./agent.yaml.new`)
- `--update` — overwrite existing `agent.yaml` in place (default: writes `agent.yaml.new`)
- `--dry-run` — print generated YAML to stdout without writing any file

**Output path logic:**

| Situation | File written |
|-----------|-------------|
| No existing `agent.yaml` | `agent.yaml` |
| Existing `agent.yaml`, no `--update` | `agent.yaml.new` (original untouched) |
| Existing `agent.yaml` + `--update` | `agent.yaml` (overwritten) |
| `--out <path>` | that path, always |
| `--dry-run` | stdout only |

**What Claude detects:**

| Pattern in source | Manifest field |
|-------------------|---------------|
| `import openai` / `ChatOpenAI(model=…)` | `spec.model.provider`, `spec.model.name` |
| `os.getenv("OPENAI_API_KEY")` | `spec.model.apiKey: $env:OPENAI_API_KEY` |
| `@tool` decorator, `Tool(name=…)` | `spec.tools[]` |
| `MCPClient(…)` config | `spec.mcp[]` |
| Content filter / rate limiter import | `spec.guardrails.*` |
| `import deepeval` / `import pytest` | `spec.eval.hooks[]` |
| Redis / Postgres / vector store import | `spec.memory.backend` |

Scans `.py`, `.ts`, `.js`, `.mjs`, `.cjs` files only. Excludes `node_modules/`, `.git/`, `dist/`, `.venv/` and other non-user directories. Caps at **50 files** and **200 KB** of source content per scan.

**Requires `ANTHROPIC_API_KEY`.**

```bash
export ANTHROPIC_API_KEY=your-api-key-here
agentspec scan --dir ./src/ --dry-run   # preview before writing
agentspec scan --dir ./src/             # write agent.yaml
```

Exit codes: `0` = manifest written, `1` = API key missing or generation error.

## `agentspec diff`

Detect compliance drift between two `agent.yaml` manifests. Deterministic — no LLM required.

```bash
agentspec diff agent.yaml agent.yaml.new
agentspec diff agent.yaml agent.yaml.new --json        # machine-readable output
agentspec diff agent.yaml agent.yaml.new --exit-code   # exit 1 if drift detected
```

Options:
- `--json` — output diff result as JSON (useful for CI)
- `--exit-code` — exit with code `1` if any changes are detected

**Human-readable output:**

```
agentspec diff — compliance drift analysis
══════════════════════════════════════════════════════
  Comparing: agent.yaml → agent.yaml.new

  REMOVED  spec.guardrails.content_filter         [-15 score]  HIGH
           Content filtering removed — user input reaches model unfiltered

  ADDED    spec.tools.0.name                      [+0 score]   LOW
           New tool added — verify it does not expose sensitive data

  Net score change:  -15  (100 → 85, A → B)

  Recommendation: restore spec.guardrails.content_filter before deploying
══════════════════════════════════════════════════════
```

**JSON output schema (`--json`):**

```json
{
  "from": "agent.yaml",
  "to": "agent.yaml.new",
  "scoreFrom": 100,
  "scoreTo": 85,
  "gradeFrom": "A",
  "gradeTo": "B",
  "netScoreChange": -15,
  "changes": [
    {
      "type": "removed",
      "property": "spec.guardrails.content_filter",
      "severity": "HIGH",
      "scoreImpact": -15,
      "description": "Content filtering removed — user input reaches model unfiltered"
    }
  ]
}
```

> **Score note:** `scoreFrom` is always `100` (relative baseline). The diff measures *drift magnitude*, not absolute compliance. Run `agentspec audit` on each file for absolute scores.

**Severity levels:**

| Severity | Examples | Score impact |
|----------|----------|-------------|
| `HIGH` | Guardrail removed, API key reference removed | −10 to −15 |
| `MEDIUM` | Model name/provider changed, eval hooks removed | −5 to −8 |
| `LOW` | New tool added, observability removed | 0 to −3 |

Exit codes: `0` = no drift (or drift without `--exit-code`), `1` = drift detected with `--exit-code`

## `agentspec migrate`

*(Coming soon)* Migrate manifest to latest schema version.

```bash
agentspec migrate agent.yaml
```
