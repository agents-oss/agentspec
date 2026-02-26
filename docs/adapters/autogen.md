# AutoGen Adapter

::: warning Coming Soon
The `@agentspec/adapter-autogen` package is not yet available. Follow the [GitHub repository](https://github.com/agentspec/agentspec) for updates.
:::

The `@agentspec/adapter-autogen` package will generate Python AutoGen agent code from your `agent.yaml` manifest.

## Planned Usage

```bash
npm install @agentspec/adapter-autogen
npx agentspec generate agent.yaml --framework autogen --output ./generated/
```

## Planned Manifest Mapping

| `agent.yaml` field | Generated code |
|---|---|
| `spec.model.provider` | AutoGen `LLMConfig` |
| `spec.tools[]` | AutoGen function tool registrations |
| `spec.memory` | AutoGen memory configuration |
| `spec.guardrails` | AutoGen middleware hooks |

## See also

- [LangGraph Adapter](./langgraph) — available now
- [Concepts: Adapters](../concepts/adapters) — how the adapter system works
