# AgentSpec → Mastra Generation Skill

You are generating production-ready TypeScript Mastra agent code from an AgentSpec manifest JSON.

## Output Format

Return a single JSON object (wrapped in ```json ... ```) with this exact shape:

```json
{
  "files": {
    "src/agent.ts": "...",
    "src/tools.ts": "...",
    "mastra.config.ts": "...",
    "package.json": "...",
    ".env.example": "...",
    "README.md": "..."
  },
  "installCommands": [
    "npm install",
    "cp .env.example .env"
  ],
  "envVars": ["OPENAI_API_KEY", "LANGFUSE_PUBLIC_KEY"]
}
```

**File generation rules:**
| File | When to generate |
|---|---|
| `src/agent.ts` | Always |
| `src/tools.ts` | When `spec.tools` is non-empty |
| `mastra.config.ts` | Always |
| `package.json` | Always |
| `.env.example` | Always |
| `README.md` | Always |

**Invariants:**
- Map **every** manifest field. Do not skip sections.
- All string values embedded in TypeScript code must be properly escaped.
- Never embed literal API keys — always use `process.env.VAR_NAME`.
- Validate required env vars at startup with a `validateEnv()` function.

---

## Reference Syntax Resolution

Resolve `$ref` values before generating TypeScript:

| Manifest reference | TypeScript |
|---|---|
| `$env:VAR_NAME` | `process.env.VAR_NAME` |
| `$env:VAR_NAME` (required) | `process.env.VAR_NAME` — list in `REQUIRED_ENV_VARS` |
| `$secret:secret-name` | `process.env.AGENTSPEC_SECRET_SECRET_NAME` — transform: uppercase, `-` → `_`, prefix `AGENTSPEC_SECRET_` |
| `$file:path/to/file` | `fs.readFileSync(path.join(__dirname, 'path/to/file'), 'utf-8')` |
| `$func:now_iso` | `new Date().toISOString()` |

Examples:
- `$secret:langfuse-secret-key` → `process.env.AGENTSPEC_SECRET_LANGFUSE_SECRET_KEY`
- `$env:OPENAI_API_KEY` → `process.env.OPENAI_API_KEY`

---

## Mapping Rules

### spec.model — AI SDK provider

| Manifest field | TypeScript |
|---|---|
| `provider: openai` | `import { openai } from '@ai-sdk/openai'` |
| `provider: anthropic` | `import { anthropic } from '@ai-sdk/anthropic'` |
| `provider: google` | `import { google } from '@ai-sdk/google'` |
| `provider: groq` | `import { createGroq } from '@ai-sdk/groq'` |
| `provider: mistral` | `import { mistral } from '@ai-sdk/mistral'` |
| `id` | First argument to provider function: `openai('gpt-4o')` |
| `parameters.temperature` | `temperature: N` in `generate` / agent options |
| `parameters.maxTokens` | `maxTokens: N` in generate options |
| `apiKey: $env:VAR` | `apiKey: process.env.VAR` in provider factory options |

### spec.prompts

```typescript
import * as fs from 'fs'
import * as path from 'path'

function loadSystemPrompt(): string {
  try {
    const template = fs.readFileSync(
      path.join(__dirname, '../prompts/system.md'),
      'utf-8'
    )
    const variables: Record<string, string> = {
      unit_system: process.env.UNIT_SYSTEM ?? '',
      current_date: new Date().toISOString(),
    }
    return Object.entries(variables).reduce(
      (t, [k, v]) => t.replaceAll(`{{ ${k} }}`, v),
      template
    )
  } catch {
    return "I'm experiencing difficulties. Please try again."
  }
}
```

For `hotReload: true` — call `loadSystemPrompt()` on every agent invocation (no module-level caching).

### spec.tools — src/tools.ts

```typescript
import { createTool } from '@mastra/core'
import { z } from 'zod'

export const logWorkout = createTool({
  id: 'log_workout',
  description: 'Log a completed training session with exercises, sets, reps, and duration',
  inputSchema: z.object({
    input: z.string().describe('Tool input'),
  }),
  execute: async ({ context }) => {
    throw new Error('Implement logWorkout')
  },
})

export const getWorkoutHistory = createTool({
  id: 'get_workout_history',
  description: 'Retrieve past training sessions with optional filters',
  inputSchema: z.object({
    input: z.string().describe('Tool input'),
  }),
  execute: async ({ context }) => {
    throw new Error('Implement getWorkoutHistory')
  },
})
```

Rules:
- Tool `id`: `tool.function` if set, otherwise `snake_case(tool.name)`
- Export name: `camelCase(tool.name)`
- `description`: `tool.description`
- `execute` body: `throw new Error('Implement {camelCaseName}')`
- Input schema: `z.object({ input: z.string() })` as a sensible default

**src/agent.ts imports tools:**
```typescript
import { logWorkout, getWorkoutHistory } from './tools.js'
const tools = { logWorkout, getWorkoutHistory }
```

### spec.memory

```typescript
import { Memory } from '@mastra/core/memory'
import { LibSQLStore } from '@mastra/libsql'

const memory = new Memory({
  storage: new LibSQLStore({
    url: process.env.LIBSQL_URL ?? 'file:./agent.db',
  }),
})
```

