# CLAUDE.md — AgentSpec Project Guide

This file is read by Claude Code to understand the project structure, principles, and conventions.

---

## Project Vision

**AgentSpec** is the universal manifest standard for AI agents.
One `agent.yaml` file captures everything: model, memory, tools, MCP, prompts, guardrails, evaluation, observability, and compliance.

Three properties:
1. **Zero control plane** — just a file + SDK, no server required
2. **Extends existing standards** — MCP-compatible, AGENTS.md-compatible, A2A/AgentCard exportable
3. **Framework-agnostic** — generates LangGraph, CrewAI, Mastra, AutoGen code via adapters

---

## Repository Structure

```
agentspec/
├── packages/
│   ├── sdk/                    # @agentspec/sdk — core: load, health, audit, generate
│   │   └── src/
│   │       ├── schema/         # Zod schema (single source of truth)
│   │       ├── loader/         # YAML parser + $env/$secret/$file resolvers
│   │       ├── health/         # Health check engine
│   │       ├── audit/          # Compliance rules engine
│   │       └── generate/       # Adapter registry
│   ├── cli/                    # @agentspec/cli — agentspec CLI
│   │   └── src/commands/       # validate, health, audit, init, generate, export
│   └── adapter-langgraph/      # @agentspec/adapter-langgraph
│       └── src/generators/     # agent.py, requirements.txt, guardrails.py
├── schemas/v1/                 # agent.schema.json (IDE autocomplete)
├── examples/gymcoach/          # GymCoach migration example
├── docs/                       # Documentation site
└── CLAUDE.md                   # This file
```

---

## Design Principles

### 0. Thin orchestrator + named helpers (preferred style for all new code)

**This is the default way to write functions in this codebase.** Prefer many small, named functions over one large function — even before the code gets long.

When writing new code, decompose by intent first:
- If a block of logic has a name (even just in a comment), make it a function.
- Orchestrators read like a pipeline of named steps; they contain no implementation details.
- Helpers are pure or near-pure: explicit inputs, explicit output, no side effects on shared state.

**Rule**: if you can label a code block with a comment like `// Phase 3: score results`, that label is the function name — extract it.

**Template** (applied throughout this codebase):
```typescript
// ── Internal interfaces (module-private) ─────────────────────────────────────
interface PhaseAResult { ... }
interface PhaseBResult { ... }

// ── Private helpers ────────────────────────────────────────────────────────────
function phaseA(input: Input): PhaseAResult { ... }
function phaseB(intermediate: PhaseAResult): PhaseBResult { ... }
function phaseC(a: PhaseAResult, b: PhaseBResult): FinalResult { ... }

// ── Public orchestrator ────────────────────────────────────────────────────────
export function doThing(input: Input): FinalResult {
  const a = phaseA(input)
  const b = phaseB(a)
  return phaseC(a, b)
}
```

**Applied examples in this repo:**
| File | Orchestrator | Extracted helpers |
|------|-------------|-------------------|
| `sdk/src/audit/index.ts` | `runAudit()` | `resolveActiveRules` · `collectSuppressions` · `executeRuleChecks` · `computeScoring` · `computeProvedScore` |
| `sdk/src/health/index.ts` | `runHealthCheck()` | `runSubagentChecks` · `runEvalChecks` · `computeHealthStatus` |
| `cli/src/commands/audit.ts` | action closure | `fetchProofRecords` · `printScoreSummary` · `formatEvidenceBreakdown` |
| `cli/src/commands/generate.ts` | action closure | `validateFramework` · `handleK8sGeneration` · `handleLLMGeneration` · `writePushModeEnv` |
| `cli/src/commands/evaluate.ts` | action closure | `resolveChatEndpoint` · `runInference` · `determineCiGateExit` |
| `cli/src/commands/scan.ts` | action closure | `collectAndValidateSourceFiles` · `validateScanResponse` |
| `sdk/src/agent/reporter.ts` | `startPushMode()` | `_pushHeartbeat` (private method) |

