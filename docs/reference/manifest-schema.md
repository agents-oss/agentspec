# Manifest Schema Reference

Complete field-by-field reference for `agent.yaml`. Every field listed here is enforced by the Zod schema in `packages/sdk/src/schema/manifest.schema.ts`.

---

## Overview

An AgentSpec manifest has four top-level keys:

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec
metadata: ...
spec: ...
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiVersion` | `"agentspec.io/v1"` | Yes | Always this literal value |
| `kind` | `"AgentSpec"` | Yes | Always this literal value |
| `metadata` | object | Yes | Identity and versioning |
| `spec` | object | Yes | All runtime configuration |

---

## Reference Syntax

Many string fields accept a reference instead of a literal value:

| Syntax | Resolves to | Fails if missing |
|--------|-------------|-----------------|
| `$env:VAR_NAME` | Environment variable | Yes |
| `$secret:name` | Secret manager (Vault / AWS / GCP / Azure) | Yes |
| `$file:path` | File path relative to `agent.yaml` | Yes |
| `$func:now_iso` | Built-in function | Yes (unknown func) |

Fields that accept references are noted as `refOrLiteral` in this document.

---

## `metadata`

Required. Identifies the agent and its version.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `name` | string | Yes | Lowercase slug `/^[a-z0-9-]+$/` | `budget-bud` |
| `version` | string | Yes | Semver `/^\d+\.\d+\.\d+$/` | `1.0.0` |
| `description` | string | Yes | Min length 1 | `"Personal finance assistant"` |
| `tags` | string[] | No | — | `[finance, telegram]` |
| `author` | string | No | — | `"Acme Corp"` |
| `license` | string | No | — | `MIT` |

```yaml
metadata:
  name: budget-bud
  version: 1.0.0
  description: "Personal finance AI assistant"
  tags: [finance, telegram]
  author: "Acme Corp"
  license: MIT
```

---

## `spec.model`

Required. The primary LLM configuration.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `provider` | string | Yes | — | `openai` |
| `id` | string | Yes | — | `gpt-4o-mini` |
| `apiKey` | refOrLiteral | Yes | — | `$env:OPENAI_API_KEY` |
| `parameters` | object | No | See below | — |
| `fallback` | object | No | See below | — |
| `costControls` | object | No | See below | — |

### `spec.model.parameters`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `temperature` | number | No | `0..2` | `0.7` |
| `maxTokens` | integer | No | Min 1 | `2048` |
| `topP` | number | No | `0..1` | `0.9` |
| `frequencyPenalty` | number | No | — | `0.0` |
| `presencePenalty` | number | No | — | `0.0` |

### `spec.model.fallback`

Activated when the primary model fails. Supports automatic retry logic.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `provider` | string | Yes | — | `azure` |
| `id` | string | Yes | — | `gpt-4` |
| `apiKey` | refOrLiteral | Yes | — | `$env:AZURE_OPENAI_API_KEY` |
| `triggerOn` | enum[] | No | `rate_limit`, `timeout`, `error_5xx`, `error_4xx` | `[rate_limit, timeout]` |
| `maxRetries` | integer | No | `0..10` | `2` |

### `spec.model.costControls`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `maxMonthlyUSD` | number | No | Positive | `200` |
| `alertAtUSD` | number | No | Positive | `150` |

```yaml
spec:
  model:
    provider: groq
    id: llama-3.3-70b-versatile
    apiKey: $env:GROQ_API_KEY
    parameters:
      temperature: 0.3
      maxTokens: 500
    fallback:
      provider: azure
      id: gpt-4
      apiKey: $env:AZURE_OPENAI_API_KEY
      triggerOn: [rate_limit, timeout, error_5xx]
      maxRetries: 2
    costControls:
      maxMonthlyUSD: 200
      alertAtUSD: 150
