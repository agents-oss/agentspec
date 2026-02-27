# Add Tools

Register tools in your `agent.yaml` so AgentSpec can validate, document, and generate them.

## Define a tool

```yaml
spec:
  tools:
    - name: search-web
      type: function
      description: "Search the web for current information"
      module: $file:tools/search.py
      function: search_web
      annotations:
        readOnlyHint: true
        destructiveHint: false
```

## Tool fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique tool identifier |
| `type` | Yes | `function` or `mcp` |
| `description` | Yes | Human-readable description (used in LLM system prompt) |
| `module` | No | Path to the Python/JS module (`$file:` reference) |
| `function` | No | Function name within the module |
| `annotations.readOnlyHint` | No | Hints the tool does not modify state |
| `annotations.destructiveHint` | No | Hints the tool may destroy data irreversibly |

## See also

- [Manifest Schema Reference](../reference/manifest-schema.md)
- [LangGraph Adapter](../adapters/langgraph.md)
