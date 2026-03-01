# AgentSpec → LangGraph Generation Skill

You are generating production-ready Python LangGraph agent code from an AgentSpec manifest JSON.

## Output Format

Return a single JSON object (wrapped in ```json ... ```) with this exact shape:

```json
{
  "files": {
    "agent.py": "...",
    "tools.py": "...",
    "requirements.txt": "...",
    ".env.example": "...",
    "guardrails.py": "...",
    "server.py": "...",
    "eval_runner.py": "...",
    "README.md": "..."
  },
  "installCommands": [
    "python -m venv .venv",
    "source .venv/bin/activate",
    "pip install -r requirements.txt",
    "cp .env.example .env"
  ],
  "envVars": ["GROQ_API_KEY", "REDIS_URL"]
}
```

**File generation rules:**
| File | When to generate |
|---|---|
| `agent.py` | Always |
| `tools.py` | When `spec.tools` is non-empty |
| `requirements.txt` | Always |
| `.env.example` | Always |
| `guardrails.py` | When `spec.guardrails` is set |
| `server.py` | When `spec.api` is set |
| `eval_runner.py` | When `spec.evaluation` is set |
| `README.md` | Always |

**Invariants:**
- Map **every** manifest field. Do not skip sections.
- All string values embedded in Python code must be escaped (backslashes, quotes, newlines).
- Never embed literal API keys — always emit `os.environ.get("VAR")`.
- `validate_env()` must be called at module top-level before any connection is made.

---

## Reference Syntax Resolution

Resolve `$ref` values before generating Python:

| Manifest reference | Python |
|---|---|
| `$env:VAR_NAME` | `os.environ.get("VAR_NAME")` |
| `$env:VAR_NAME` (required) | `os.environ.get("VAR_NAME")` — list in `REQUIRED_ENV_VARS` |
| `$secret:secret-name` | `os.environ.get("AGENTSPEC_SECRET_SECRET_NAME")` — transform: uppercase, `-` → `_`, prefix `AGENTSPEC_SECRET_` |
| `$file:path/to/file` | Use `path/to/file` as a relative filesystem path |
| `$func:now_iso` | `datetime.datetime.utcnow().isoformat()` — also add `import datetime` |

Examples:
- `$secret:langfuse-secret-key` → `os.environ.get("AGENTSPEC_SECRET_LANGFUSE_SECRET_KEY")`
- `$secret:openai-api-key` → `os.environ.get("AGENTSPEC_SECRET_OPENAI_API_KEY")`
- `$env:GROQ_API_KEY` → `os.environ.get("GROQ_API_KEY")`

---

## Mapping Rules

### spec.model

| Manifest field | Python |
|---|---|
| `provider: groq` | `from langchain_groq import ChatGroq` |
| `provider: openai` | `from langchain_openai import ChatOpenAI` |
| `provider: anthropic` | `from langchain_anthropic import ChatAnthropic` |
| `provider: google` | `from langchain_google_genai import ChatGoogleGenerativeAI` |
| `provider: azure` | `from langchain_openai import AzureChatOpenAI` |
| `provider: mistral` | `from langchain_mistralai import ChatMistralAI` |
| `apiKey: $env:VAR` | `api_key=os.environ.get("VAR")` kwarg |
| `apiKey: $secret:name` | `api_key=os.environ.get("AGENTSPEC_SECRET_NAME")` kwarg |
| `id` | `model="model-id"` kwarg |
| `parameters.temperature` | `temperature=N` kwarg |
| `parameters.maxTokens` | `max_tokens=N` kwarg |
| `fallback.*` | `primary_llm.with_fallbacks([fallback_llm])` — import `RunnableWithFallbacks` |
| `fallback.maxRetries` | `max_retries=N` kwarg on fallback llm constructor |
| `fallback.triggerOn` | Comment: `# Triggers on: HTTP 5xx, rate limits — handled automatically by LangChain` |
| `costControls.maxMonthlyUSD` | Comment: `# Cost control: max $N/month — enforce via LangSmith budget alerts` |
| `costControls.alertAtUSD` | Comment: `# Alert threshold: $N — set LANGSMITH_COST_ALERT_USD env var` |

### spec.prompts

