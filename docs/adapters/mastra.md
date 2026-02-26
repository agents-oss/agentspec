# Mastra Adapter

::: warning Coming Soon
The `@agentspec/adapter-mastra` package is not yet available. Follow the [GitHub repository](https://github.com/agentspec/agentspec) for updates.
:::

The `@agentspec/adapter-mastra` package will generate TypeScript Mastra agent code from your `agent.yaml` manifest.

## Planned Usage

```bash
npm install @agentspec/adapter-mastra
npx agentspec generate agent.yaml --framework mastra --output ./generated/
```

## Planned Manifest Mapping

| `agent.yaml` field | Generated code |
|---|---|
| `spec.model.provider` | Mastra LLM configuration |
| `spec.tools[]` | Mastra tool definitions |
| `spec.memory` | Mastra memory/storage setup |
| `spec.observability` | Mastra telemetry integration |

## See also

- [LangGraph Adapter](./langgraph) — available now
- [Concepts: Adapters](../concepts/adapters) — how the adapter system works