**Helpers are always module-private** (not exported) unless reuse across files is proven necessary. Internal `interface` types for inter-helper data shapes are also module-private.

---

### 1. Zod as single source of truth
The `packages/sdk/src/schema/manifest.schema.ts` is the canonical definition.
- Types are inferred from Zod with `z.infer<>`
- JSON Schema for IDE autocomplete is exported from the same Zod schema
- Never manually maintain separate TypeScript types — derive them

### 2. SOLID
- **Single Responsibility**: each module does one thing (load, check, audit, generate)
- **Open/Closed**: new framework adapters = new package, no core changes
- **Liskov**: all `FrameworkAdapter` implementations are interchangeable
- **Interface Segregation**: `HealthCheck`, `AuditRule`, `FrameworkAdapter` are minimal interfaces
- **Dependency Inversion**: core SDK depends on abstractions, not concrete adapters

### 3. TDD — tests first
Write tests before implementation:
1. Write a failing test in `src/__tests__/`
2. Implement the minimum code to pass
3. Refactor

Run tests: `pnpm test` (workspace-level)

### 4. No runtime magic
All references (`$env:`, `$secret:`, `$file:`, `$func:`) are resolved explicitly via `resolveRef()`.
No implicit global state. No singletons. No hidden configuration.

### 5. Fail fast and clearly
- Missing env vars → throw with clear remediation message
- Invalid manifest → ZodError with path and fix suggestion
- Missing adapter → throw with install command

### 6. Reference syntax (do not change)
| Syntax | Meaning |
|--------|---------|
| `$env:VAR` | Env var (fails if missing by default) |
| `$secret:name` | Secret manager (Vault/AWS/GCP/Azure) |
| `$file:path` | File relative to agent.yaml |
| `$func:now_iso` | Built-in function |

### 7. agent.yaml is the spec; the SDK makes it live-verifiable (core principle)

The `agent.yaml` is the **single source of truth** for everything an agent declares:
model, tools, services, memory, guardrails, evaluation, subagents.

Agents that integrate `@agentspec/sdk` expose a standard introspection endpoint:

  GET /agentspec/health  →  HealthReport (live runtime state)

The **sidecar** discovers this endpoint and bridges the gap between the declared spec and
runtime reality across all diagnostic endpoints:

  /health/ready  — manifest + live checks merged
  /explore       — runtime capabilities (live tool/service/model status)
  /gap           — manifest declarations vs runtime reality (the delta)

Agents that do NOT integrate the SDK continue to work: the sidecar falls back to
static manifest analysis. Live SDK data is always preferred when available.

**Core invariant**: a user should be able to answer these questions from the sidecar alone:
- Is the agent healthy? (all declared dependencies reachable, model key valid)
- What can it do? (declared tools + their live registration status)
- What is wrong? (gap between spec and runtime, with remediation)

---

## Adding a New Framework Adapter

To add a new adapter (e.g. CrewAI):

1. Create `packages/adapter-crewai/`
2. Implement `FrameworkAdapter` interface from `@agentspec/sdk`
3. Call `registerAdapter(adapter)` at module load (side-effect import)
4. Export from `src/index.ts`
5. Users install it and import it before calling `generateAdapter()`

The adapter MUST produce valid, runnable code from the manifest fields.

**When using Claude Code to generate an adapter:**
- Read the manifest schema at `packages/sdk/src/schema/manifest.schema.ts`
- Map `spec.model.provider` → the framework's LLM class
- Map `spec.tools[]` → the framework's tool format
- Map `spec.memory` → the framework's memory/checkpointer
- Map `spec.guardrails` → input/output validation middleware
- Always generate `requirements.txt` / `package.json` and `.env.example`

---

## Compliance Rule Packs

