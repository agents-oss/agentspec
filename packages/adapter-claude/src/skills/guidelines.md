# AgentSpec Generation — Universal Guidelines

These rules apply to ALL framework skill files. Every generated output must satisfy them
regardless of target framework.

---

## Output Format

Return a **single JSON object** (wrapped in ` ```json ... ``` `) with this exact shape:

```json
{
  "files": {
    "<filename>": "<file content as a string>"
  },
  "installCommands": [
    "python -m venv .venv",
    "source .venv/bin/activate",
    "pip install -r requirements.txt"
  ],
  "envVars": ["GROQ_API_KEY", "REDIS_URL"]
}
```

**Escaping rules for file content strings:**
- All backslashes inside string values must be escaped: `\\` → `\\\\`
- All double quotes inside string values must be escaped: `"` → `\"`
- Newlines inside string values must be `\n` (literal backslash-n), NOT actual newlines
- The outer JSON structure uses real newlines for readability but string values must not
- Never truncate long files — generate the complete, runnable content for every file
- Test your JSON mentally: `JSON.parse(your_output)` must succeed

---

## Reference Syntax Resolution

Resolve `$ref` values before generating code:

| Manifest reference | Generated code |
|---|---|
| `$env:VAR_NAME` | `os.environ.get("VAR_NAME")` — list in `REQUIRED_ENV_VARS` if required |
| `$secret:secret-name` | `os.environ.get("AGENTSPEC_SECRET_SECRET_NAME")` — transform: uppercase, `-` → `_`, prefix `AGENTSPEC_SECRET_` |
| `$file:path/to/file` | Use `path/to/file` as a relative filesystem path |
| `$func:now_iso` | `datetime.datetime.utcnow().isoformat()` — also add `import datetime` |

Examples:
- `$secret:langfuse-secret-key` → `os.environ.get("AGENTSPEC_SECRET_LANGFUSE_SECRET_KEY")`
- `$secret:openai-api-key` → `os.environ.get("AGENTSPEC_SECRET_OPENAI_API_KEY")`
- `$env:GROQ_API_KEY` → `os.environ.get("GROQ_API_KEY")`

---

## Context File Usage

When context files from `$file:` tool module references are included in the input, use them:

- Read the actual function signatures and docstrings from the included source files
- Generate typed wrappers that match the real parameter names and types
- If the source file defines `def log_workout(exercises: list[str], duration: int) -> str`, generate
  the wrapper with those exact parameters — do not invent different signatures
- If no source file is included (module not resolved), infer typed params from the tool description

---

## Universal Quality Checklist

Before finalising any output, verify every item:

| Check | Rule |
|---|---|
| `$secret:` resolution | `$secret:langfuse-secret-key` → `AGENTSPEC_SECRET_LANGFUSE_SECRET_KEY` |
| No literal keys | No `sk-`, `pk-`, raw API key strings in generated code |
| No hardcoded hosts | Never hardcode `localhost:6379` or `localhost:5432` — parse from env vars |
| `validate_env()` placement | Called BEFORE any external client initialization |
| Callbacks threaded through | Through LLM invoke AND graph invoke, not just one |
| Prompt variables | `load_system_prompt()` has the `template.replace()` loop |
| No `**kwargs` in tool functions | Always generate typed parameters — see framework skill for details |
| No `# TODO` in critical paths | Stubs are only acceptable for user-provided implementations (tool bodies, subagent bodies) |
| Requirements complete | All packages match imports in generated files |
| `.env.example` complete | Every `$env:` and `$secret:` reference has a corresponding line |

---

## Embedded Control Plane Principles (required for all frameworks)

Every generated agent must satisfy these four properties. They are not optional.

### 1. Manifest as runtime artifact
The source `agent.yaml` must ship with the generated code. Generate a loader module
(`manifest.py` for Python, `manifest.ts` for TypeScript) that:
- Loads `agent.yaml` from the same directory as the generated code
- Exposes `load_manifest()` and `get_capabilities()` functions
- Is always generated, regardless of which spec sections are present

### 2. Discoverability
When `spec.api` is set, generate a `/capabilities` endpoint that returns:
- `spec.metadata` (name, version, description, tags)
- `spec.tools[]` with all `annotations` fields intact
- Active compliance packs from `spec.compliance.packs[]`

Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) must be carried
through to framework-level tool metadata — never silently dropped.

### 3. Auditability
Audit log events must cover ALL observable categories — not only memory writes:
- Tool calls (include tool name, argument keys)
- Guardrail rejections and scrubs (include reason code)
- Destructive tool calls (log at WARNING level)
- Memory reads and writes (already required)

Use a consistent logger name: `agentspec.audit`.

### 4. Evaluability
When `spec.evaluation.datasets[]` is declared, the JSONL files are first-class
generated artifacts — they must contain seed test cases derived from the agent's
description, system prompt, tools, and guardrails. Never generate an eval harness
that references files that don't exist.

The eval harness must be pytest-compatible (`tests/test_eval.py`), not a standalone
root-level script. Guardrail tests (`tests/test_guardrails.py`) must run with zero
infrastructure requirements.

### 5. Controllability annotations
Every hardcoded threshold or limit must carry a comment indicating its manifest source:
```python
_HALLUCINATION_MAX_RETRIES = 2   # spec.guardrails.output.hallucination-detector.maxRetries
_RATE_LIMIT_RPM = 60              # spec.api.rateLimit.requestsPerMinute
```
This ensures developers know to edit `agent.yaml` rather than the generated code.

| Control Plane Check | Rule |
|---|---|
| `manifest.py` always generated | Required regardless of spec sections present |
| `get_capabilities()` exists | Returns tools with annotations |
| `/capabilities` endpoint | When `spec.api` is set |
| Audit log covers tool calls + guardrails | Not just memory writes |
| Eval datasets have seed cases | Never empty references |
| Eval in `tests/` not root level | pytest-compatible |
| Tool annotations carried to framework metadata | `readOnlyHint`, `destructiveHint`, `idempotentHint` |
| Hardcoded values annotated with manifest path | All thresholds/limits have `# spec.X.Y` comment |