```

---

## `spec.prompts`

Required. System prompt configuration with hot-reload and variable injection.

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `system` | refOrLiteral | Yes | — | — | `$file:prompts/system.md` |
| `fallback` | string | No | — | — | `"Sorry, I'm unavailable."` |
| `hotReload` | boolean | No | `false` | — | `true` |
| `variables` | object[] | No | — | See below | — |

### `spec.prompts.variables[]`

Injects values into the system prompt at runtime.

| Field | Type | Required | Example |
|-------|------|----------|---------|
| `name` | string | Yes | `current_date` |
| `value` | refOrLiteral | Yes | `$func:now_iso` |

```yaml
spec:
  prompts:
    system: $file:prompts/system.md
    fallback: "I'm experiencing difficulties. Please try again."
    hotReload: true
    variables:
      - name: current_date
        value: "$func:now_iso"
      - name: currency
        value: $env:DEFAULT_CURRENCY
```

---

## `spec.tools[]`

Optional. List of function tools the agent can call.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `name` | string | Yes | Lowercase slug `/^[a-z0-9-]+$/` | `get-expenses` |
| `type` | enum | Yes | `function`, `mcp`, `builtin` | `function` |
| `description` | string | Yes | — | `"Retrieve expense records"` |
| `module` | string | No | Typically a `$file:` reference | `$file:tools/impl.py` |
| `function` | string | No | — | `get_expenses` |
| `annotations` | object | No | See below | — |

### `spec.tools[].annotations`

MCP-compatible hints about tool behaviour. Adapters use these to generate guardrail wrappers.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `readOnlyHint` | boolean | No | — | Tool does not modify state |
| `destructiveHint` | boolean | No | — | Tool may delete or overwrite data |
| `idempotentHint` | boolean | No | — | Repeated calls have the same effect |
| `openWorldHint` | boolean | No | — | Tool interacts with external systems |

```yaml
spec:
  tools:
    - name: delete-expense
      type: function
      description: "Delete an expense record"
      module: $file:tools/impl.py
      function: delete_expense
      annotations:
        readOnlyHint: false
        destructiveHint: true
        idempotentHint: false
```

---

## `spec.mcp`

Optional. Model Context Protocol server configuration.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `servers` | object[] | Yes (if present) | List of MCP servers |

### `spec.mcp.servers[]`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `name` | string | Yes | — | `postgres-db` |
| `transport` | enum | Yes | `stdio`, `sse`, `http` | `stdio` |
| `command` | string | No | Required for `stdio` transport | `npx` |
| `args` | string[] | No | — | `[-y, "@modelcontextprotocol/server-postgres"]` |
| `url` | string | No | Valid URL; required for `sse`/`http` transport | `https://mcp.example.com` |
| `env` | record | No | Values are refOrLiteral | `DATABASE_URL: $env:DATABASE_URL` |
| `healthCheck` | object | No | See below | — |

### `spec.mcp.servers[].healthCheck`

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `timeoutSeconds` | integer | No | `5` | `1..60` | `10` |

```yaml
spec:
  mcp:
    servers:
      - name: postgres-db
        transport: stdio
        command: npx
        args: [-y, "@modelcontextprotocol/server-postgres"]
        env:
          DATABASE_URL: $env:DATABASE_URL
        healthCheck:
          timeoutSeconds: 5
```

---

## `spec.memory`

Optional. Short-term conversation memory, long-term persistence, and vector search.

### `spec.memory.shortTerm`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `backend` | enum | Yes | `in-memory`, `redis`, `sqlite` | `redis` |
| `maxTurns` | integer | No | Min 1 | `20` |
| `maxTokens` | integer | No | Min 1 | `8000` |
| `ttlSeconds` | integer | No | Min 0 | `3600` |
| `connection` | refOrLiteral | No | — | `$env:REDIS_URL` |

### `spec.memory.longTerm`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `backend` | enum | Yes | `postgres`, `sqlite`, `mongodb` | `postgres` |
| `connectionString` | refOrLiteral | Yes | — | `$env:DATABASE_URL` |
| `table` | string | No | — | `agent_sessions` |
| `ttlDays` | integer | No | Min 1 | `90` |

### `spec.memory.vector`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `backend` | enum | Yes | `pgvector`, `pinecone`, `weaviate`, `qdrant`, `chroma` | `pgvector` |
| `connectionString` | refOrLiteral | No | — | `$env:DATABASE_URL` |
| `apiKey` | refOrLiteral | No | — | `$env:PINECONE_API_KEY` |
| `dimension` | integer | Yes | Min 1 | `1536` |
| `topK` | integer | No | Min 1 | `5` |
| `namespace` | string | No | — | `budgetbud-docs` |