Rules live in `packages/sdk/src/audit/rules/`:
- `model.rules.ts` — model resilience (fallback, version pinning, cost controls)
- `security.rules.ts` — OWASP LLM Top 10
- `memory.rules.ts` — memory hygiene (PII scrub, TTL, audit log)
- `evaluation.rules.ts` — evaluation coverage

To add a new rule:
1. Add to the appropriate rules file
2. Implement the `AuditRule` interface
3. Add to the pack name in `AuditRule.pack`
4. Write a test in `sdk/src/__tests__/audit.test.ts`

---

## Health Check Categories

Checks live in `packages/sdk/src/health/checks/`:
- `env.check.ts` — env var presence + file refs
- `model.check.ts` — model API HTTP reachability
- `mcp.check.ts` — MCP server connectivity
- `memory.check.ts` — Redis/Postgres TCP connectivity
- `service.check.ts` — `spec.requires.services` TCP port reachability (no driver deps, uses `net.createConnection`)

The `HealthCheck.category` union type (`packages/sdk/src/health/index.ts`) supports:

| Category | Source | Description |
|---|---|---|
| `env` | SDK | Env var presence checks |
| `file` | SDK | File ref resolution checks |
| `model` | SDK | Model API HTTP reachability |
| `model-fallback` | SDK | Fallback model reachability |
| `mcp` | SDK | MCP server connectivity |
| `memory` | SDK | Memory backend TCP checks |
| `subagent` | SDK | Sub-agent file/A2A checks |
| `eval` | SDK | Eval dataset file checks |
| `service` | SDK | `spec.requires.services` TCP connectivity |
| `tool` | Reporter | Registered tool handler availability (agent-side) |

To add a new check category:
1. Create `packages/sdk/src/health/checks/<category>.check.ts`
2. Export an `async run<Category>Checks()` function returning `HealthCheck[]`
3. Import and call in `packages/sdk/src/health/index.ts`

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `agentspec validate <file>` | Schema validation only (no I/O) |
| `agentspec health <file>` | Runtime health checks |
| `agentspec audit <file>` | Compliance scoring |
| `agentspec init [dir]` | Interactive manifest wizard |
| `agentspec generate <file> --framework <fw>` | Code generation |
| `agentspec export <file> --format agentcard` | Export to A2A/AgentCard |

---

## Tech Stack

| Concern | Tool |
|---------|------|
| Language | TypeScript (Node 20+) |
| Monorepo | pnpm workspaces |
| Schema | Zod v3 |
| YAML | js-yaml |
| CLI framework | commander + @clack/prompts |
| Build | tsup |
| Testing | vitest |
| HTTP | native fetch (Node 18+) |

---

## Key Files

| File | Purpose |
|------|---------|
| `packages/sdk/src/schema/manifest.schema.ts` | Zod schema — single source of truth |
| `packages/sdk/src/loader/resolvers.ts` | $env/$secret/$file/$func resolution |
| `packages/sdk/src/health/index.ts` | Health check orchestrator |
| `packages/sdk/src/audit/index.ts` | Audit rules engine |
| `packages/sdk/src/generate/index.ts` | Adapter registry |
| `packages/adapter-langgraph/src/index.ts` | LangGraph adapter (auto-registers) |
| `packages/cli/src/cli.ts` | CLI entrypoint |
| `examples/gymcoach/agent.yaml` | Full GymCoach manifest example |

---

## Generating Adapters with Claude Code

Claude Code can generate a new framework adapter from scratch.
Provide this prompt:

> Generate a `@agentspec/adapter-<framework>` package for AgentSpec.
> Read the manifest schema at `packages/sdk/src/schema/manifest.schema.ts`.
> Follow the same pattern as `packages/adapter-langgraph/src/index.ts`.
> Generate files: `agent.py` (or equivalent), `requirements.txt`, `.env.example`.
> Map all manifest fields: model, tools, memory, guardrails, observability.
> Auto-register with `registerAdapter()` on import.

The SDK's `CLAUDE.md` (in `packages/sdk/`) has detailed adapter generation instructions.
