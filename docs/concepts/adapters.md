# Framework Adapters

Generate runnable, framework-specific agent code from a single `agent.yaml` manifest.

## Overview

An adapter reads your `agent.yaml` manifest and produces a complete, ready-to-run project for a target framework — Python files, dependency lists, environment variable templates, and a README. You never write boilerplate by hand; the manifest is the source of truth and the adapter does the translation.

---

## 1. How Adapters Work

### The FrameworkAdapter interface

Every adapter implements the `FrameworkAdapter` interface exported from `@agentspec/sdk`:

```typescript
export interface FrameworkAdapter<TOptions = unknown> {
  framework: string                                              // e.g. 'langgraph'
  version: string                                               // adapter semver
  generate(manifest: AgentSpecManifest, options?: TOptions): GeneratedAgent
}
```

The `generate()` method receives the fully-loaded and reference-resolved manifest and returns a `GeneratedAgent` object.

### The GeneratedAgent output

```typescript
export interface GeneratedAgent {
  framework: string                 // which framework produced this
  files: Record<string, string>    // filename → file contents
  installCommands: string[]        // ordered shell commands to set up
  envVars: string[]                // env vars the generated code expects
  readme: string                   // setup and usage instructions
}
```

`files` is a flat map. Keys are the output filenames (`agent.py`, `requirements.txt`, `.env.example`, etc.) and values are the complete file contents as strings. The CLI writes each key/value pair to `--output <dir>`.

### The registry pattern

Adapters self-register by calling `registerAdapter()` as a side-effect of being imported. The core SDK never needs to know which adapters exist at build time.

```typescript
// Inside @agentspec/adapter-langgraph/src/index.ts
import { registerAdapter } from '@agentspec/sdk'

const langGraphAdapter: FrameworkAdapter = { /* ... */ }

registerAdapter(langGraphAdapter)   // <-- side-effect registration
```

When you call `generateAdapter()`, it looks up the adapter by name in the registry:

```typescript
import '@agentspec/adapter-langgraph'  // registers on import
import { loadManifest, generateAdapter } from '@agentspec/sdk'

const { manifest } = loadManifest('./agent.yaml')
const result = generateAdapter(manifest, 'langgraph')

// result.files => { 'agent.py': '...', 'requirements.txt': '...', ... }
// result.installCommands => ['python -m venv .venv', 'pip install -r requirements.txt', ...]
```

If you call `generateAdapter()` for a framework whose adapter is not registered, the error message includes the exact install command:

```
No adapter registered for framework: crewai
  Available: langgraph
  Install an adapter package, e.g: npm install @agentspec/adapter-crewai
```

### Registry introspection

```typescript
import { listAdapters, getAdapter } from '@agentspec/sdk'

listAdapters()              // => ['langgraph']
getAdapter('langgraph')     // => FrameworkAdapter | undefined
```

---

## 2. Available Adapters

| Package | Framework | Language | Status |
|---------|-----------|----------|--------|
| `@agentspec/adapter-langgraph` | [LangGraph](../adapters/langgraph.md) | Python | Available |
| `@agentspec/adapter-crewai` | CrewAI | Python | Planned |
| `@agentspec/adapter-mastra` | Mastra | TypeScript | Planned |
| `@agentspec/adapter-autogen` | AutoGen | Python | Planned |

Install an available adapter:

```bash
npm install @agentspec/adapter-langgraph
```

Generate code with the CLI:

```bash
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
```

See [LangGraph adapter docs](../adapters/langgraph.md) for the full field mapping and generated file reference.

---

## 3. Generating Adapters with Agentic IDEs

New adapters can be generated automatically by agentic IDEs — Claude Code, Cursor (Composer), and GitHub Copilot (agent mode) — without writing adapter logic by hand.

### How it works

The AgentSpec repository embeds `CLAUDE.md` files that teach agentic IDEs the exact patterns, field mappings, and conventions needed to produce a correct adapter:

- `CLAUDE.md` at the repo root — project structure, design principles, and the adapter generation prompt
- `packages/sdk/CLAUDE.md` — detailed field mapping tables, provider-to-package mappings, memory backend mappings, guardrail generation rules, and a complete `agent.py` example