### `spec.memory.hygiene`

| Field | Type | Required | Default | Example |
|-------|------|----------|---------|---------|
| `piiScrubFields` | string[] | No | — | `[ssn, credit_card, bank_account]` |
| `auditLog` | boolean | No | `false` | `true` |
| `retentionPolicy` | string | No | — | `"90d"` |

```yaml
spec:
  memory:
    shortTerm:
      backend: redis
      maxTurns: 20
      maxTokens: 8000
      ttlSeconds: 3600
      connection: $env:REDIS_URL
    longTerm:
      backend: postgres
      connectionString: $env:DATABASE_URL
      table: agent_sessions
      ttlDays: 90
    vector:
      backend: pgvector
      connectionString: $env:DATABASE_URL
      dimension: 1536
      topK: 5
    hygiene:
      piiScrubFields: [ssn, credit_card, bank_account]
      auditLog: true
      retentionPolicy: "90d"
```

---

## `spec.subagents[]`

Optional. Delegates work to other agents, either local manifests or remote A2A endpoints.

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `name` | string | Yes | — | — | `observer` |
| `ref` | object | Yes | — | See below | — |
| `invocation` | enum | Yes | — | `parallel`, `sequential`, `on-demand` | `parallel` |
| `passContext` | boolean | No | `false` | — | `true` |
| `triggerKeywords` | string[] | No | — | — | `[report, analyze]` |

### `spec.subagents[].ref` — local file

```yaml
ref:
  agentspec: ./agents/observer.yaml
```

### `spec.subagents[].ref` — remote A2A

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `a2a.url` | refOrLiteral | Yes | — | `https://agents.example.com/observer` |
| `a2a.auth.type` | enum | No | `bearer`, `apikey`, `none` | `bearer` |
| `a2a.auth.token` | refOrLiteral | No | — | `$env:OBSERVER_TOKEN` |
| `a2a.auth.header` | string | No | — | `Authorization` |

```yaml
spec:
  subagents:
    - name: observer
      ref:
        agentspec: ./agents/observer.yaml
      invocation: parallel
      passContext: true
    - name: remote-classifier
      ref:
        a2a:
          url: https://agents.example.com/classifier
          auth:
            type: bearer
            token: $env:CLASSIFIER_TOKEN
      invocation: on-demand
      triggerKeywords: [classify, categorize]
```

---

## `spec.api`

Optional. Exposes the agent as an API endpoint.

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `type` | enum | Yes | — | `rest`, `mcp`, `grpc`, `websocket` | `rest` |
| `port` | integer | No | — | `1..65535` | `8000` |
| `pathPrefix` | string | No | — | — | `/api/v1` |
| `auth` | object | No | — | See below | — |
| `rateLimit` | object | No | — | See below | — |
| `streaming` | boolean | No | `false` | — | `true` |
| `healthEndpoint` | string | No | — | — | `/health` |
| `metricsEndpoint` | string | No | — | — | `/metrics` |
| `corsOrigins` | string[] | No | — | — | `["https://app.example.com"]` |
| `chatEndpoint` | object | No | — | See below | — |

### `spec.api.auth`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | enum | Yes | `jwt`, `apikey`, `oauth2`, `none` | `jwt` |
| `jwksUri` | refOrLiteral | No | Used with `jwt` | `$env:JWKS_URI` |
| `header` | string | No | — | `X-API-Key` |

### `spec.api.rateLimit`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `requestsPerMinute` | integer | No | Min 1 | `60` |
| `requestsPerHour` | integer | No | Min 1 | `1000` |

### `spec.api.chatEndpoint`

Configures the standard chat interface. Defaults to an OpenAI-compatible endpoint at `/v1/chat`.

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `path` | string | No | `/v1/chat` | — | `/v1/chat` |
| `protocol` | enum | No | `openai-compatible` | `openai-compatible`, `custom` | `openai-compatible` |
| `streaming` | boolean | No | `true` | — | `true` |
| `sessionMode` | enum | No | `stateful` | `stateful`, `stateless` | `stateful` |
| `threadIdHeader` | string | No | `X-Thread-Id` | — | `X-Thread-Id` |

