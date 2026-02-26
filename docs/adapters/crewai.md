# CrewAI Adapter

::: warning Coming Soon
The `@agentspec/adapter-crewai` package is not yet available. Follow the [GitHub repository](https://github.com/agentspec/agentspec) for updates.
:::

The `@agentspec/adapter-crewai` package will generate Python CrewAI agent code from your `agent.yaml` manifest.

## Planned Usage

```bash
npm install @agentspec/adapter-crewai
npx agentspec generate agent.yaml --framework crewai --output ./generated/
```

## Planned Manifest Mapping

| `agent.yaml` field | Generated code |
|---|---|
| `spec.model.provider` | CrewAI LLM class |
| `spec.tools[]` | CrewAI `Tool` definitions |
| `spec.memory` | CrewAI memory configuration |
| `spec.guardrails` | Input/output middleware |

## See also

- [LangGraph Adapter](./langgraph) — available now
- [Concepts: Adapters](../concepts/adapters) — how the adapter system works