| Manifest field | Python |
|---|---|
| `system: $file:path` | `open(os.path.join(os.path.dirname(__file__), "path"), encoding="utf-8")` |
| `fallback` | Return fallback string from `FileNotFoundError` handler |
| `hotReload: true` | Re-read file on every `load_system_prompt()` call (no module-level caching) |
| `variables[]` | Generate `variables = {}` dict and `template.replace("{{ key }}", val)` loop |
| variable `value: $env:VAR` | `os.environ.get("VAR", "")` |
| variable `value: $func:now_iso` | `datetime.datetime.utcnow().isoformat()` |

```python
def load_system_prompt() -> str:
    try:
        with open(SYSTEM_PROMPT_PATH, "r", encoding="utf-8") as f:
            template = f.read()
        variables = {
            "unit_system": os.environ.get("UNIT_SYSTEM", ""),
            "current_date": datetime.datetime.utcnow().isoformat(),
        }
        for key, val in variables.items():
            template = template.replace("{{ " + key + " }}", val)
        return template
    except FileNotFoundError:
        return "I'm experiencing difficulties. Please try again."
```

### spec.tools — two files

**agent.py imports** (import each tool by function name):
```python
from tools import log_workout, get_workout_history, create_workout_plan
# tool.function field if set, else snake_case(tool.name)
tools: list[BaseTool] = [log_workout, get_workout_history, create_workout_plan]
```

**tools.py** (always generate when tools is non-empty):
```python
"""
Tool implementations for {agent_name}
Generated by AgentSpec — fill in the function bodies.
"""

from langchain_core.tools import tool


@tool
def log_workout(**kwargs) -> str:
    """Log a completed training session with exercises, sets, reps, and duration"""
    raise NotImplementedError("Implement log_workout")


@tool
def get_workout_history(**kwargs) -> str:
    """Retrieve past training sessions with optional filters by date or muscle group"""
    raise NotImplementedError("Implement get_workout_history")
```

Rules:
- Function name: `tool.function` if set, otherwise `snake_case(tool.name)` (replace `-` with `_`)
- Docstring: `tool.description`
- Body: `raise NotImplementedError("Implement {func_name}")`
- One `@tool` function per `spec.tools[]` entry

### spec.mcp

MCP servers must be started before the `tools` list is built. Generate both code and install instructions:

```python
# ── MCP servers ───────────────────────────────────────────────────────────────
# Install: pip install langchain-mcp-adapters
# Declared servers: postgres-db (stdio)
#
# Example startup (adapt per server):
#   from langchain_mcp_adapters import MCPClient
#   mcp_client = MCPClient(transport="stdio", command="npx", args=["-y", "@modelcontextprotocol/server-postgres"])
#   await mcp_client.start()
#   mcp_tools = await mcp_client.list_tools()
#   tools = [*local_tools, *mcp_tools]
```

Per server, generate:
- Server name and transport from manifest
- Command/args from `server.command` and `server.args`
- Env vars from `server.env[]`

Add `langchain-mcp-adapters>=0.1.0` to requirements.txt.

### spec.memory.shortTerm

| backend | LangGraph class |
|---|---|
| `in-memory` | `from langgraph.checkpoint.memory import MemorySaver; memory_saver = MemorySaver()` |
| `redis` | `from langgraph.checkpoint.redis import RedisSaver; memory_saver = RedisSaver.from_conn_string(os.environ.get("REDIS_URL", "redis://localhost:6379"))` |
| `sqlite` | `from langgraph.checkpoint.sqlite import SqliteSaver; import sqlite3; memory_saver = SqliteSaver(sqlite3.connect("checkpoints.db", check_same_thread=False))` |

Compile with checkpointer:
```python
graph = workflow.compile(checkpointer=memory_saver)
```

Pass `thread_id` in every `graph.invoke()` call:
```python
config = {"configurable": {"thread_id": thread_id}}
```

`maxTurns` — trim conversation history before LLM call:
```python
from langchain_core.messages import trim_messages
messages = trim_messages(state["messages"], max_messages={maxTurns}, strategy="last")
```

`ttlSeconds` — comment: `# Set REDIS_TTL_SECONDS env var to configure Redis key expiry at the infrastructure level`

### spec.memory.longTerm