`sessionMode: stateful` causes the agent to read and write conversation history keyed by the value in `threadIdHeader`. `sessionMode: stateless` treats every request as a new conversation.

```yaml
spec:
  api:
    type: rest
    port: 8000
    pathPrefix: /api/v1
    auth:
      type: jwt
      jwksUri: $env:JWKS_URI
    rateLimit:
      requestsPerMinute: 60
      requestsPerHour: 1000
    streaming: true
    healthEndpoint: /health
    metricsEndpoint: /metrics
    corsOrigins:
      - "https://app.example.com"
    chatEndpoint:
      path: /v1/chat
      protocol: openai-compatible
      streaming: true
      sessionMode: stateful
      threadIdHeader: X-Thread-Id
```

---

## `spec.skills[]`

Optional. Declares AgentSkill capabilities the agent exposes (used in A2A AgentCard export).

| Field | Type | Required | Example |
|-------|------|----------|---------|
| `id` | string | Yes | `expense-tracking` |
| `version` | string | No | `1.0.0` |

```yaml
spec:
  skills:
    - id: expense-tracking
      version: 1.0.0
    - id: budget-reporting
```

---

## `spec.guardrails`

Optional. Input and output filters that run before and after every model call.

### `spec.guardrails.input[]`

Each entry is one of the following discriminated types, selected by `type`.

#### `type: topic-filter`

Blocks requests about specified topics.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | `"topic-filter"` | Yes | — | `topic-filter` |
| `blockedTopics` | string[] | Yes | — | `[illegal_activity, violence]` |
| `action` | enum | Yes | `reject`, `warn`, `log` | `reject` |
| `message` | string | No | — | `"I can only help with finance."` |

#### `type: pii-detector`

Detects and optionally scrubs personally identifiable information.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | `"pii-detector"` | Yes | — | `pii-detector` |
| `action` | enum | Yes | `scrub`, `reject`, `warn` | `scrub` |
| `fields` | string[] | No | — | `[ssn, credit_card]` |

#### `type: prompt-injection`

Detects and blocks prompt injection attempts.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | `"prompt-injection"` | Yes | — | `prompt-injection` |
| `action` | enum | Yes | `reject`, `warn` | `reject` |
| `sensitivity` | enum | No | `low`, `medium`, `high` | `high` |

#### `type: custom` (input)

Calls a user-supplied function.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | `"custom"` | Yes | — | `custom` |
| `module` | string | Yes | — | `$file:guardrails/custom.py` |
| `function` | string | Yes | — | `run_input_check` |
| `action` | enum | Yes | `reject`, `warn`, `log` | `reject` |

### `spec.guardrails.output[]`

Each entry is one of the following discriminated types.

#### `type: hallucination-detector`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | `"hallucination-detector"` | Yes | — | `hallucination-detector` |
| `threshold` | number | Yes | `0..1` | `0.8` |
| `action` | enum | Yes | `reject`, `retry`, `warn` | `retry` |
| `maxRetries` | integer | No | `1..5` | `2` |

#### `type: toxicity-filter`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | `"toxicity-filter"` | Yes | — | `toxicity-filter` |
| `threshold` | number | Yes | `0..1` | `0.7` |
| `action` | enum | Yes | `reject`, `warn` | `reject` |

#### `type: pii-detector` (output)

Same shape as the input variant — scrubs PII from model responses before returning to the caller.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | `"pii-detector"` | Yes | — | `pii-detector` |
| `action` | enum | Yes | `scrub`, `reject`, `warn` | `scrub` |
| `fields` | string[] | No | — | `[ssn, credit_card]` |

#### `type: custom` (output)

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | `"custom"` | Yes | — | `custom` |
| `module` | string | Yes | — | `$file:guardrails/custom.py` |
| `function` | string | Yes | — | `run_output_check` |
| `action` | enum | Yes | `reject`, `warn`, `log` | `warn` |

