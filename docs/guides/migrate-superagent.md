# Migrating SuperAgent to AgentSpec

[SuperAgent](https://github.com/superagent-ai/superagent) is a popular open-source agent platform with a REST API, tool integrations (web search, code interpreter, document Q&A), and memory. This guide captures its architecture in `agent.yaml`.

## What SuperAgent Has

| Component | SuperAgent | AgentSpec field |
|-----------|-----------|-----------------|
| Model | OpenAI, Anthropic, Mistral (configurable) | `spec.model` |
| Tools | Web search, code interpreter, Replicate models | `spec.tools[]` |
| Memory | Postgres (long-term), in-memory (short-term) | `spec.memory` |
| API | REST API on port 8080 | `spec.api` |
| MCP | No (predates MCP) | — |
| Observability | Langfuse (optional) | `spec.observability` |
| Auth | JWT / API key | `spec.api.auth` |

## The Manifest

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: superagent
  version: 2.0.0
  description: "Open-source AI agent platform with tools, memory, and REST API"
  tags: [platform, api, tools, document-qa, code-interpreter]
  license: MIT

spec:
  model:
    provider: openai
    id: gpt-4-0125-preview
    apiKey: $env:OPENAI_API_KEY
    parameters:
      temperature: 0.2
      maxTokens: 4000
    fallback:
      provider: anthropic
      id: claude-haiku-4-5-20251001
      apiKey: $env:ANTHROPIC_API_KEY
      triggerOn: [rate_limit, timeout, error_5xx]
      maxRetries: 2
    costControls:
      maxMonthlyUSD: 1000
      alertAtUSD: 800

  prompts:
    system: $file:libs/superagent/prompts/default_agent.txt
    fallback: "I'm temporarily unavailable. Please try again."

  tools:
    - name: web-search
      type: function
      description: "Search the web using SerpAPI or Bing"
      module: $file:libs/superagent/tools/web_search.py
      function: web_search
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: false
        openWorldHint: true

    - name: code-executor
      type: function
      description: "Execute Python code in a sandboxed environment"
      module: $file:libs/superagent/tools/code_executor.py
      function: execute_code
      annotations:
        readOnlyHint: false
        destructiveHint: false
        idempotentHint: false

    - name: document-retrieval
      type: function
      description: "Retrieve relevant chunks from uploaded documents via vector search"
      module: $file:libs/superagent/tools/document_retrieval.py
      function: retrieve_documents
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: true

    - name: browser
      type: function
      description: "Browse and extract content from URLs"
      module: $file:libs/superagent/tools/browser.py
      function: browse_url
      annotations:
        readOnlyHint: true
        destructiveHint: false
        openWorldHint: true

  memory:
    shortTerm:
      backend: in-memory
      maxTurns: 10
      maxTokens: 12000

    longTerm:
      backend: postgres
      connectionString: $env:DATABASE_URL
      table: agent_sessions
      ttlDays: 30

    vector:
      backend: pgvector
      connectionString: $env:DATABASE_URL
      dimension: 1536
      topK: 5
      namespace: superagent

    hygiene:
      piiScrubFields: [email, phone, ssn]
      auditLog: true

  api:
    type: rest
    port: 8080
    pathPrefix: /api/v1
    auth:
      type: jwt
      jwksUri: $env:JWKS_URI
    rateLimit:
      requestsPerMinute: 30
    streaming: true
    healthEndpoint: /health
    metricsEndpoint: /metrics

  guardrails:
    input:
      - type: prompt-injection
        action: reject
        sensitivity: high
      - type: pii-detector
        action: scrub
        fields: [ssn, credit_card]
    output:
      - type: toxicity-filter
        threshold: 0.75
        action: reject

  observability:
    tracing:
      backend: langfuse
      endpoint: $env:LANGFUSE_HOST
      publicKey: $env:LANGFUSE_PUBLIC_KEY
      secretKey: $secret:langfuse-secret-key
      sampleRate: 0.5
    logging:
      level: info
      structured: true
      redactFields: [api_key, password, token]

  evaluation:
    framework: deepeval
    metrics:
      - faithfulness
      - answer_relevancy
      - hallucination
    thresholds:
      hallucination: 0.1
    ciGate: true

  compliance:
    packs:
      - owasp-llm-top10
      - memory-hygiene
      - model-resilience
      - evaluation-coverage
    auditSchedule: weekly

  requires:
    envVars:
      - OPENAI_API_KEY
      - ANTHROPIC_API_KEY
      - DATABASE_URL
      - LANGFUSE_HOST
      - LANGFUSE_PUBLIC_KEY
    services:
      - type: postgres
        connection: $env:DATABASE_URL
    minimumMemoryMB: 1024
```

## Running the Migration

```bash
# 1. Validate
npx agentspec validate agent.yaml
# ✓ Manifest valid — superagent v2.0.0 (agentspec.io/v1)

# 2. Health check
npx agentspec health agent.yaml

# 3. Audit
npx agentspec audit agent.yaml
# Expected: ~87/100 (B) — strong config, only missing $secret for API keys
```

## Expected Audit Score

| Pack | Score | Key violations |
|------|-------|---------------|
| owasp-llm-top10 | 78% | SEC-LLM-10 ($env vs $secret) |
| model-resilience | 100% | All rules pass |
| memory-hygiene | 90% | MEM-04 (namespace set ✓) |
| evaluation-coverage | 85% | EVAL-02 (CI gate ✓) |

**Overall: 87/100 (B)**

## Generate LangGraph Code

```bash
npm install @agentspec/adapter-langgraph
npx agentspec generate agent.yaml --framework langgraph --output ./superagent-langgraph/
```

Generated files:
```
superagent-langgraph/
├── agent.py          # GPT-4 + Claude Haiku fallback, pgvector memory
├── guardrails.py     # Input/output guardrail stubs
├── requirements.txt  # langchain-openai, langchain-anthropic, langgraph...
├── .env.example
└── README.md
```

## Key Differences vs SuperAgent's Architecture

| SuperAgent native | AgentSpec-generated |
|---|---|
| FastAPI framework | FastAPI server generated by `--include-api-server` |
| Custom agent loop | LangGraph ReAct graph |
| Postgres ORM (Prisma) | LangGraph `SqliteSaver` / Postgres checkpointer |
| Redis pub/sub | N/A (no streaming bridge needed in LangGraph) |
| Supabase vector | pgvector via LangChain |
