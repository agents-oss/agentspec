# AutoGen Adapter

Generate Python AutoGen agent code from your `agent.yaml` manifest.

## Usage

```bash
export ANTHROPIC_API_KEY=your-api-key-here
npx agentspec generate agent.yaml --framework autogen --output ./generated/
```

Get an API key at [console.anthropic.com](https://console.anthropic.com).

## Generated Files

| File | Description |
|------|-------------|
| `agent.py` | `AssistantAgent` setup, `run_agent()` coroutine, CLI entry point |
| `tools.py` | Tool registry — imports and exposes `AGENT_TOOLS` list |
| `tool_implementations.py` | Typed async stub functions — fill in the bodies |
| `manifest.py` | Runtime manifest loader + `get_capabilities()` |
| `agent.yaml` | Copy of your manifest (ships with the agent) |
| `server.py` | FastAPI + SSE streaming server (when `spec.api` is set) |
| `guardrails.py` | Input/output guardrail functions (when `spec.guardrails` is set) |
| `requirements.txt` | Runtime dependencies |
| `requirements-test.txt` | Test dependencies (pytest) |
| `.env.example` | All required environment variables |
| `docker-compose.yml` | Agent + AgentSpec sidecar |
| `README.md` | Quick-start guide |

## Manifest Mapping

| `agent.yaml` field | Generated code |
|---|---|
| `spec.model.provider: openai` | `OpenAIChatCompletionClient` from `autogen_ext.models.openai` |
| `spec.model.provider: anthropic` | `AnthropicChatCompletionClient` from `autogen_ext.models.anthropic` |
| `spec.model.provider: azure` | `AzureOpenAIChatCompletionClient` from `autogen_ext.models.azure` |
| `spec.model.provider: groq` | `OpenAIChatCompletionClient` with Groq `base_url` |
| `spec.tools[]` | Plain async functions in `tool_implementations.py`, registered in `tools=[]` |
| `spec.memory` | `ListMemory` (in-process) or Redis-backed `ListMemory` |
| `spec.guardrails` | `run_input_guardrails()` + `run_output_guardrails()` in `guardrails.py` |
| `spec.prompts.system` | `system_message` on `AssistantAgent` |
| `spec.api` | FastAPI `/chat` endpoint with SSE streaming via `agent.run_stream()` |
| `spec.observability` | Langfuse env vars wired before model client init |

## Example

```yaml
metadata:
  name: research-assistant
  version: 1.0.0

spec:
  model:
    provider: openai
    id: gpt-4o
    apiKey: $env:OPENAI_API_KEY

  tools:
    - name: search-web
      description: Search the web for information
      annotations:
        readOnlyHint: true

  memory:
    shortTerm:
      backend: in-memory

  guardrails:
    input:
      - type: prompt-injection
      - type: pii-detector
        action: scrub
```

```bash
npx agentspec generate agent.yaml --framework autogen --output ./generated/
cd generated
pip install -r requirements.txt
cp .env.example .env
python agent.py "What are the latest AI research papers?"
```

## See also

- [LangGraph Adapter](./langgraph) — Python, StateGraph-based
- [CrewAI Adapter](./crewai) — Python, role-based crews
- [Mastra Adapter](./mastra) — TypeScript
- [Concepts: Adapters](../concepts/adapters) — how the adapter system works