```yaml
spec:
  guardrails:
    input:
      - type: topic-filter
        blockedTopics: [illegal_activity, violence]
        action: reject
        message: "I can only help with finance topics."
      - type: pii-detector
        action: scrub
        fields: [ssn, credit_card]
      - type: prompt-injection
        action: reject
        sensitivity: high
    output:
      - type: hallucination-detector
        threshold: 0.8
        action: retry
        maxRetries: 2
      - type: toxicity-filter
        threshold: 0.7
        action: reject
      - type: pii-detector
        action: scrub
        fields: [ssn, credit_card]
```

---

## `spec.humanInTheLoop`

Optional. Pauses agent execution for human review before sensitive actions are taken.

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `enabled` | boolean | No | `false` | — | `true` |
| `approvalRequired` | enum[] | No | — | See values below | `[before-destructive-tool]` |
| `timeoutSeconds` | integer | No | `300` | `1..3600` | `300` |
| `timeoutAction` | enum | No | `reject` | `reject`, `proceed`, `escalate` | `reject` |
| `notifyVia` | enum[] | No | — | `slack`, `email`, `webhook`, `console` | `[slack]` |
| `webhookUrl` | refOrLiteral | No | — | — | `$env:APPROVAL_WEBHOOK_URL` |

### `approvalRequired` values

| Value | Triggers approval when... |
|-------|--------------------------|
| `before-destructive-tool` | A tool with `annotations.destructiveHint: true` is about to be called |
| `before-external-call` | The agent is about to make an outbound HTTP / MCP call |
| `on-low-confidence` | The model's response confidence falls below an internal threshold |
| `on-high-cost` | The estimated token cost for the current turn exceeds `costControls.alertAtUSD` |
| `always` | Every agent action, regardless of type |

### `timeoutAction` values

| Value | Behaviour when the approval window expires |
|-------|--------------------------------------------|
| `reject` | Abort the action and return an error to the caller (default) |
| `proceed` | Continue without approval — treat as auto-approved |
| `escalate` | Escalate to the next `notifyVia` channel and extend the timeout |

```yaml
spec:
  humanInTheLoop:
    enabled: true
    approvalRequired:
      - before-destructive-tool
      - on-high-cost
    timeoutSeconds: 300
    timeoutAction: reject
    notifyVia:
      - slack
      - webhook
    webhookUrl: $env:APPROVAL_WEBHOOK_URL
```

---

## `spec.evaluation`

Optional. Evaluation framework and quality gate configuration.

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `framework` | enum | Yes | — | `deepeval`, `braintrust`, `langsmith`, `ragas`, `custom` | `deepeval` |
| `datasets` | object[] | No | — | See below | — |
| `metrics` | enum[] | No | — | See values below | `[faithfulness, hallucination]` |
| `thresholds` | record | No | — | Values `0..1` | `faithfulness: 0.85` |
| `ciGate` | boolean | No | `false` | — | `true` |

### `spec.evaluation.datasets[]`

| Field | Type | Required | Example |
|-------|------|----------|---------|
| `name` | string | Yes | `budget-qa` |
| `path` | refOrLiteral | Yes | `$file:eval/budget-qa.jsonl` |

### `metrics` values

`faithfulness`, `answer_relevancy`, `hallucination`, `toxicity`, `context_precision`, `context_recall`, `bias`, `custom`

```yaml
spec:
  evaluation:
    framework: deepeval
    datasets:
      - name: budget-qa
        path: $file:eval/datasets/budget-qa.jsonl
    metrics:
      - faithfulness
      - answer_relevancy
      - hallucination
      - toxicity
    thresholds:
      faithfulness: 0.85
      hallucination: 0.05
    ciGate: true
```

---

## `spec.observability`

Optional. Tracing, metrics, and structured logging.

### `spec.observability.tracing`

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `backend` | enum | Yes | — | `langfuse`, `langsmith`, `agentops`, `otel`, `honeycomb`, `datadog` | `langfuse` |
| `endpoint` | refOrLiteral | No | — | — | `$env:LANGFUSE_HOST` |
| `publicKey` | refOrLiteral | No | — | — | `$env:LANGFUSE_PUBLIC_KEY` |
| `secretKey` | refOrLiteral | No | — | — | `$secret:langfuse-secret-key` |
| `sampleRate` | number | No | `1.0` | `0..1` | `0.5` |

