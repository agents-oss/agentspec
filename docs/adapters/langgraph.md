# LangGraph Adapter

The `@agentspec/adapter-langgraph` package generates Python LangGraph agent code from your `agent.yaml` manifest.

## Installation

```bash
npm install @agentspec/adapter-langgraph
```

## Usage

```bash
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
```

## Generated Files

| File | Description |
|------|-------------|
| `agent.py` | Main LangGraph ReAct agent with tools, memory, observability |
| `guardrails.py` | Input/output guardrail functions (when guardrails are configured) |
| `requirements.txt` | All Python dependencies |
| `.env.example` | Required environment variables |
| `README.md` | Setup and usage instructions |

With `--include-dockerfile`:
| `Dockerfile` | Container image for deployment |

With `--include-api-server`:
| `server.py` | FastAPI server wrapper |

## Manifest → Code Mapping

| `agent.yaml` field | Generated code |
|---|---|
| `spec.model.provider: groq` | `from langchain_groq import ChatGroq` |
| `spec.model.provider: openai` | `from langchain_openai import ChatOpenAI` |
| `spec.model.provider: anthropic` | `from langchain_anthropic import ChatAnthropic` |
| `spec.model.fallback` | `llm.with_fallbacks([fallback_llm])` |
| `spec.memory.shortTerm.backend: redis` | `RedisSaver` checkpointer |
| `spec.memory.shortTerm.backend: sqlite` | `SqliteSaver` checkpointer |
| `spec.memory.shortTerm.backend: in-memory` | `MemorySaver` checkpointer |
| `spec.observability.tracing.backend: langfuse` | `LangfuseCallback` |
| `spec.observability.tracing.backend: langsmith` | LangChain tracing env vars |
| `spec.guardrails.input[]` | `run_input_guardrails()` calls |
| `spec.guardrails.output[]` | `run_output_guardrails()` calls |

## Example

Given this `agent.yaml`:

```yaml
spec:
  model:
    provider: groq
    id: llama-3.3-70b-versatile
    apiKey: $env:GROQ_API_KEY
    fallback:
      provider: openai
      id: gpt-4o-mini
      apiKey: $env:OPENAI_API_KEY
  memory:
    shortTerm:
      backend: redis
      connection: $env:REDIS_URL
  tools:
    - name: search-web
      type: function
      description: Search the web
      function: search_web
      annotations:
        readOnlyHint: true
        destructiveHint: false
```

The adapter generates:

```python
# agent.py (excerpt)
from langchain_groq import ChatGroq
from langchain_openai import ChatOpenAI
from langchain_core.runnables import RunnableWithFallbacks
from langgraph.checkpoint.redis import RedisSaver

primary_llm = ChatGroq(
    model="llama-3.3-70b-versatile",
    api_key=os.environ.get("GROQ_API_KEY"),
)
fallback_llm = ChatOpenAI(
    model="gpt-4o-mini",
    api_key=os.environ.get("OPENAI_API_KEY"),
)
llm = primary_llm.with_fallbacks([fallback_llm])
llm_with_tools = llm.bind_tools(tools)

redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
memory_saver = RedisSaver.from_conn_string(redis_url)
graph = workflow.compile(checkpointer=memory_saver)
```

## Claude Code Integration

Because the SDK includes a `CLAUDE.md` with detailed adapter generation instructions, Claude Code can generate adapters for other frameworks automatically.

Run `agentspec generate` — if the adapter isn't installed, Claude Code will offer to generate the framework code directly from the manifest.
