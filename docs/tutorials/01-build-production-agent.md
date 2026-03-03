# Build a Production-Ready Agent from Scratch

Take an agent from an empty directory to a Grade A, SDK-integrated, locally deployed service in one walkthrough.

**Time:** ~15 minutes
**Prerequisites:** Node.js 20+, Python 3.11+, Redis running locally, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`

---

## 1. Create the manifest interactively

```bash
mkdir my-agent && cd my-agent
npx agentspec init
```

The wizard prompts for:
- Agent name: `research-assistant`
- Model provider: `openai`
- Model ID: `gpt-4o`
- Features to enable: tools, guardrails, memory

It writes `agent.yaml` to the current directory.

---

## 2. Define the model and API key

Open `agent.yaml`. The model block should look like:

```yaml
spec:
  model:
    provider: openai
    id: gpt-4o
    apiKey: $env:OPENAI_API_KEY
    parameters:
      temperature: 0.3
      maxTokens: 4096
    fallback:
      provider: openai
      id: gpt-4o-mini
      apiKey: $env:OPENAI_API_KEY

  requires:
    envVars:
      - OPENAI_API_KEY
      - ANTHROPIC_API_KEY
```

The `$env:` syntax is resolved at runtime — the key is never written to disk.

---

## 3. Validate the manifest

```bash
npx agentspec validate agent.yaml
```

Expected output:
```
  AgentSpec Validate
  ──────────────────────
  ✓ Manifest valid — research-assistant v0.1.0 (agentspec.io/v1)

  Provider : openai/gpt-4o
  Tools    : 0
  MCP      : 0 servers
  Memory   : none
```

Fix any schema errors before continuing.

---

## 4. Add tools

Extend `agent.yaml` with two tools:

```yaml
spec:
  tools:
    - name: web_search
      description: Search the web for current information
      type: function
      parameters:
        query:
          type: string
          description: The search query
      module: $file:tools/web_search.py

    - name: file_reader
      description: Read a file from the local filesystem
      type: function
      parameters:
        path:
          type: string
          description: Absolute path to the file
      module: $file:tools/file_reader.py
```

Create stub tool files:

```bash
mkdir tools
echo "def web_search(query: str) -> str: ..." > tools/web_search.py
echo "def file_reader(path: str) -> str: ..." > tools/file_reader.py
```

---

## 5. Add guardrails

```yaml
spec:
  guardrails:
    input:
      - type: length
        maxTokens: 2000
      - type: blocklist
        patterns:
          - "ignore previous instructions"
          - "you are now"
    output:
      - type: pii_scrub
        fields: [email, phone, ssn]
      - type: length
        maxTokens: 8000
```

---

## 6. Add memory (Redis short-term)

```yaml
spec:
  memory:
    shortTerm:
      backend: redis
      url: $env:REDIS_URL
      ttlSeconds: 3600

  requires:
    envVars:
      - OPENAI_API_KEY
      - REDIS_URL
```

---

## 7. Set env vars and run health checks

```bash
export OPENAI_API_KEY=sk-...
export REDIS_URL=redis://localhost:6379
npx agentspec health agent.yaml
```

All checks should pass. If `model:openai/gpt-4o` fails, verify your API key is valid and has GPT-4o access. If `memory:redis` fails, verify Redis is running (`redis-cli ping`).

---

## 8. Run the compliance audit

```bash
npx agentspec audit agent.yaml
```

A typical starting score is around 55–65 (grade C). The audit output lists violations with severity badges.

Common violations at this stage:
- `MODEL-03` — model version not pinned (use `gpt-4o-2024-11-20` instead of `gpt-4o`)
- `EVAL-01` — no evaluation dataset defined
- `MEM-01` — no PII scrub confirmation on memory inputs

---

## 9. Fix violations to reach Grade B+

**Pin the model version:**

```yaml
spec:
  model:
    id: gpt-4o-2024-11-20   # pin to a specific snapshot
```

**Add an evaluation dataset:**

```yaml
spec:
  evaluation:
    datasets:
      - name: core
        path: $file:evals/core.jsonl
        metrics:
          - string_match
    thresholds:
      pass_rate: 0.85
```

```bash
mkdir evals
cat > evals/core.jsonl << 'EOF'
{"input": "What is the capital of France?", "expected": "Paris"}
{"input": "Who wrote Hamlet?", "expected": "Shakespeare"}
EOF
```

Re-run the audit:

```bash
npx agentspec audit agent.yaml
```

Target: score ≥ 75 (grade B) before generating code.

---

## 10. Generate LangGraph code

```bash
export ANTHROPIC_API_KEY=ant-...
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
```

Claude reads your full manifest — model, tools, memory, guardrails, evals — and generates:

```
generated/
├── agent.py          # LangGraph graph with all declared capabilities
├── requirements.txt
├── .env.example
└── README.md
```

---

## 11. Wire AgentSpecReporter into the FastAPI server

Install the Python SDK:

```bash
cd generated
pip install agentspec
```

Add to the top of `agent.py` (after imports, before `app = FastAPI()`):

```python
from agentspec import AgentSpecReporter

reporter = AgentSpecReporter.from_yaml("../agent.yaml")
reporter.start_push_mode(
    interval_seconds=30,
    control_plane_url=os.getenv("AGENTSPEC_URL", "http://localhost:4001"),
    api_key=os.getenv("AGENTSPEC_KEY", ""),
)
```

Start the agent:

```bash
pip install -r requirements.txt
uvicorn agent:app --port 8000
```

---

## 12. Verify declared vs proved with live audit

With the agent running locally, run the sidecar endpoint audit:

```bash
npx agentspec audit agent.yaml --url http://localhost:4000
```

The output now shows a **dual score**: declared (static analysis) + proved (live verification via sidecar). External-evidence rules show `[X]` badges and a pending proof count.

Your agent now has:
- Grade B+ manifest
- Pinned model version with fallback
- Input/output guardrails
- Redis memory with TTL
- Evaluation dataset
- Running FastAPI server with SDK reporter

---

## See also

- [Harden an Existing Agent](./02-harden-existing-agent) — scan-first workflow for legacy code
- [Deploy & Monitor](./03-deploy-and-monitor) — move from localhost to Kubernetes
- [Compliance Concepts](../concepts/compliance) — understand the scoring model
- [CLI Reference](../reference/cli) — all commands