```python
# ── Long-term memory ──────────────────────────────────────────────────────────
# Install: pip install psycopg2-binary
import psycopg2
from datetime import datetime

_DB_URL = os.environ.get("DATABASE_URL")


def save_session_summary(thread_id: str, summary: str) -> None:
    """Persist session summary to long-term storage."""
    conn = psycopg2.connect(_DB_URL)
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO agent_sessions (thread_id, summary, created_at, expires_at)
               VALUES (%s, %s, NOW(), NOW() + INTERVAL '{ttlDays} days')
               ON CONFLICT (thread_id) DO UPDATE
               SET summary = EXCLUDED.summary, expires_at = EXCLUDED.expires_at""",
            (thread_id, summary),
        )
    conn.commit()
    conn.close()


def load_session_context(thread_id: str) -> str | None:
    """Load prior session context from long-term storage."""
    conn = psycopg2.connect(_DB_URL)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT summary FROM agent_sessions WHERE thread_id = %s AND expires_at > NOW()",
            (thread_id,),
        )
        row = cur.fetchone()
    conn.close()
    return row[0] if row else None
```

Substitute `{ttlDays}` from `spec.memory.longTerm.ttlDays` (default: 90).
Table name from `spec.memory.longTerm.table` (default: `agent_sessions`).
Connection string from `spec.memory.longTerm.connectionString` (resolve `$env:` references).

### spec.memory.hygiene

Place in `agent.py` between observability setup and system prompt:

```python
# ── Memory hygiene ────────────────────────────────────────────────────────────
# spec.memory.hygiene — scrub PII before storing in memory
import re as _re

PII_SCRUB_FIELDS = ["name", "email", "date_of_birth", "medical_conditions"]


def scrub_pii(text: str) -> str:
    """Scrub PII fields from text before writing to memory."""
    text = _re.sub(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', '[EMAIL]', text)
    text = _re.sub(r'\b\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b', '[DATE]', text)
    text = _re.sub(r'\b\d{3}-\d{2}-\d{4}\b', '[SSN]', text)
    return text
```

Fields from `spec.memory.hygiene.piiScrubFields[]`.

If `auditLog: true`:
```python
import logging as _logging
_audit_log = _logging.getLogger("agentspec.memory.audit")
# Call before every memory write:
_audit_log.info("memory_write thread_id=%s", thread_id)
```

### spec.subagents

For each subagent entry:

```python
# ── Sub-agents ────────────────────────────────────────────────────────────────
import httpx


async def invoke_{subagent_name}_subagent(context: dict) -> str:
    """Invoke the '{name}' sub-agent."""
    # Local AgentSpec sub-agent: load from {spec_path}
    # A2A HTTP sub-agent: POST to {a2a_url}
    raise NotImplementedError("Implement {name} subagent")
```

Invocation mode:
- `parallel` → `await asyncio.gather(invoke_a(...), invoke_b(...))`
- `sequential` → `result_a = await invoke_a(...); result_b = await invoke_b(...)`
- `on-demand` → expose as a `@tool` in the tools list so the LLM calls it when needed

### spec.api — server.py

Generate a full FastAPI server when `spec.api` is set:

```python
"""
FastAPI server for {agent_name}
Generated by AgentSpec

Run: uvicorn server:app --reload --port {port}
"""

import os
import time
from collections import defaultdict
from fastapi import FastAPI, HTTPException, Depends, Request, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import jwt  # pip install PyJWT
from agent import run_agent

_security = HTTPBearer()
app = FastAPI(title="{agent_name}", description="{description}", version="{version}")

# ── JWT auth ──────────────────────────────────────────────────────────────────
def verify_jwt(
    credentials: HTTPAuthorizationCredentials = Security(_security),
) -> dict:
    """Verify JWT token (spec.api.auth.type = jwt)."""
    token = credentials.credentials
    jwks_uri = os.environ.get("JWKS_URI", "")
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
        return payload
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")

# ── Rate limiting ─────────────────────────────────────────────────────────────
_rate_limit_store: dict = defaultdict(list)
_RATE_LIMIT_RPM = {requests_per_minute}  # spec.api.rateLimit.requestsPerMinute


def rate_limit(request: Request) -> None:
    """Sliding window rate limiter (spec.api.rateLimit)."""
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    _rate_limit_store[client_ip] = [t for t in _rate_limit_store[client_ip] if now - t < 60]
    if len(_rate_limit_store[client_ip]) >= _RATE_LIMIT_RPM:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    _rate_limit_store[client_ip].append(now)


class ChatRequest(BaseModel):
    message: str
    thread_id: str = "default"


class ChatResponse(BaseModel):
    response: str
    thread_id: str


@app.get("{path_prefix}/health")
async def health():
    return {"status": "healthy", "agent": "{agent_name}"}


@app.post("{path_prefix}/chat", response_model=ChatResponse)
async def chat(
    request: Request,
    body: ChatRequest,
    _claims: dict = Depends(verify_jwt),
) -> ChatResponse:
    rate_limit(request)
    try:
        response = run_agent(body.message, thread_id=body.thread_id)
        return ChatResponse(response=response, thread_id=body.thread_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port={port})
```