### `spec.observability.metrics`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `backend` | enum | Yes | `opentelemetry`, `prometheus`, `datadog` | `opentelemetry` |
| `endpoint` | refOrLiteral | No | — | `$env:OTEL_EXPORTER_OTLP_ENDPOINT` |
| `serviceName` | string | No | — | `budget-bud` |

### `spec.observability.logging`

| Field | Type | Required | Default | Constraints | Example |
|-------|------|----------|---------|-------------|---------|
| `level` | enum | No | `info` | `debug`, `info`, `warn`, `error` | `info` |
| `structured` | boolean | No | `true` | — | `true` |
| `redactFields` | string[] | No | — | — | `[api_key, password]` |

```yaml
spec:
  observability:
    tracing:
      backend: langfuse
      endpoint: $env:LANGFUSE_HOST
      publicKey: $env:LANGFUSE_PUBLIC_KEY
      secretKey: $secret:langfuse-secret-key
      sampleRate: 1.0
    metrics:
      backend: opentelemetry
      endpoint: $env:OTEL_EXPORTER_OTLP_ENDPOINT
      serviceName: budget-bud
    logging:
      level: info
      structured: true
      redactFields: [api_key, password]
```

---

## `spec.compliance`

Optional. Enables compliance pack scoring and suppression of known violations.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `packs` | enum[] | No | See values below | `[owasp-llm-top10]` |
| `suppressions` | object[] | No | See below | — |
| `auditSchedule` | enum | No | `daily`, `weekly`, `monthly`, `on-change` | `weekly` |

### `packs` values

| Pack | What it checks |
|------|---------------|
| `owasp-llm-top10` | OWASP LLM Top 10 security rules |
| `memory-hygiene` | PII scrubbing, TTL, audit logging |
| `model-resilience` | Fallback, version pinning, cost controls |
| `evaluation-coverage` | Evaluation framework and metrics coverage |
| `observability` | Tracing, metrics, and logging presence |

### `spec.compliance.suppressions[]`

| Field | Type | Required | Example |
|-------|------|----------|---------|
| `rule` | string | Yes | `SEC-LLM-08` |
| `reason` | string | Yes | `"Handled at the network layer"` |
| `approvedBy` | string | No | `"security-team"` |
| `expires` | string | No | `"2025-12-31"` (ISO date) |

```yaml
spec:
  compliance:
    packs:
      - owasp-llm-top10
      - memory-hygiene
      - model-resilience
      - evaluation-coverage
    suppressions:
      - rule: SEC-LLM-08
        reason: "Handled at the network layer"
        approvedBy: "security-team"
        expires: "2025-12-31"
    auditSchedule: weekly
```

---

## `spec.requires`

Optional. Declares runtime prerequisites so `agentspec health` can verify them before deployment.

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `envVars` | string[] | No | — | `[OPENAI_API_KEY, DATABASE_URL]` |
| `services` | object[] | No | See below | — |
| `minimumMemoryMB` | integer | No | Min 128 | `512` |
| `nodeVersion` | string | No | — | `">=20"` |
| `pythonVersion` | string | No | — | `">=3.11"` |

### `spec.requires.services[]`

| Field | Type | Required | Constraints | Example |
|-------|------|----------|-------------|---------|
| `type` | enum | Yes | `postgres`, `redis`, `mysql`, `mongodb`, `elasticsearch` | `postgres` |
| `connection` | refOrLiteral | Yes | — | `$env:DATABASE_URL` |

```yaml
spec:
  requires:
    envVars:
      - OPENAI_API_KEY
      - DATABASE_URL
      - REDIS_URL
    services:
      - type: postgres
        connection: $env:DATABASE_URL
      - type: redis
        connection: $env:REDIS_URL
    minimumMemoryMB: 512
    nodeVersion: ">=20"
    pythonVersion: ">=3.11"
```

---

## Full Manifest Example

The following is the complete BudgetBud manifest, which exercises every major section:

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: budget-bud
  version: 1.0.0
  description: "Personal finance AI assistant"
  tags: [finance, telegram]
  author: "Acme Corp"
  license: MIT

