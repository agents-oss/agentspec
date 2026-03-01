# CrewAI Adapter

Generate Python CrewAI agent code from your `agent.yaml` manifest.

## Usage

```bash
export ANTHROPIC_API_KEY=your-api-key-here
npx agentspec generate agent.yaml --framework crewai --output ./generated/
```

Get an API key at [console.anthropic.com](https://console.anthropic.com).

## Generated Files

| File | When generated |
|------|----------------|
| `crew.py` | Always — agent, task, and crew definitions |
| `tools.py` | When `spec.tools` is non-empty |
| `guardrails.py` | When `spec.guardrails` is set |
| `requirements.txt` | Always |
| `.env.example` | Always |
| `README.md` | Always |

## Manifest → Code Mapping

| `agent.yaml` field | Generated code |
|---|---|
| `spec.model.provider: groq` | `from langchain_groq import ChatGroq` → `Agent(llm=llm)` |
| `spec.model.provider: openai` | `from langchain_openai import ChatOpenAI` |
| `spec.model.provider: anthropic` | `from langchain_anthropic import ChatAnthropic` |
| `spec.model.parameters.temperature` | `temperature=N` kwarg |
| `spec.model.apiKey: $env:VAR` | `api_key=os.environ.get("VAR")` |
| `spec.prompts.system` | `backstory` field on the `Agent` |
| `spec.tools[]` | `@tool`-decorated functions in `tools.py`, passed to `Agent(tools=[...])` |
| `spec.memory` | `Crew(memory=True)` |
| `spec.guardrails.input[]` | `run_input_guardrails()` in `guardrails.py` |
| `spec.guardrails.output[]` | `run_output_guardrails()` in `guardrails.py` |
| `spec.observability.tracing.backend: langfuse` | Langfuse env vars for automatic CrewAI tracing |
| `spec.requires.envVars[]` | `validate_env()` called at module top-level |

## crew.py Structure

```python
# crew.py (excerpt)
from crewai import Agent, Task, Crew
from langchain_groq import ChatGroq

llm = ChatGroq(model="llama-3.3-70b-versatile", api_key=os.environ.get("GROQ_API_KEY"))

agent = Agent(
    role="GymCoach",
    goal="Help users achieve their fitness goals",
    backstory=load_system_prompt(),
    tools=[log_workout, get_workout_history],
    llm=llm,
    verbose=True,
)

def run_agent(user_input: str) -> str:
    task = Task(
        description=user_input,
        agent=agent,
        expected_output="A helpful, accurate response to the user's request.",
    )
    crew = Crew(agents=[agent], tasks=[task], memory=True, verbose=True)
    return str(crew.kickoff())
```

## See also

- [LangGraph adapter](./langgraph.md) — Python LangGraph (multi-step graph execution)
- [Mastra adapter](./mastra.md) — TypeScript Mastra
- [Concepts: Adapters](../concepts/adapters.md) — how the generation system works
