# AgentSpec Scan Skill

You are analysing source code to detect what kind of AI agent it implements.

Your **only job** is to return a `detection.json` file containing raw facts you find in the source.
**Do NOT generate YAML.** TypeScript will convert your detection to a valid manifest.

---

## Output Format

Respond with **exactly one JSON object** in this shape:

```json
{
  "files": {
    "detection.json": "<ScanDetection object as a JSON string>"
  },
  "installCommands": [],
  "envVars": ["OPENAI_API_KEY", "..."]
}
```

The `detection.json` value must be a **valid JSON string** encoding a `ScanDetection` object (see interface below).
Do NOT include any text outside the JSON object. Do NOT generate YAML.

---

## ScanDetection Interface

Return raw values only — do NOT slugify or normalise. The builder handles that.

```typescript
interface ScanDetection {
  name: string                    // agent name (raw — can have underscores, spaces)
  description: string
  version?: string                // semver if found, omit otherwise
  tags?: string[]
  modelProvider: string           // "openai" | "anthropic" | "groq" | "google" | "mistral" | "azure" | "bedrock"
  modelId: string                 // exact model ID found in source
  modelApiKeyEnv: string          // env var name for the API key (e.g. "OPENAI_API_KEY")
  modelTemperature?: number
  modelMaxTokens?: number
  fallbackProvider?: string
  fallbackModelId?: string
  fallbackApiKeyEnv?: string
  promptFile?: string             // path if a prompt file is loaded (e.g. "app/prompts/system.txt")
  tools?: Array<{
    name: string                  // raw tool/function name
    description: string
    module?: string               // file path relative to scanned dir, e.g. "app/tools/expense.py" — NO $file: prefix
    function?: string             // callable name in that module, e.g. "create_expense"
    readOnly?: boolean
    destructive?: boolean
    idempotent?: boolean
  }>
  shortTermBackend?: "redis" | "in-memory" | "sqlite"
  shortTermConnectionEnv?: string  // env var for redis/sqlite connection
  shortTermMaxTurns?: number
  shortTermTtlSeconds?: number
  longTermBackend?: "postgres" | "sqlite" | "mongodb"
  longTermConnectionStringEnv?: string
  hasPromptInjection?: boolean
  hasTopicFilter?: boolean
  blockedTopics?: string[]
  hasToxicityFilter?: boolean
  toxicityThreshold?: number
  hasPiiDetector?: boolean
  hasRestApi?: boolean
  apiStreaming?: boolean
  apiAuthType?: "jwt" | "apikey" | "oauth2" | "none"
  apiPort?: number
  tracingBackend?: "langfuse" | "langsmith" | "agentops" | "otel" | "honeycomb" | "datadog"
  metricsBackend?: "opentelemetry" | "prometheus" | "datadog"
  loggingStructured?: boolean
  envVars: string[]               // ALL env vars detected in source (REQUIRED, can be empty [])
  services?: Array<{
    type: "postgres" | "redis" | "mysql" | "mongodb" | "elasticsearch"
    connectionEnv: string         // env var name for the connection string
  }>
}
```

**ONLY include fields you can confidently detect.** Omit unknown fields entirely.

---

## Detection Rules

### Model detection

| Pattern | `modelProvider` | `modelId` default |
|---------|-----------------|-------------------|
| `from langchain_openai import` / `import openai` | `openai` | `gpt-4o-mini` |
| `from langchain_anthropic import` / `import anthropic` | `anthropic` | `claude-sonnet-4-6` |
| `from langchain_groq import` / `ChatGroq` | `groq` | `llama-3.3-70b-versatile` |
| `from langchain_google_genai import` | `google` | `gemini-2.0-flash` |
| `from langchain_mistralai import` | `mistral` | `mistral-large-latest` |
| `AzureChatOpenAI` / `azure` in env vars | `azure` | `gpt-4o` |
| Literal `model="…"` or `model_name="…"` | — | use the literal value |

Always prefer the detected model ID literal over the default.

Use the env var name that the code passes to the API client constructor for `modelApiKeyEnv`.

### Tool detection

Detect from:
- `@tool` decorator on a function
- `StructuredTool.from_function(name="…")`
- `Tool(name="…", func=…)`
- `tools = [ToolClass()]` patterns

For each tool, return:
- `name`: raw function/tool name (do NOT convert underscores)
- `description`: docstring or description string
- `module`: file path where the tool is defined, **relative to the scanned directory root** (e.g. `app/tools/expense_tools.py`). Do NOT include `$file:` prefix — the builder adds it.
- `function`: the callable Python/JS function name in that module (e.g. `create_expense`)

Hints:
- A tool decorated with `@tool` and only uses `SELECT`/`GET` → `readOnly: true`
- A tool that deletes/updates data → `destructive: true`

### Memory backend detection

| Pattern | Field | `backend` value |
|---------|-------|-----------------|
| Redis / Upstash REST URL / `aioredis` / `redis-py` | `shortTermBackend` | `redis` |
| `MemorySaver` (LangGraph in-memory) | `shortTermBackend` | `in-memory` |
| SQLite checkpointer | `shortTermBackend` | `sqlite` |
| PostgreSQL / asyncpg / SQLAlchemy + postgres | `longTermBackend` | `postgres` |
| MongoDB / motor | `longTermBackend` | `mongodb` |

For redis/sqlite, also detect `shortTermConnectionEnv` (the env var used to connect).
For postgres/mongodb, detect `longTermConnectionStringEnv`.

### Guardrail detection

- Prompt injection detection library / check → `hasPromptInjection: true`
- Topic blocking / content filter on input → `hasTopicFilter: true`, list `blockedTopics`
- PII scrubbing / Presidio / anonymisation → `hasPiiDetector: true`
- Toxicity filter / moderation on output → `hasToxicityFilter: true`, include `toxicityThreshold` if found
- Hallucination detection on output → (omit, not in interface)

### API detection

- FastAPI / Flask / Express app with chat endpoint → `hasRestApi: true`
- SSE streaming / `StreamingResponse` → `apiStreaming: true`
- JWT / OAuth2 / API key middleware → `apiAuthType`
- Port from `uvicorn.run(..., port=N)` or `app.listen(N)` → `apiPort`

### Env var detection

Scan for:
- Python: `os.getenv("VAR")`, `os.environ["VAR"]`, `os.environ.get("VAR")`
- TypeScript/JS: `process.env.VAR`, `process.env["VAR"]`
- Frameworks: `settings.VAR`, `config.VAR`

Collect ALL unique env var names → `envVars` array (REQUIRED, even if empty `[]`).

### Services detection

| Pattern | `type` |
|---------|--------|
| PostgreSQL / asyncpg / SQLAlchemy | `postgres` |
| Redis / aioredis / Upstash | `redis` |
| MySQL | `mysql` |
| MongoDB / motor | `mongodb` |
| Elasticsearch | `elasticsearch` |

For each detected service, find the env var that holds the connection string → `connectionEnv`.

---

## Important Rules

1. **Return `detection.json` — NEVER `agent.yaml`** — YAML generation is TypeScript's job.
2. **Return raw names** — do NOT convert underscores to hyphens; the builder slugifies.
3. **`envVars` is required** — always include it, even as `[]` if no env vars found.
4. **Omit unknown fields** — do not guess values you cannot find in the source.
5. **Use exact enum values** — `modelProvider` must be one of the listed strings.
6. **Do not invent services** — only list services that are actually imported/used.
