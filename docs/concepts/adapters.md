# Framework Adapters

Generate runnable, framework-specific agent code from a single `agent.yaml` manifest.

## Overview

An adapter reads your `agent.yaml` manifest and produces a complete, ready-to-run project for a target framework — source files, dependency lists, environment variable templates, and a README. You never write boilerplate by hand; the manifest is the source of truth.

---

## 1. How Generation Works

AgentSpec uses an **agentic generation** approach: your manifest JSON is sent to Claude together with a framework-specific *skill* file. Claude reasons over every manifest field and returns a complete file map as structured JSON.

```
agent.yaml
    │
    ▼
┌─────────────────────────────────┐
│  @agentspec/adapter-claude      │
│                                 │
│  loadSkill('langgraph')         │◄── src/skills/langgraph.md
│  buildContext(manifest)         │
│  claude.messages.create(...)    │
└─────────────────────────────────┘
    │
    ▼
{ files: { 'agent.py': '...', 'requirements.txt': '...', ... } }
    │
    ▼
agentspec generate --output ./generated/
```

This approach covers **all manifest fields** without exhaustive TypeScript templates. When the schema evolves, the skill file captures it in plain Markdown, not code.

### The skill file

Each framework is a single Markdown file in `packages/adapter-claude/src/skills/`:

```
src/skills/
├── langgraph.md   # Python LangGraph — complete field mapping guide
├── crewai.md      # Python CrewAI — crew.py, tools.py, guardrails.py
└── mastra.md      # TypeScript Mastra — src/agent.ts, src/tools.ts
```

Adding a new framework means writing one `.md` file — not a new TypeScript package. The file describes the output format, field mappings, and code patterns in natural language that Claude follows precisely.

### The GeneratedAgent output

All adapters, agentic or static, return the same `GeneratedAgent` shape from `@agentspec/sdk`:

```typescript
export interface GeneratedAgent {
  framework: string                 // which framework produced this
  files: Record<string, string>    // filename → file contents
  installCommands: string[]        // ordered setup commands
  envVars: string[]                // env vars the generated code requires
  readme: string                   // README contents
}
```

`files` is a flat map. Keys are output filenames and values are complete file contents. The CLI writes each key/value pair to `--output <dir>`.

---

## 2. Available Frameworks

| Framework | Language | Generated files | Status |
|-----------|----------|-----------------|--------|
| `langgraph` | Python | `agent.py`, `tools.py`, `guardrails.py`, `server.py`, `eval_runner.py`, `requirements.txt`, `.env.example`, `README.md` | Available |
| `crewai` | Python | `crew.py`, `tools.py`, `guardrails.py`, `requirements.txt`, `.env.example`, `README.md` | Available |
| `mastra` | TypeScript | `src/agent.ts`, `src/tools.ts`, `mastra.config.ts`, `package.json`, `.env.example`, `README.md` | Available |

Generate with any of them:

```bash
export ANTHROPIC_API_KEY=your-api-key-here
# Optional overrides
# export ANTHROPIC_MODEL=claude-sonnet-4-6          # default: claude-opus-4-6
# export ANTHROPIC_BASE_URL=https://my-proxy.example.com

agentspec generate agent.yaml --framework langgraph --output ./generated/
agentspec generate agent.yaml --framework crewai    --output ./generated/
agentspec generate agent.yaml --framework mastra    --output ./generated/
```

See the per-framework docs for generated file details:
- [LangGraph](../adapters/langgraph.md)
- [CrewAI](../adapters/crewai.md)
- [Mastra](../adapters/mastra.md)

---

## 3. Adding a New Framework

To add support for a new target framework, write a skill file:

```bash
# Create the skill
touch packages/adapter-claude/src/skills/autogen.md

# Rebuild to copy it to dist/
pnpm --filter @agentspec/adapter-claude build

# Use it immediately
agentspec generate agent.yaml --framework autogen
```

