# LangGraph Adapter

Generate Python LangGraph agent code from your `agent.yaml` manifest.

## Usage

```bash
export ANTHROPIC_API_KEY=your-api-key-here
agentspec generate agent.yaml --framework langgraph --output ./generated/
```

Get an API key at [console.anthropic.com](https://console.anthropic.com).

## Generated Files

| File | When generated |
|------|----------------|
| `agent.py` | Always — main LangGraph ReAct agent |
| `tools.py` | When `spec.tools` is non-empty |
| `guardrails.py` | When `spec.guardrails` is set |
| `server.py` | When `spec.api` is set |
| `eval_runner.py` | When `spec.evaluation` is set |
| `requirements.txt` | Always |
| `.env.example` | Always |
| `README.md` | Always |

## Manifest → Code Mapping

| `agent.yaml` field | Generated code |
|---|---|
| `spec.model.provider: groq` | `from langchain_groq import ChatGroq` |
| `spec.model.provider: openai` | `from langchain_openai import ChatOpenAI` |
| `spec.model.provider: anthropic` | `from langchain_anthropic import ChatAnthropic` |
| `spec.model.provider: google` | `from langchain_google_genai import ChatGoogleGenerativeAI` |
| `spec.model.fallback` | `llm.with_fallbacks([fallback_llm])` |
| `spec.memory.shortTerm.backend: redis` | `RedisSaver` checkpointer |
| `spec.memory.shortTerm.backend: sqlite` | `SqliteSaver` checkpointer |
| `spec.memory.shortTerm.backend: in-memory` | `MemorySaver` checkpointer |
| `spec.memory.longTerm` | `save_session_summary()` / `load_session_context()` with psycopg2 |
| `spec.memory.hygiene` | `scrub_pii()` function in `agent.py` |
| `spec.observability.tracing.backend: langfuse` | `LangfuseCallback` threaded through `llm.invoke()` and `graph.invoke()` |
| `spec.observability.tracing.backend: langsmith` | LangChain tracing env vars |
| `spec.observability.metrics: otel` | OpenTelemetry `TracerProvider` + `OTLPSpanExporter` |
| `spec.guardrails.input[]` | `run_input_guardrails()` called before LLM |
| `spec.guardrails.output[]` | `run_output_guardrails()` called after LLM |
| `spec.api` | FastAPI server in `server.py` with JWT auth and rate limiting |
| `spec.evaluation` | deepeval harness in `eval_runner.py` |
| `spec.subagents[]` | Async stub functions with `parallel`/`sequential`/`on-demand` wiring |
| `spec.requires.envVars[]` | `validate_env()` called at module top-level |
| `spec.requires.services[]` | TCP connectivity checks via `socket.create_connection()` |

## agent.py Section Order

The generated `agent.py` follows this fixed structure:

1. Module docstring (agent name, version, model, tools count, memory, tracing)
2. Imports (stdlib → langchain/langgraph → local)
3. Observability setup (Langfuse / LangSmith / OTEL)
4. Callbacks binding
5. Memory setup (checkpointer)
6. Long-term memory functions
7. Memory hygiene
8. Cost controls comment block
9. MCP server comment block
10. `validate_env()` + service connectivity checks
11. System prompt loading (with variable interpolation)
12. `AgentState` TypedDict
13. Tools list
14. Model setup (primary + fallback)
15. `call_model()` with guardrails
16. `should_continue()`
17. Graph construction + compile
18. `run_agent()`
19. `__main__` block

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
```

The adapter generates:

```python
# agent.py (excerpt)
from langchain_groq import ChatGroq
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.redis import RedisSaver
from tools import search_web

memory_saver = RedisSaver.from_conn_string(os.environ.get("REDIS_URL", "redis://localhost:6379"))

primary_llm = ChatGroq(model="llama-3.3-70b-versatile", api_key=os.environ.get("GROQ_API_KEY"))
fallback_llm = ChatOpenAI(model="gpt-4o-mini", api_key=os.environ.get("OPENAI_API_KEY"))
llm = primary_llm.with_fallbacks([fallback_llm])

tools = [search_web]
llm_with_tools = llm.bind_tools(tools)

graph = workflow.compile(checkpointer=memory_saver)
```

## See also

- [Concepts: Adapters](../concepts/adapters.md) — how the generation system works
- [agentspec generate CLI reference](../reference/cli.md)

---

## Runtime Behavioral Instrumentation

The `agentspec-langgraph` Python package is a thin runtime wrapper that intercepts LangGraph lifecycle hooks (tool calls, LLM calls, guardrail invocations) and emits standardized events to `AgentSpecReporter` and OPA.

### Install

```bash
pip install agentspec-langgraph
# Optional extras:
pip install "agentspec-langgraph[langgraph]"   # adds langgraph + langchain-core
pip install "agentspec-langgraph[opa]"         # adds httpx for OPA enforcement
pip install "agentspec-langgraph[all]"         # everything
```

### AgentSpecToolNode — instrument tool calls

```python
from agentspec_langgraph import AgentSpecToolNode

# Replace: tool_node = ToolNode(tools=[plan_workout, log_session])
tool_node = AgentSpecToolNode(
    tools=[plan_workout, log_session],
    reporter=reporter,   # optional AgentSpecReporter
)

# Use in the graph exactly as before
workflow.add_node("tools", tool_node.as_langgraph_node())

# Inspect recorded events
events = tool_node.get_invocations()
# [ToolCallEvent(name='plan-workout', latency_ms=42.1, success=True, error=None)]
```

### instrument_call_model — instrument LLM calls

```python
from agentspec_langgraph import instrument_call_model

def call_model(state):
    response = llm_with_tools.invoke(state["messages"])
    return {"messages": [response]}

# Wrap once — same signature, same return value
call_model = instrument_call_model(
    call_model,
    reporter=reporter,
    model_id="groq/llama-3.3-70b-versatile",
)

workflow.add_node("agent", call_model)
```

Each invocation records a `ModelCallEvent` with latency and token counts extracted from `AIMessage.usage_metadata`, `response_metadata["token_usage"]`, or `additional_kwargs["usage"]` — whichever is present.

### GuardrailMiddleware — record and enforce guardrails

```python
from agentspec_langgraph import GuardrailMiddleware, PolicyViolationError

middleware = GuardrailMiddleware(
    reporter=reporter,
    opa_url="http://localhost:8181",   # optional
    agent_name="gymcoach",
)

# Wrap each declared guardrail function
check_pii    = middleware.wrap("pii-detector",    your_pii_scrubber)
check_topics = middleware.wrap("topic-filter",    your_topic_filter)

def run_input_guardrails(user_input: str) -> str:
    user_input = check_pii(user_input)
    user_input = check_topics(user_input)
    return user_input

# Optionally enforce OPA before each LLM call
def call_model(state):
    user_input = run_input_guardrails(state["messages"][-1].content)

    try:
        middleware.enforce_opa(
            model_id="groq/llama-3.3-70b-versatile",
            guardrails_declared=["pii-detector", "topic-filter"],
        )
    except PolicyViolationError as e:
        return {"messages": [{"role": "assistant", "content": str(e)}]}

    # ... invoke LLM
```

### Event types

| Class | Emitted by | Key fields |
|---|---|---|
| `ToolCallEvent` | `AgentSpecToolNode.invoke_tool()` | `name`, `latency_ms`, `success`, `error` |
| `ModelCallEvent` | `instrument_call_model` wrapper | `model_id`, `latency_ms`, `token_count`, `prompt_tokens`, `completion_tokens` |
| `GuardrailEvent` | `GuardrailMiddleware.wrap()` | `guardrail_type`, `invoked`, `blocked`, `reason`, `score` |
| `MemoryWriteEvent` | *(future — memory middleware)* | `backend`, `ttl_seconds`, `pii_scrubbed` |

### Per-request isolation

In async/multi-threaded servers, use `new_request_context()` to get a fresh, isolated middleware per request:

```python
async def handle_request(user_input: str):
    with middleware.new_request_context() as ctx:
        check_pii = ctx.wrap("pii-detector", your_pii_scrubber)
        cleaned = check_pii(user_input)
        ctx.enforce_opa(model_id="groq/llama-3.3-70b-versatile")
        # ctx events are isolated from other concurrent requests
```

### See also

- [Behavioral policy enforcement with OPA](../concepts/opa.md)
- [Generate OPA policies guide](../guides/opa-policy.md)