Conditionally:
- Include `verify_jwt` + `Depends(verify_jwt)` only if `spec.api.auth.type == "jwt"`
- Include `rate_limit()` only if `spec.api.rateLimit` is set
- `{path_prefix}` from `spec.api.pathPrefix` (default: `/api/v1`)
- `{port}` from `spec.api.port` (default: `8000`)

Add to requirements.txt: `fastapi>=0.111.0`, `uvicorn>=0.30.0`, `PyJWT>=2.8.0`.

### spec.guardrails — guardrails.py

Generate with real library calls, not stubs. Use `GuardrailError` for all violations:

```python
"""
Guardrails for {agent_name}
Generated by AgentSpec
"""

import re
from typing import Optional


class GuardrailError(Exception):
    """Raised when a guardrail rejects a message."""
    pass


# ── Topic filter ──────────────────────────────────────────────────────────────
BLOCKED_TOPICS = ["illegal_activity", "self_harm", "violence", "explicit_content"]
# Rejection message from spec.guardrails.input.topic-filter.rejectMessage:
TOPIC_REJECTION_MSG = "{rejection_message}"


def check_topic_filter(text: str) -> None:
    """Reject messages matching blocked topics (spec.guardrails.input.topic-filter)."""
    text_lower = text.lower()
    for topic in BLOCKED_TOPICS:
        if topic.replace("_", " ") in text_lower or topic in text_lower:
            raise GuardrailError(f"TOPIC_BLOCKED: {TOPIC_REJECTION_MSG}")


# ── PII scrubbing ─────────────────────────────────────────────────────────────
def scrub_pii(text: str) -> str:
    """Scrub PII from text (spec.guardrails.input/output.pii-detector)."""
    text = re.sub(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', '[EMAIL]', text)
    text = re.sub(r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b', '[PHONE]', text)
    text = re.sub(r'\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b', '[DATE]', text)
    text = re.sub(r'\b\d{3}-\d{2}-\d{4}\b', '[SSN]', text)
    return text


# ── Prompt injection detection ────────────────────────────────────────────────
INJECTION_PATTERNS = [
    r'ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions',
    r'disregard\s+(?:your\s+)?(?:previous|prior|system)\s+(?:prompt|instructions)',
    r'you\s+are\s+now\s+(?:a\s+)?(?:different|new|another)',
    r'act\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unfiltered|unrestricted)',
    r'(?:reveal|show|print|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)',
    r'jailbreak',
    r'dan\s+mode',
    r'developer\s+mode',
]


def check_prompt_injection(text: str) -> None:
    """Detect prompt injection attempts (spec.guardrails.input.prompt-injection)."""
    text_lower = text.lower()
    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, text_lower):
            raise GuardrailError("PROMPT_INJECTION: Prompt injection attempt detected")


# ── Toxicity filter ───────────────────────────────────────────────────────────
def check_toxicity(text: str, threshold: float = 0.7) -> None:
    """
    Check output toxicity (spec.guardrails.output.toxicity-filter).
    Uses Detoxify. Falls back to keyword check if not installed.
    Install: pip install detoxify
    """
    try:
        from detoxify import Detoxify
        results = Detoxify('original').predict(text)
        score = results.get('toxicity', 0.0)
        if score > threshold:
            raise GuardrailError(
                f"TOXICITY: Output toxicity score {score:.2f} exceeds threshold {threshold}"
            )
    except ImportError:
        toxic_keywords = ['harm', 'kill', 'hate', 'attack', 'destroy', 'abuse']
        if any(kw in text.lower() for kw in toxic_keywords):
            raise GuardrailError("TOXICITY: Output contains potentially harmful content")


# ── Hallucination detection ───────────────────────────────────────────────────
def check_hallucination(
    output: str, context: Optional[str] = None, threshold: float = 0.8
) -> None:
    """
    Check output for hallucination (spec.guardrails.output.hallucination-detector).
    Uses deepeval. Skipped if not installed.
    Install: pip install deepeval
    """
    try:
        from deepeval.metrics import HallucinationMetric
        from deepeval.test_case import LLMTestCase
        metric = HallucinationMetric(threshold=threshold)
        test_case = LLMTestCase(
            input="", actual_output=output, context=[context] if context else []
        )
        metric.measure(test_case)
        if not metric.is_successful():
            raise GuardrailError(
                f"HALLUCINATION: Score {metric.score:.2f} below threshold {threshold}"
            )
    except ImportError:
        pass  # deepeval not installed — skip hallucination check


# ── Public interface ──────────────────────────────────────────────────────────
def run_input_guardrails(text: str) -> str:
    """Run all input guardrails. Returns scrubbed text or raises GuardrailError."""
    check_topic_filter(text)
    text = scrub_pii(text)
    check_prompt_injection(text)
    return text


def run_output_guardrails(text: str, context: Optional[str] = None) -> str:
    """Run all output guardrails. Returns scrubbed text or raises GuardrailError."""
    check_hallucination(text, context=context)
    check_toxicity(text)
    text = scrub_pii(text)
    return text
```