A skill file describes:
- **Output format** — the exact JSON shape Claude must return (files map + installCommands + envVars)
- **File map** — which files to generate and under what conditions
- **Manifest→code mappings** — tables mapping `agent.yaml` fields to framework-specific code patterns
- **Reference syntax resolution** — how to handle `$env:`, `$secret:`, `$file:`, `$func:` in the generated code
- **Quality checklist** — invariants Claude must verify before returning output

See `packages/adapter-claude/src/skills/langgraph.md` for a comprehensive reference implementation.

---

## 4. SDK FrameworkAdapter Interface

The `FrameworkAdapter` interface in `@agentspec/sdk` remains available for authors who want to write deterministic, static adapters:

```typescript
import { registerAdapter, type FrameworkAdapter } from '@agentspec/sdk'

const myAdapter: FrameworkAdapter = {
  framework: 'my-framework',
  version: '0.1.0',
  generate(manifest, options = {}) {
    return {
      framework: 'my-framework',
      files: {
        'agent.py': generateAgentPy(manifest),
        'requirements.txt': generateRequirementsTxt(manifest),
      },
      installCommands: ['pip install -r requirements.txt'],
      envVars: manifest.spec.requires?.envVars ?? [],
      readme: '...',
    }
  },
}

registerAdapter(myAdapter)
```

Static adapters are useful for:
- Deterministic output (no API call, no token cost)
- Offline environments
- Narrow/well-defined manifest subsets

The CLI uses `@agentspec/adapter-claude` directly and does not route through the registry. To use a custom static adapter programmatically:

```typescript
import '@agentspec/adapter-my-framework'
import { loadManifest, generateAdapter } from '@agentspec/sdk'

const { manifest } = loadManifest('./agent.yaml')
const result = generateAdapter(manifest, 'my-framework')
```

---

## 5. Field Mapping Reference

Every manifest field maps to a concept in generated code. Exact class names vary by framework; skill files contain the full per-framework tables.

| `agent.yaml` field | Generated code concept |
|--------------------|----------------------|
| `spec.model.provider` + `spec.model.id` | LLM client instantiation |
| `spec.model.apiKey` | `os.environ.get("VAR_NAME")` — never embedded as a literal |
| `spec.model.parameters.temperature` | LLM temperature setting |
| `spec.model.parameters.maxTokens` | LLM max tokens |
| `spec.model.fallback` | Fallback LLM chain |
| `spec.prompts.system` (`$file:`) | System prompt loaded from file at runtime |
| `spec.prompts.variables[]` | Prompt template variable injection |
| `spec.tools[]` | Tool functions bound to the LLM |
| `spec.memory.shortTerm.backend` | Memory / checkpointer backend |
| `spec.guardrails.input[]` | Input validation middleware |
| `spec.guardrails.output[]` | Output validation middleware |
| `spec.observability.tracing.backend` | Tracing / callback setup |
| `spec.evaluation.*` | Eval harness generation |
| `spec.api.*` | FastAPI / HTTP server generation |
| `spec.requires.envVars[]` | Startup env var validation |
| `spec.subagents[]` | Sub-agent invocation stubs |

### Reference prefix resolution

| Manifest value | Generated code |
|----------------|----------------|
| `$env:GROQ_API_KEY` | `os.environ.get("GROQ_API_KEY")` |
| `$secret:my-key` | `os.environ.get("AGENTSPEC_SECRET_MY_KEY")` |
| `$file:prompts/system.md` | Open the file at runtime |
| `$func:now_iso` | `datetime.utcnow().isoformat()` |

---

## See also

- [LangGraph adapter](../adapters/langgraph.md) — generated files and manifest mapping
- [CrewAI adapter](../adapters/crewai.md) — generated files and manifest mapping
- [Mastra adapter](../adapters/mastra.md) — generated files and manifest mapping
- [The agent.yaml manifest](./manifest.md) — manifest structure and reference syntax
- [agentspec generate CLI reference](../reference/cli.md)