spec:
  model:
    provider: groq
    id: llama-3.3-70b-versatile
    apiKey: $env:GROQ_API_KEY
    parameters:
      temperature: 0.3
      maxTokens: 500
    fallback:
      provider: azure
      id: gpt-4
      apiKey: $env:AZURE_OPENAI_API_KEY
      triggerOn: [rate_limit, timeout, error_5xx]
      maxRetries: 2
    costControls:
      maxMonthlyUSD: 200
      alertAtUSD: 150

  prompts:
    system: $file:prompts/system.md
    fallback: "I'm experiencing difficulties. Please try again."
    hotReload: true
    variables:
      - name: current_date
        value: "$func:now_iso"
      - name: currency
        value: $env:DEFAULT_CURRENCY

  tools:
    - name: delete-expense
      type: function
      description: "Delete an expense record"
      module: $file:tools/impl.py
      function: delete_expense
      annotations:
        readOnlyHint: false
        destructiveHint: true

  mcp:
    servers:
      - name: postgres-db
        transport: stdio
        command: npx
        args: [-y, "@modelcontextprotocol/server-postgres"]
        env:
          DATABASE_URL: $env:DATABASE_URL
        healthCheck:
          timeoutSeconds: 5

  memory:
    shortTerm:
      backend: redis
      maxTurns: 20
      ttlSeconds: 3600
      connection: $env:REDIS_URL
    longTerm:
      backend: postgres
      connectionString: $env:DATABASE_URL
      table: agent_sessions
      ttlDays: 90
    hygiene:
      piiScrubFields: [ssn, credit_card]
      auditLog: true

  subagents:
    - name: observer
      ref:
        agentspec: ./agents/observer.yaml
      invocation: parallel
      passContext: true

  api:
    type: rest
    port: 8000
    pathPrefix: /api/v1
    auth:
      type: jwt
      jwksUri: $env:JWKS_URI
    rateLimit:
      requestsPerMinute: 60
    streaming: true
    healthEndpoint: /health
    metricsEndpoint: /metrics
    chatEndpoint:
      path: /v1/chat
      protocol: openai-compatible
      streaming: true
      sessionMode: stateful
      threadIdHeader: X-Thread-Id

  humanInTheLoop:
    enabled: true
    approvalRequired:
      - before-destructive-tool
      - on-high-cost
    timeoutSeconds: 300
    timeoutAction: reject
    notifyVia: [slack, webhook]
    webhookUrl: $env:APPROVAL_WEBHOOK_URL

  guardrails:
    input:
      - type: topic-filter
        blockedTopics: [illegal_activity, violence]
        action: reject
      - type: prompt-injection
        action: reject
        sensitivity: high
    output:
      - type: hallucination-detector
        threshold: 0.8
        action: retry
        maxRetries: 2
      - type: toxicity-filter
        threshold: 0.7
        action: reject

  evaluation:
    framework: deepeval
    metrics: [faithfulness, hallucination, toxicity]
    thresholds:
      faithfulness: 0.85
      hallucination: 0.05
    ciGate: true

  observability:
    tracing:
      backend: langfuse
      endpoint: $env:LANGFUSE_HOST
      publicKey: $env:LANGFUSE_PUBLIC_KEY
      secretKey: $secret:langfuse-secret-key
      sampleRate: 1.0
    metrics:
      backend: opentelemetry
      endpoint: $env:OTEL_EXPORTER_OTLP_ENDPOINT
      serviceName: budget-bud
    logging:
      level: info
      structured: true
      redactFields: [api_key, password]

  compliance:
    packs:
      - owasp-llm-top10
      - memory-hygiene
      - model-resilience
      - evaluation-coverage
    auditSchedule: weekly

  requires:
    envVars:
      - GROQ_API_KEY
      - DATABASE_URL
      - REDIS_URL
    services:
      - type: postgres
        connection: $env:DATABASE_URL
      - type: redis
        connection: $env:REDIS_URL
    minimumMemoryMB: 512
```

---

## See also

- [The agent.yaml Manifest](../concepts/manifest.md) — conceptual overview and reference syntax
- [Compliance Packs](../concepts/compliance.md) — scoring, rule IDs, and suppression workflow
- [Health Checks](../concepts/health-checks.md) — all check categories and their outputs
- [CLI Reference](./cli.md) — `validate`, `health`, `audit`, `generate`, `export`
