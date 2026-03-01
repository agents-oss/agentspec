# Mastra Adapter

Generate TypeScript Mastra agent code from your `agent.yaml` manifest.

## Usage

```bash
export ANTHROPIC_API_KEY=your-api-key-here
npx agentspec generate agent.yaml --framework mastra --output ./generated/
```

Get an API key at [console.anthropic.com](https://console.anthropic.com).

## Generated Files

| File | When generated |
|------|----------------|
| `src/agent.ts` | Always — agent definition and `runAgent()` helper |
| `src/tools.ts` | When `spec.tools` is non-empty |
| `mastra.config.ts` | Always — Mastra instance with telemetry |
| `package.json` | Always — dependencies |
| `.env.example` | Always |
| `README.md` | Always |

## Manifest → Code Mapping

| `agent.yaml` field | Generated code |
|---|---|
| `spec.model.provider: openai` | `import { openai } from '@ai-sdk/openai'` |
| `spec.model.provider: anthropic` | `import { anthropic } from '@ai-sdk/anthropic'` |
| `spec.model.provider: google` | `import { google } from '@ai-sdk/google'` |
| `spec.model.provider: groq` | `import { createGroq } from '@ai-sdk/groq'` |
| `spec.model.id` | First argument to provider function: `openai('gpt-4o')` |
| `spec.model.parameters.temperature` | `temperature: N` in generate options |
| `spec.model.apiKey: $env:VAR` | `apiKey: process.env.VAR` in provider factory |
| `spec.prompts.system` | `instructions` field on the `Agent` |
| `spec.tools[]` | `createTool({ id, description, execute })` in `src/tools.ts` |
| `spec.memory` | `new Memory({ storage: new LibSQLStore(...) })` |
| `spec.observability` | `telemetry: { serviceName, enabled: true }` in `mastra.config.ts` |
| `spec.requires.envVars[]` | `validateEnv()` called at module top-level |

## src/agent.ts Structure

```typescript
// src/agent.ts (excerpt)
import { Agent } from '@mastra/core'
import { Memory } from '@mastra/core/memory'
import { LibSQLStore } from '@mastra/libsql'
import { openai } from '@ai-sdk/openai'
import { logWorkout, getWorkoutHistory } from './tools.js'

validateEnv()

const model = openai('gpt-4o')
const memory = new Memory({ storage: new LibSQLStore({ url: process.env.LIBSQL_URL ?? 'file:./agent.db' }) })

export const myAgent = new Agent({
  name: 'GymCoach',
  instructions: loadSystemPrompt(),
  model,
  tools: { logWorkout, getWorkoutHistory },
  memory,
})

export async function runAgent(userInput: string, threadId = 'default'): Promise<string> {
  const result = await myAgent.generate(userInput, { threadId, resourceId: 'user' })
  return result.text
}
```

## See also

- [LangGraph adapter](./langgraph.md) — Python LangGraph
- [CrewAI adapter](./crewai.md) — Python CrewAI
- [Concepts: Adapters](../concepts/adapters.md) — how the generation system works