When your IDE reads these files (which happens automatically with Claude Code's `claude` command, Cursor's Composer, or Copilot's agent mode), it has everything it needs to generate a fully working adapter package from scratch.

### The prompt to use

Open your agentic IDE in the AgentSpec repo root and run:

```
Generate a @agentspec/adapter-crewai package for AgentSpec.
Read the manifest schema at packages/sdk/src/schema/manifest.schema.ts.
Follow the same pattern as packages/adapter-langgraph/src/index.ts.
Generate files: agent.py, requirements.txt, .env.example.
Map all manifest fields: model, tools, memory, guardrails, observability.
Auto-register with registerAdapter() on import.
```

Substitute `crewai` for whatever framework you need (`mastra`, `autogen`, `dspy`, etc.).

### What the IDE generates

The IDE reads the Zod schema for the full manifest type, studies the LangGraph adapter as a reference implementation, reads the field mapping tables in `packages/sdk/CLAUDE.md`, and produces:

- `packages/adapter-<framework>/src/index.ts` — adapter entry point with `registerAdapter()` call
- `packages/adapter-<framework>/src/generators/agent-py.ts` (or equivalent) — code generator functions
- `packages/adapter-<framework>/package.json` — package manifest
- `packages/adapter-<framework>/tsconfig.json` — TypeScript config

The generated adapter immediately works with `generateAdapter(manifest, '<framework>')`.

### Compatible tools

| Tool | How to invoke |
|------|---------------|
| Claude Code | Run `claude` in the repo root, paste the prompt |
| Cursor Composer | Open Composer (Cmd+I), paste the prompt |
| GitHub Copilot | Enable agent mode in VS Code, paste the prompt |

---

## 4. Implementing an Adapter Manually

If you prefer to write an adapter by hand, follow this pattern.

### 1. Create the package

```
packages/adapter-<framework>/
├── src/
│   ├── index.ts            # entry point: adapter + registerAdapter()
│   └── generators/
│       ├── agent-py.ts     # generates main agent file
│       ├── requirements-txt.ts
│       └── env-example.ts
├── package.json
└── tsconfig.json
```

### 2. Implement the FrameworkAdapter interface

```typescript
import {
  registerAdapter,
  type FrameworkAdapter,
  type GeneratedAgent,
  type AgentSpecManifest,
} from '@agentspec/sdk'

export interface MyFrameworkAdapterOptions {
  includeDockerfile?: boolean   // example adapter-specific option
}

const myFrameworkAdapter: FrameworkAdapter<MyFrameworkAdapterOptions> = {
  framework: 'my-framework',
  version: '0.1.0',

  generate(
    manifest: AgentSpecManifest,
    options: MyFrameworkAdapterOptions = {},
  ): GeneratedAgent {
    const files: Record<string, string> = {}

    files['agent.py'] = generateAgentPy(manifest)
    files['requirements.txt'] = generateRequirementsTxt(manifest)
    files['.env.example'] = generateEnvExample(manifest)

    // Optional files based on adapter options
    if (options.includeDockerfile) {
      files['Dockerfile'] = generateDockerfile(manifest)
    }

    files['README.md'] = generateReadme(manifest)

    return {
      framework: 'my-framework',
      files,
      installCommands: [
        'python -m venv .venv',
        'source .venv/bin/activate',
        'pip install -r requirements.txt',
        'cp .env.example .env',
      ],
      envVars: manifest.spec.requires?.envVars ?? [],
      readme: files['README.md']!,
    }
  },
}

// Side-effect registration — must be at module top level
registerAdapter(myFrameworkAdapter)

export { myFrameworkAdapter }
```

### 3. The generate() method contract

- `manifest` is already loaded and all references (`$env:`, `$secret:`, `$file:`, `$func:`) are resolved. Read values directly off `manifest.spec.*`.
- Return every file the user needs to run the agent. Do not write files yourself — return them in `files` and let the CLI write them.
- `installCommands` are printed in order after generation. Put them in the sequence a developer would run them.
- `envVars` should list every env var the generated code reads at runtime, so the CLI can validate them with `agentspec health`.
- `readme` should be the contents of the README file the agent needs — the CLI also prints it to stdout.

### 4. Register the adapter as a side-effect import

Users install and activate the adapter with a single import:

```typescript
import '@agentspec/adapter-my-framework'  // registers the adapter
import { generateAdapter } from '@agentspec/sdk'

const result = generateAdapter(manifest, 'my-framework')
```

There is no explicit registration step for the user — the `registerAdapter()` call inside your `index.ts` fires automatically when the module is imported.

---

## 5. Field Mapping Guide

Use this table when writing generator functions. Every manifest field maps to a concept in the generated code. Exact class names vary by framework; see `packages/sdk/CLAUDE.md` for provider-specific package and class names.

| `agent.yaml` field | Generated code concept |
|--------------------|----------------------|
| `spec.model.provider` + `spec.model.id` | LLM client instantiation |
| `spec.model.apiKey` (strip `$env:` prefix) | `os.environ.get("VAR_NAME")` |
| `spec.model.parameters.temperature` | LLM temperature setting |
| `spec.model.parameters.maxTokens` | LLM max tokens / `max_tokens` |
| `spec.model.fallback` | Fallback LLM with `triggerOn` conditions |
| `spec.prompts.system` (strip `$file:` prefix) | System prompt loaded from file at runtime |
| `spec.prompts.variables[]` | Prompt template variable injection |
| `spec.tools[]` | Registered tool functions bound to the LLM |
| `spec.tools[].annotations.destructiveHint` | Confirmation step before destructive calls |
| `spec.memory.shortTerm.backend` | Memory / checkpointer backend |
| `spec.memory.shortTerm.connection` (strip `$env:`) | Connection string for Redis/Postgres/SQLite |
| `spec.guardrails.input[]` | Input validation middleware (`run_input_guardrails()`) |
| `spec.guardrails.output[]` | Output validation middleware (`run_output_guardrails()`) |
| `spec.observability.tracing.backend` | Observability / tracing setup |
| `spec.observability.tracing.sampleRate` | Trace sample rate |
| `spec.evaluation.framework` | Evaluation framework import and config |
| `spec.requires.envVars[]` | Variables listed in `envVars` output and `.env.example` |
| `spec.api.port` | Server port (when generating an API wrapper) |
| `spec.api.pathPrefix` | API route prefix |

### Reference prefix stripping

Before using a manifest value in generated code, strip the reference prefix:

| Manifest value | Generated code |
|----------------|----------------|
| `$env:GROQ_API_KEY` | `os.environ.get("GROQ_API_KEY")` |
| `$secret:my-key` | `os.environ.get("AGENTSPEC_SECRET_MY_KEY")` |
| `$file:prompts/system.md` | `"prompts/system.md"` (open at runtime) |
| `$func:now_iso` | `datetime.utcnow().isoformat()` |

### Guardrail type mapping

| `spec.guardrails.*.type` | What to generate |
|--------------------------|-----------------|
| `topic-filter` | Keyword / regex check before sending to the LLM |
| `prompt-injection` | Call a detection library (e.g. Rebuff, Lakera Guard) |
| `pii-detector` | Call a PII library (e.g. Microsoft Presidio) |
| `toxicity-filter` | Call a toxicity model (e.g. OpenAI Moderation API) |
| `hallucination-detector` | Compare output against context with an evaluator |

Always generate guardrails in a separate `guardrails.py` file with TODO comments pointing to the integration library, so the generated code compiles immediately and the user can fill in the library calls.

---

## See also

- [LangGraph adapter](../adapters/langgraph.md) — full generated file reference and manifest mapping
- [The agent.yaml manifest](./manifest.md) — manifest structure and reference syntax
- [agentspec generate CLI reference](../reference/cli.md)
- [packages/sdk/CLAUDE.md](https://github.com/agents-oss/agentspec/blob/main/packages/sdk/CLAUDE.md) — detailed adapter generation guide for agentic IDEs
