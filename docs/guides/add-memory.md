# Add Memory

Configure short-term and long-term memory backends in `agent.yaml`.

## Short-term memory (conversation history)

```yaml
spec:
  memory:
    shortTerm:
      backend: redis          # redis | sqlite | in-memory
      connection: $env:REDIS_URL
      maxTokens: 8000
      ttlSeconds: 3600
```

## Long-term memory (vector store)

```yaml
spec:
  memory:
    longTerm:
      backend: postgres       # postgres | pinecone | weaviate | chroma
      connection: $env:DATABASE_URL
      namespace: my-agent
```

## Memory hygiene (PII & audit)

```yaml
spec:
  memory:
    hygiene:
      piiScrubFields: [ssn, credit_card, bank_account]
      auditLog: true
      retentionDays: 90
```

## Supported backends

| Backend | Short-term | Long-term |
|---------|-----------|-----------|
| `in-memory` | Yes | No |
| `redis` | Yes | No |
| `sqlite` | Yes | No |
| `postgres` | No | Yes |
| `pinecone` | No | Yes |
| `chroma` | No | Yes |

## See also

- [Manifest Schema Reference](../reference/manifest-schema.md)
- [Compliance — memory-hygiene pack](../concepts/compliance.md)
