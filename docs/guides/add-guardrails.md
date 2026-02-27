# Add Guardrails

Guardrails validate inputs before they reach the LLM and outputs before they reach the user.

## Input guardrails

```yaml
spec:
  guardrails:
    input:
      - type: prompt-injection
        action: reject
      - type: topic-filter
        topics: [violence, self-harm]
        action: reject
      - type: pii-detector
        action: redact
```

## Output guardrails

```yaml
spec:
  guardrails:
    output:
      - type: toxicity-filter
        threshold: 0.7
        action: reject
      - type: hallucination-detector
        action: flag
```

## Guardrail types

| Type | Applied to | Action options |
|------|-----------|----------------|
| `prompt-injection` | Input | `reject`, `flag` |
| `topic-filter` | Input | `reject`, `flag` |
| `pii-detector` | Input / Output | `reject`, `redact`, `flag` |
| `toxicity-filter` | Output | `reject`, `flag` |
| `hallucination-detector` | Output | `reject`, `flag` |

## Actions

| Action | Behaviour |
|--------|-----------|
| `reject` | Block the message and return an error |
| `redact` | Remove the violating content and continue |
| `flag` | Log a warning and continue |

## See also

- [Manifest Schema Reference](../reference/manifest-schema.md)
- [OWASP LLM Top 10 compliance pack](../concepts/compliance.md)
