# Migrating gpt-researcher to AgentSpec

[gpt-researcher](https://github.com/assafelovic/gpt-researcher) is an autonomous research agent (~15k GitHub stars) that produces detailed, factual reports on any topic by orchestrating a pipeline of specialized subagents: researcher, editor, reviewer, reviser, writer, and publisher. This guide shows how to represent it as an `agent.yaml` manifest.

## What gpt-researcher Has

| Component | Current location | AgentSpec field |
|-----------|-----------------|-----------------|
| Model | `OPENAI_API_KEY` + openai client, GPT-4 default | `spec.model.provider: openai, id: gpt-4o` |
| Fallback | None (hardcoded model string) | `spec.model.fallback` (added as improvement) |
| System prompt | Inline strings in `gpt_researcher/prompts.py` | `spec.prompts.system: $file:prompts/system.md` |
| Tool: web search | `TavilySearch` via `TAVILY_API_KEY` | `spec.tools[web-search]` |
| Tool: URL scraping | `scrape_url()` in `gpt_researcher/scraper/` | `spec.tools[scrape-url]` |
| Tool: file read | `read_file()` in context utilities | `spec.tools[read-file]` |
| Tool: file write | `write_to_file()` for report output | `spec.tools[write-file]` |
| Tool: retriever config | `get_retriever()` for search backend selection | `spec.tools[get-retriever]` |
| Tool: web browse | `browse_web_page()` in scraper layer | `spec.tools[browse-web]` |
| Subagent: Researcher | `ResearchAgent` — gathers raw sources | `spec.subagents[researcher]` |
| Subagent: Editor | `EditorAgent` — plans report structure | `spec.subagents[editor]` |
| Subagent: Reviewer | `ReviewAgent` — evaluates draft quality | `spec.subagents[reviewer]` |
| Subagent: Reviser | `ReviserAgent` — incorporates review feedback | `spec.subagents[reviser]` |
| Subagent: Writer | `WriterAgent` — composes final report | `spec.subagents[writer]` |
| Subagent: Publisher | `PublisherAgent` — formats and outputs report | `spec.subagents[publisher]` |
| Memory | In-memory context dict, cleared per run | `spec.memory.shortTerm.backend: in-memory` |
| API | FastAPI on port 8000, `/report` endpoint + WebSocket | `spec.api.type: rest, port: 8000, streaming: true` |
| Observability | `print()` statements + optional LangChain tracing | `spec.observability.tracing.backend: langsmith` |
| Guardrails | None | `spec.guardrails` (added as improvement) |
| Compliance | None | `spec.compliance.packs` (added as improvement) |

## The Manifest

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: gpt-researcher
  version: 1.0.0
  description: "Autonomous research agent — orchestrates a six-role pipeline to produce detailed, cited reports on any topic"
  tags: [research, autonomous, multi-agent, web-search, report-generation]
  author: Assaf Elovic
  license: Apache-2.0

spec:
  model:
    provider: openai
    id: gpt-4o
    apiKey: $env:OPENAI_API_KEY
    parameters:
      temperature: 0.4
      maxTokens: 4000
    fallback:
      provider: openai
      id: gpt-3.5-turbo
      apiKey: $env:OPENAI_API_KEY
      triggerOn: [rate_limit, timeout, error_5xx]
      maxRetries: 3
    costControls:
      maxMonthlyUSD: 300
      alertAtUSD: 240

  prompts:
    system: $file:prompts/system.md
    fallback: "Research service is temporarily unavailable. Please retry your request."
    variables:
      - name: current_date
        value: "$func:now_iso"

  tools:
    - name: web-search
      type: function
      description: "Search the web for sources using Tavily Search API; returns ranked URLs with snippets"
      module: $file:gpt_researcher/retrievers/tavily_search.py
      function: search
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: false
        openWorldHint: true

    - name: scrape-url
      type: function
      description: "Scrape and extract the full text content of a given URL for source analysis"
      module: $file:gpt_researcher/scraper/scraper.py
      function: scrape_url
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: true
        openWorldHint: true

    - name: read-file
      type: function
      description: "Read a local file from disk for use as research context or source material"
      module: $file:gpt_researcher/utils/file_handler.py
      function: read_file
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: true

    - name: write-file
      type: function
      description: "Write the final research report to a local file in the specified output format (md, pdf, docx)"
      module: $file:gpt_researcher/utils/file_handler.py
      function: write_to_file
      annotations:
        readOnlyHint: false
        destructiveHint: true
        idempotentHint: false

    - name: get-retriever
      type: function
      description: "Resolve and return the configured search retriever backend (tavily, google, serper, duckduckgo)"
      module: $file:gpt_researcher/retrievers/retriever.py
      function: get_retriever
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: true

    - name: browse-web
      type: function
      description: "Load and browse a full web page, executing JavaScript where needed, for deep content extraction"
      module: $file:gpt_researcher/scraper/browser.py
      function: browse_web_page
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: false
        openWorldHint: true

  subagents:
    - name: researcher
      ref:
        agentspec: subagents/researcher.yaml
      invocation: sequential
      passContext: true
      triggerKeywords: [research, gather, sources, search]

    - name: editor
      ref:
        agentspec: subagents/editor.yaml
      invocation: sequential
      passContext: true
      triggerKeywords: [outline, structure, plan, sections]

    - name: reviewer
      ref:
        agentspec: subagents/reviewer.yaml
      invocation: sequential
      passContext: true
      triggerKeywords: [review, evaluate, critique, quality]

    - name: reviser
      ref:
        agentspec: subagents/reviser.yaml
      invocation: sequential
      passContext: true
      triggerKeywords: [revise, refine, improve, update]

    - name: writer
      ref:
        agentspec: subagents/writer.yaml
      invocation: sequential
      passContext: true
      triggerKeywords: [write, compose, draft, report]

    - name: publisher
      ref:
        agentspec: subagents/publisher.yaml
      invocation: sequential
      passContext: true
      triggerKeywords: [publish, format, output, export]

  memory:
    shortTerm:
      backend: in-memory
      maxTurns: 100
      maxTokens: 32000
    hygiene:
      piiScrubFields: []
      auditLog: false

  api:
    type: rest
    port: 8000
    pathPrefix: /api/v1
    auth:
      type: none
    rateLimit:
      requestsPerMinute: 10
      requestsPerHour: 100
    streaming: true
    healthEndpoint: /health
    corsOrigins:
      - "http://localhost:3000"

  observability:
    tracing:
      backend: langsmith
      publicKey: $env:LANGCHAIN_API_KEY
      sampleRate: 1.0
    logging:
      level: info
      structured: true
      redactFields: [OPENAI_API_KEY, TAVILY_API_KEY, LANGCHAIN_API_KEY]

  guardrails:
    input:
      - type: prompt-injection
        action: reject
        sensitivity: high
    output:
      - type: toxicity-filter
        threshold: 0.85
        action: reject

  compliance:
    packs:
      - owasp-llm-top10
      - model-resilience
    auditSchedule: on-change

  requires:
    envVars:
      - OPENAI_API_KEY
      - TAVILY_API_KEY
    minimumMemoryMB: 1024
    pythonVersion: "3.11"
```

## Running the Migration

```bash
# 1. Copy agent.yaml into your gpt-researcher checkout
cp agent.yaml /path/to/gpt-researcher/agent.yaml
cd /path/to/gpt-researcher

# 2. Validate the manifest (no I/O required)
agentspec validate agent.yaml
# ✓ agent.yaml is valid

# 3. Health check (requires OPENAI_API_KEY and TAVILY_API_KEY)
export OPENAI_API_KEY=sk-...
export TAVILY_API_KEY=tvly-...
agentspec health agent.yaml
# ✓ env:OPENAI_API_KEY    present
# ✓ env:TAVILY_API_KEY    present
# ✓ openai API            reachable (HTTP 200)
# ✗ langsmith tracing     LANGCHAIN_API_KEY not set (optional — tracing disabled)

# 4. Run the full compliance audit
agentspec audit agent.yaml
# Score: ~74/100 (C)  — see breakdown below
```

The score of ~74/100 (grade C) reflects the base gpt-researcher architecture. The two largest gaps are the absence of persistent memory (which disqualifies several memory-hygiene rules) and the use of `$env:` instead of `$secret:` for API key storage.

## Audit Results

| Rule ID | Pack | Status | Reason |
|---------|------|--------|--------|
| MODEL-01 | model-resilience | pass | Fallback `gpt-3.5-turbo` declared with `triggerOn` conditions |
| MODEL-02 | model-resilience | pass | Model version explicitly pinned (`gpt-4o`, not `gpt-4-latest`) |
| MODEL-03 | model-resilience | pass | Cost controls set: `maxMonthlyUSD: 300`, `alertAtUSD: 240` |
| MODEL-04 | model-resilience | fail | No model version lock file (e.g. no `model.lock`) — minor |
| SEC-LLM-01 | owasp-llm-top10 | pass | Prompt injection guard configured (`sensitivity: high`) |
| SEC-LLM-02 | owasp-llm-top10 | pass | Output toxicity filter configured (`threshold: 0.85`) |
| SEC-LLM-03 | owasp-llm-top10 | pass | Rate limiting declared (`10 req/min`) |
| SEC-LLM-04 | owasp-llm-top10 | pass | No long-term data store declared — supply chain risk N/A |
| SEC-LLM-05 | owasp-llm-top10 | pass | `write-file` marked `destructiveHint: true` — surfaces for review |
| SEC-LLM-06 | owasp-llm-top10 | pass | No persistent memory — no PII retention risk |
| SEC-LLM-07 | owasp-llm-top10 | pass | No plugin / auto-execution chain beyond declared tools |
| SEC-LLM-08 | owasp-llm-top10 | fail | `write-file` is destructive but no confirmation step is required |
| SEC-LLM-09 | owasp-llm-top10 | fail | No `evaluation` block — CI gate cannot be enforced |
| SEC-LLM-10 | owasp-llm-top10 | fail | API keys use `$env:` not `$secret:` — keys exposed in process environment |

### Improving the Score

To reach grade B (75+), address these three items:

**1. Use secret manager for API keys (SEC-LLM-10)**

Replace `$env:` references with `$secret:` to pull from HashiCorp Vault, AWS Secrets Manager, or equivalent:

```yaml
spec:
  model:
    apiKey: $secret:openai-api-key
  observability:
    tracing:
      publicKey: $secret:langchain-api-key
```

```bash
export AGENTSPEC_SECRET_BACKEND=vault   # or aws / gcp / azure
```

**2. Add a confirmation step for file writes (SEC-LLM-08)**

Add a `custom` guardrail that prompts the user before `write-file` executes:

```yaml
spec:
  guardrails:
    input:
      - type: prompt-injection
        action: reject
        sensitivity: high
      - type: custom
        module: $file:guardrails/confirm_write.py
        function: require_write_confirmation
        action: warn
```

**3. Add an evaluation block (SEC-LLM-09)**

```yaml
spec:
  evaluation:
    framework: ragas
    metrics:
      - faithfulness
      - answer_relevancy
      - context_recall
    thresholds:
      faithfulness: 0.80
      answer_relevancy: 0.75
    ciGate: true
```

With all three applied, the expected score rises to ~88/100 (grade B).

## Generating LangGraph Code

```bash
export ANTHROPIC_API_KEY=your-api-key-here
agentspec generate agent.yaml --framework langgraph --output ./generated/
```

This produces a `generated/` directory with:

```
generated/
├── agent.py            # StateGraph with 6-node research pipeline
├── guardrails.py       # Prompt-injection check + toxicity filter
├── requirements.txt    # langchain-openai, langgraph, tavily-python, ...
└── .env.example        # OPENAI_API_KEY, TAVILY_API_KEY, LANGCHAIN_API_KEY
```

The generated `agent.py` includes:

- `ChatOpenAI(model="gpt-4o")` with `llm.with_fallbacks([ChatOpenAI(model="gpt-3.5-turbo")])` for automatic failover
- All 6 tool functions bound to the model via `llm.bind_tools(tools)`
- `MemorySaver` in-memory checkpointer (matches `spec.memory.shortTerm.backend: in-memory`)
- LangSmith tracing enabled via `LANGCHAIN_TRACING_V2=true` in the environment
- Sequential six-node pipeline: `researcher → editor → reviewer → reviser → writer → publisher`
- `guardrails.py` with `run_input_guardrails()` and `run_output_guardrails()` stubs with TODO comments for Rebuff (prompt injection) and Detoxify (toxicity) integration

## Export as AgentCard

```bash
agentspec export agent.yaml --format agentcard
```

```json
{
  "name": "gpt-researcher",
  "description": "Autonomous research agent — orchestrates a six-role pipeline to produce detailed, cited reports on any topic",
  "version": "1.0.0",
  "url": "http://localhost:8000/api/v1",
  "capabilities": {
    "streaming": true,
    "stateTransitionHistory": false
  },
  "skills": [
    { "id": "web-search" },
    { "id": "scrape-url" },
    { "id": "read-file" },
    { "id": "write-file" },
    { "id": "get-retriever" },
    { "id": "browse-web" }
  ]
}
```

The AgentCard can be published to any A2A-compatible registry, making gpt-researcher discoverable and composable by orchestrator agents.

## See Also

- [The agent.yaml manifest](../concepts/manifest.md) — full field reference
- [Compliance packs](../concepts/compliance.md) — OWASP LLM Top 10 rule details
- [LangGraph adapter](../adapters/langgraph.md) — what the generated code looks like
- [Add guardrails](./add-guardrails.md) — step-by-step guardrail configuration