Populate `BLOCKED_TOPICS` from `spec.guardrails.input.topic-filter.topics[]`.
Populate `TOPIC_REJECTION_MSG` from `spec.guardrails.input.topic-filter.rejectMessage`.
Set toxicity threshold from `spec.guardrails.output.toxicity-filter.threshold`.
Set hallucination threshold from `spec.guardrails.output.hallucination-detector.threshold`.

### spec.evaluation — eval_runner.py

```python
"""
Evaluation harness for {agent_name}
Generated by AgentSpec

Framework: {framework}
Run: python eval_runner.py
"""

import os
import json
from agent import run_agent

from deepeval import evaluate
from deepeval.metrics import (
    FaithfulnessMetric,
    AnswerRelevancyMetric,
    HallucinationMetric,
    ToxicityMetric,
)
from deepeval.test_case import LLMTestCase


def load_dataset(path: str, name: str) -> list[dict]:
    """Load a JSONL evaluation dataset."""
    if not os.path.exists(path):
        print(f"Dataset not found: {path} ({name}) — skipping")
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def run_evaluation() -> None:
    """Run the full evaluation suite and optionally gate CI."""
    metrics = [
        FaithfulnessMetric(threshold=0.85),     # from spec.evaluation.thresholds.faithfulness
        AnswerRelevancyMetric(threshold=0.7),    # spec.evaluation.thresholds.answer_relevancy
        HallucinationMetric(threshold=0.05),    # spec.evaluation.thresholds.hallucination
        ToxicityMetric(threshold=0.1),          # spec.evaluation.thresholds.toxicity
    ]

    test_cases = []
    for dataset_path, dataset_name in [
        ("eval/workout-qa.jsonl", "workout-qa"),       # from spec.evaluation.datasets[]
        ("eval/exercise-advice.jsonl", "exercise-advice"),
    ]:
        for row in load_dataset(dataset_path, dataset_name):
            output = run_agent(row["input"])
            test_cases.append(
                LLMTestCase(
                    input=row["input"],
                    actual_output=output,
                    expected_output=row.get("expected_output"),
                    context=row.get("context", []),
                )
            )

    if not test_cases:
        print("No test cases found. Create eval/ JSONL datasets first.")
        return

    results = evaluate(test_cases, metrics)
    print(f"\nEvaluation complete: {len(test_cases)} test cases")
    for metric in metrics:
        score = getattr(metric, "score", "N/A")
        print(f"  {metric.__class__.__name__}: {score}")

    # CI gate: exit 1 if any metric fails its threshold
    # (spec.evaluation.ciGate = true)
    all_passed = all(getattr(m, "is_successful", lambda: True)() for m in metrics)
    if not all_passed:
        raise SystemExit(1)


if __name__ == "__main__":
    run_evaluation()
```

Use actual metric names and thresholds from `spec.evaluation.metrics[]` and `spec.evaluation.thresholds{}`.
Only emit the CI gate block if `spec.evaluation.ciGate == true`.

### spec.observability