Pass to agent: `new Agent({ ..., memory })`.

For `spec.memory.shortTerm.backend = "redis"`:
```typescript
// Redis-backed memory: configure REDIS_URL for Mastra's KV store
// See Mastra docs for RedisStore integration
```

### spec.observability

For Langfuse:
```typescript
// ── Tracing: Langfuse ─────────────────────────────────────────────────────────
// Mastra supports OpenTelemetry natively in mastra.config.ts
// Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY for automatic tracing
```

In `mastra.config.ts`:
```typescript
import { Mastra } from '@mastra/core'

export const mastra = new Mastra({
  agents: { myAgent },
  telemetry: {
    serviceName: '{service_name}',  // from spec.observability.serviceName
    enabled: true,
  },
})
```

### spec.requires

```typescript
const REQUIRED_ENV_VARS = ['OPENAI_API_KEY']  // from spec.requires.envVars[]

function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter(v => !process.env[v])
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill in the values.'
    )
  }
}

validateEnv()
```

---

## Complete src/agent.ts Structure

Generate sections in this exact order:

1. **Imports**:
   - `import { Agent } from '@mastra/core'`
   - `import { Memory } from '@mastra/core/memory'` (if `spec.memory` is set)
   - `import { LibSQLStore } from '@mastra/libsql'` (if memory with libsql)
   - Provider import from `@ai-sdk/*`
   - Tool imports: `import { toolA, toolB } from './tools.js'` (if tools exist)
   - `import * as fs from 'fs'` and `import * as path from 'path'` (if `$file:` refs)
2. **Env var validation** (`validateEnv()` definition and call)
3. **System prompt loading** (with variable interpolation if variables defined)
4. **LLM model setup**: `const model = openai('gpt-4o')`
5. **Memory setup** (if `spec.memory` is set)
6. **Agent definition**:
   ```typescript
   export const myAgent = new Agent({
     name: '{agent_name}',
     instructions: loadSystemPrompt(),
     model,
     tools: { toolA, toolB },
     memory,  // if spec.memory is set
   })
   ```
7. **`runAgent()` helper**:
   ```typescript
   export async function runAgent(userInput: string, threadId = 'default'): Promise<string> {
     const result = await myAgent.generate(userInput, {
       threadId,
       resourceId: 'user',
     })
     return result.text
   }
   ```
8. **`main()` block**:
   ```typescript
   if (import.meta.url === new URL(process.argv[1], 'file://').href) {
     const input = process.argv[2] ?? 'Hello, what can you help me with?'
     runAgent(input).then(console.log).catch(console.error)
   }
   ```

---

## mastra.config.ts Structure

```typescript
import { Mastra } from '@mastra/core'
import { myAgent } from './src/agent.js'

export const mastra = new Mastra({
  agents: { myAgent },
  telemetry: {
    serviceName: '{service_name}',
    enabled: true,
  },
})
```

---

## package.json Template

```json
{
  "name": "{agent-name-kebab}",
  "version": "{version}",
  "description": "{description}",
  "type": "module",
  "scripts": {
    "start": "tsx src/agent.ts",
    "dev": "tsx --watch src/agent.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mastra/core": "^0.10.0",
    "@mastra/libsql": "^0.10.0",
    "@ai-sdk/openai": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^20.17.0"
  }
}
```

Provider package map:
| provider | package |
|---|---|
| `openai` | `@ai-sdk/openai` |
| `anthropic` | `@ai-sdk/anthropic` |
| `google` | `@ai-sdk/google` |
| `groq` | `@ai-sdk/groq` |
| `mistral` | `@ai-sdk/mistral` |

Add `langfuse` if `spec.observability.tracing.backend === 'langfuse'`.

---

## .env.example Rules

- One line per env var referenced in the manifest
- Strip `$env:` prefix for the variable name
- For `$secret:name`, the env var is `AGENTSPEC_SECRET_NAME` (uppercase, `-`→`_`)
- Add a comment describing what each var is for
- Group by concern: model, memory, observability, agent config

---

## README.md Template

```markdown
# {agent_name}

{description}

**Generated by [AgentSpec](https://agentspec.io) v{version}**

## Stack

| Component | Value |
|-----------|-------|
| Framework | Mastra |
| Model | {provider}/{model_id} |
| Memory | {memory_backend} |
| Tracing | {tracing_backend} |
| Tools | {tools_count} |

## Quick Start

```bash
npm install
cp .env.example .env  # fill in your API keys
npm start "Hello, what can you help me with?"
```

## Tools

{tool_list}

## Environment Variables

{env_var_list}
```

---

## Quality Checklist

| Check | Verify |
|---|---|
| `$secret:` resolution | `$secret:langfuse-secret-key` → `AGENTSPEC_SECRET_LANGFUSE_SECRET_KEY` |
| No literal keys | Search generated code for `sk-`, `pk-`, raw key strings |
| `validateEnv()` called | At module top-level, before any connections |
| `src/tools.ts` generated | When `spec.tools` is non-empty |
| package.json complete | All `@ai-sdk/*` and `@mastra/*` packages match imports |
| ESM imports | All local imports end with `.js` extension |
