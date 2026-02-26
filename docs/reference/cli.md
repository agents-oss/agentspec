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

Generate framework-specific agent code.

```bash
agentspec generate <file> --framework <fw> --output <dir>
agentspec generate agent.yaml --framework langgraph --output ./generated/
agentspec generate agent.yaml --framework langgraph --dry-run
```

Options:
- `--framework <fw>` — **required**: langgraph | crewai | mastra | autogen
- `--output <dir>` — output directory (default: `./generated`)
- `--dry-run` — print files without writing

Requires the corresponding adapter package to be installed.

## `agentspec export`

Export manifest to other formats.

```bash
agentspec export <file> --format agentcard
agentspec export <file> --format agents-md-block
```

Options:
- `--format agentcard` — Google A2A/AgentCard JSON
- `--format agents-md-block` — AGENTS.md reference block (markdown)

## `agentspec migrate`

*(Coming soon)* Migrate manifest to latest schema version.

```bash
agentspec migrate agent.yaml
```