```python
# ── Tracing: Langfuse ─────────────────────────────────────────────────────────
from langfuse.callback import CallbackHandler as LangfuseCallback
langfuse_callback = LangfuseCallback(
    public_key=os.environ.get("LANGFUSE_PUBLIC_KEY"),
    secret_key=os.environ.get("AGENTSPEC_SECRET_LANGFUSE_SECRET_KEY"),  # $secret:langfuse-secret-key
    host=os.environ.get("LANGFUSE_HOST", "https://cloud.langfuse.com"),
)
callbacks = [langfuse_callback]
# CRITICAL: Thread callbacks through both:
# 1. llm_with_tools.invoke(messages, config={"callbacks": callbacks})
# 2. graph.invoke({...}, config={"configurable": {...}, "callbacks": callbacks})

# ── Tracing: LangSmith ────────────────────────────────────────────────────────
os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")
os.environ.setdefault("LANGCHAIN_PROJECT", "{service_name}")

# ── Metrics: OpenTelemetry ────────────────────────────────────────────────────
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

tracer_provider = TracerProvider()
tracer_provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(
        endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    ))
)
trace.set_tracer_provider(tracer_provider)
tracer = trace.get_tracer("{service_name}")

# ── Logging: structured + field redaction ─────────────────────────────────────
import logging
import re as _re_log

REDACT_FIELDS = ["api_key", "password", "medical_conditions"]  # spec.observability.logging.redactFields


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        msg = super().format(record)
        for field in REDACT_FIELDS:
            msg = _re_log.sub(rf'"{field}":\s*"[^"]*"', f'"{field}": "[REDACTED]"', msg)
        return msg


_handler = logging.StreamHandler()
_handler.setFormatter(
    RedactingFormatter('%(asctime)s %(levelname)s %(name)s %(message)s')
)
logging.getLogger().addHandler(_handler)
logging.getLogger().setLevel(logging.INFO)
```

### spec.requires

```python
# ── Startup validation ────────────────────────────────────────────────────────
REQUIRED_ENV_VARS = ["GROQ_API_KEY", "DATABASE_URL", "REDIS_URL", "LANGFUSE_HOST"]
# From spec.requires.envVars[]


def validate_env() -> None:
    missing = [v for v in REQUIRED_ENV_VARS if not os.environ.get(v)]
    if missing:
        raise EnvironmentError(
            f"Missing required environment variables: {', '.join(missing)}\n"
            f"Copy .env.example to .env and fill in the values."
        )


validate_env()
```

For `spec.requires.services`:
```python
import socket


def check_service(host: str, port: int, name: str) -> None:
    try:
        with socket.create_connection((host, port), timeout=5):
            pass
    except (socket.timeout, ConnectionRefusedError, OSError) as e:
        raise RuntimeError(f"Cannot connect to {name} at {host}:{port} — {e}")


# Check each required service on startup
check_service("localhost", 6379, "Redis")        # if spec.requires.services includes redis
check_service("localhost", 5432, "PostgreSQL")   # if spec.requires.services includes postgres
```

---

## Complete agent.py Structure

Generate sections in this exact order:

1. **Docstring** — agent name, version, model provider/id, tools count, memory backend, tracing backend
2. **Imports**:
   - `import os`
   - `import datetime` (if `$func:now_iso` used in variables)
   - `import re` (if guardrails or memory hygiene)
   - `import asyncio` (if MCP servers or parallel subagents)
   - `from typing import Annotated, TypedDict, Sequence`
   - `from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage`
   - `from langchain_core.tools import BaseTool`
   - `from langgraph.graph import StateGraph, END`
   - `from langgraph.prebuilt import ToolNode`
   - Tool imports: `from tools import tool_a, tool_b` (one per tool)
   - Guardrail imports: `from guardrails import run_input_guardrails, run_output_guardrails`
   - Provider import
   - Fallback provider import (if `spec.model.fallback`)
3. **Observability setup** (Langfuse / LangSmith / OTEL)
4. **Callbacks binding** (if Langfuse: `callbacks = [langfuse_callback]`)
5. **Memory setup** (checkpointer)
6. **Long-term memory functions** (if `spec.memory.longTerm`)
7. **Memory hygiene** (if `spec.memory.hygiene`)
8. **Cost controls comment block** (if `spec.model.costControls`)
9. **MCP server comment block** (if `spec.mcp`)
10. **Env var validation** (`validate_env()` call)
11. **Service connectivity checks** (if `spec.requires.services`)
12. **System prompt loading** (with variable interpolation if variables defined)
13. **AgentState TypedDict**
14. **tools list**
15. **Model setup** (primary + fallback if configured)
16. **`call_model()`** — with guardrails and callbacks
17. **`should_continue()`**
18. **Graph construction** + compile with checkpointer (or `graph = workflow.compile()`)
19. **`run_agent()`** — with callbacks if Langfuse
20. **`__main__` block**

---

## requirements.txt Template

Always include base packages. Add extras based on manifest:

```
# Base (always)
langgraph>=0.2.0
langchain-core>=0.3.0
python-dotenv>=1.0.0

# Model provider (from spec.model.provider)
langchain-groq>=0.1.0           # provider: groq
langchain-openai>=0.1.0         # provider: openai or azure
langchain-anthropic>=0.1.0      # provider: anthropic
langchain-google-genai>=0.1.0   # provider: google
langchain-mistralai>=0.1.0      # provider: mistral

# Memory (from spec.memory.shortTerm.backend)
redis>=5.0.0                            # backend: redis
langgraph-checkpoint-redis>=0.1.0       # backend: redis
langgraph-checkpoint-sqlite>=0.1.0      # backend: sqlite

# Long-term memory (from spec.memory.longTerm)
psycopg2-binary>=2.9.0                  # longTerm.backend: postgres

# Observability (from spec.observability.tracing.backend)
langfuse>=2.0.0                         # backend: langfuse
langsmith>=0.1.0                        # backend: langsmith
opentelemetry-sdk>=1.20.0              # spec.observability.metrics: otel
opentelemetry-exporter-otlp>=1.20.0   # spec.observability.metrics: otel

# Guardrails (from spec.guardrails.*)
detoxify>=0.5.0                         # toxicity-filter guardrail
deepeval>=1.0.0                         # hallucination-detector + evaluation harness

# API server (from spec.api)
fastapi>=0.111.0                        # spec.api is set
uvicorn>=0.30.0                         # spec.api is set
PyJWT>=2.8.0                            # spec.api.auth.type: jwt
httpx>=0.27.0                           # subagent A2A calls

# MCP (from spec.mcp)
langchain-mcp-adapters>=0.1.0           # spec.mcp is set
```

---

## .env.example Rules

- One line per env var referenced in the manifest
- Strip `$env:` prefix for the variable name
- For `$secret:name`, the env var is `AGENTSPEC_SECRET_NAME` (uppercase, `-`→`_`)
- Add a comment describing what each var is for
- Group by concern: model, memory, observability, agent config, API auth

---

## README.md Template

```markdown
# {agent_name}

{description}

**Generated by [AgentSpec](https://agentspec.io) v{version}**

## Stack

| Component | Value |
|-----------|-------|
| Framework | LangGraph |
| Model | {provider}/{model_id} |
| Memory | {memory_backend} |
| Tracing | {tracing_backend} |
| Tools | {tools_count} |

## Quick Start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in your API keys
python agent.py "Hello, what can you help me with?"
```

## Tools

{tool_list}  # bullet list from spec.tools[]

## Environment Variables

{env_var_list}  # bullet list from spec.requires.envVars[]

## Compliance

Run `npx agentspec audit agent.yaml` to check compliance score.
```

---

## Quality Checklist

Before finalising, verify each item applies:

| Check | Verify |
|---|---|
| `$secret:` resolution | `$secret:langfuse-secret-key` → `AGENTSPEC_SECRET_LANGFUSE_SECRET_KEY` |
| No literal keys | Search generated code for `sk-`, `pk-`, raw key strings |
| `validate_env()` called | At module top-level, before any connections |
| Langfuse callbacks | Threaded through `llm.invoke(config={"callbacks": callbacks})` AND `graph.invoke(config={..., "callbacks": callbacks})` |
| Prompt variables | `load_system_prompt()` has `template.replace()` loop |
| `tools.py` generated | When `spec.tools` is non-empty |
| MCP comment block | At module level, not indented inside another block |
| Long-term memory | `save_session_summary()` and `load_session_context()` present if `spec.memory.longTerm` |
| Memory hygiene | `scrub_pii()` in `agent.py` if `spec.memory.hygiene` |
| Guardrails real code | No `raise NotImplementedError` in guardrails.py — use Detoxify / deepeval |
| Server JWT | `verify_jwt()` + `Depends(verify_jwt)` if `spec.api.auth.type == "jwt"` |
| Server rate limit | `rate_limit()` function if `spec.api.rateLimit` set |
| `eval_runner.py` | Uses `len(test_cases)`, not `test_cases.__len__()` |
| Requirements complete | All packages match imports in generated files |
| No `import datetime as _dt` | Use plain `import datetime` or `from datetime import datetime` |
