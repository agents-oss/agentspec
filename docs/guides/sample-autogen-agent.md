# Sample: AutoGen Agent — research-agent

This page shows what an AutoGen-based agent integrated with the AgentSpec SDK looks like.
The manifest is the source of truth; this sample is hand-written to illustrate the integration
pattern while `agentspec generate --framework autogen` is in development.

> **Note**: `agentspec generate --framework autogen` is coming soon. Follow the
> [GitHub issue](https://github.com/agentspec/agentspec/issues) for updates.
> In the meantime, use this page as a reference for manual integration.

---

## agent.yaml

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec
metadata:
  name: research-agent
  version: "0.4.0"
  description: "AutoGen research agent with AgentSpec SDK integration"
spec:
  model:
    provider: openai
    id: gpt-4o
    apiKey: $env:OPENAI_API_KEY
  prompts:
    system: "You are a research assistant. Search academic papers and synthesise findings."
  tools:
    - name: search-arxiv
      type: function
      description: "Search arXiv for papers matching a query"
    - name: analyze-paper
      type: function
      description: "Analyse a paper PDF and extract key findings"
  guardrails:
    input:
      - type: pii-detector
        action: scrub
        fields: [name, email]
    output:
      - type: toxicity-filter
        action: warn
        threshold: 0.7
```

---

## agent.py (manual integration)

```python
"""
research-agent — AutoGen agent with AgentSpec SDK integration
Hand-written integration pattern (agentspec generate --framework autogen coming soon)
"""
from __future__ import annotations

import os
import urllib.request
import json
from typing import Any

import autogen
from agentspec import AgentSpecReporter


# ── Environment validation (always before any client init) ────────────────────

def validate_env() -> None:
    required = {"OPENAI_API_KEY"}
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        raise EnvironmentError(
            f"Missing required environment variables: {', '.join(missing)}\n"
            "Set them in your .env file or deployment config."
        )


# ── Tools ─────────────────────────────────────────────────────────────────────

def search_arxiv(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Search arXiv for papers matching a query."""
    encoded = urllib.parse.quote(query)
    url = f"https://export.arxiv.org/api/query?search_query=all:{encoded}&max_results={max_results}"
    with urllib.request.urlopen(url, timeout=10) as resp:
        # Parse Atom feed — simplified for brevity
        raw = resp.read().decode()
    return [{"title": "Example paper", "url": f"https://arxiv.org/abs/example", "summary": raw[:200]}]


def analyze_paper(paper_url: str, focus: str = "methodology") -> dict[str, Any]:
    """Analyse a paper PDF and extract key findings."""
    return {
        "url": paper_url,
        "focus": focus,
        "findings": ["Key finding 1", "Key finding 2"],
        "confidence": 0.85,
    }


# ── Guardrails ────────────────────────────────────────────────────────────────

_PII_SUBS = [
    (__import__("re").compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+"), "[EMAIL REDACTED]"),
    (__import__("re").compile(r"\b(?:my name is|i am)\s+\w+", __import__("re").IGNORECASE), "[NAME REDACTED]"),
]


def scrub_pii(text: str) -> str:
    for pattern, replacement in _PII_SUBS:
        text = pattern.sub(replacement, text)
    return text


# ── AgentSpec SDK integration ─────────────────────────────────────────────────

def setup_reporter(manifest_path: str = "agent.yaml") -> AgentSpecReporter:
    reporter = AgentSpecReporter.from_yaml(manifest_path)
    reporter.register_tool("search-arxiv",  search_arxiv)
    reporter.register_tool("analyze-paper", analyze_paper)
    return reporter


# ── AutoGen config ────────────────────────────────────────────────────────────

def build_agents() -> tuple[autogen.AssistantAgent, autogen.UserProxyAgent]:
    config_list = [
        {
            "model": "gpt-4o",
            "api_key": os.environ["OPENAI_API_KEY"],
        }
    ]

    llm_config = {
        "config_list": config_list,
        "functions": [
            {
                "name": "search_arxiv",
                "description": "Search arXiv for papers matching a query",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "max_results": {"type": "integer", "description": "Max results", "default": 5},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "analyze_paper",
                "description": "Analyse a paper PDF and extract key findings",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "paper_url": {"type": "string", "description": "arXiv paper URL"},
                        "focus": {"type": "string", "description": "Analysis focus area"},
                    },
                    "required": ["paper_url"],
                },
            },
        ],
    }

    assistant = autogen.AssistantAgent(
        name="research_assistant",
        system_message=(
            "You are a research assistant. Search academic papers and synthesise findings. "
            "Use search_arxiv to find papers and analyze_paper to extract findings."
        ),
        llm_config=llm_config,
    )

    user_proxy = autogen.UserProxyAgent(
        name="user",
        human_input_mode="NEVER",
        max_consecutive_auto_reply=5,
        function_map={
            "search_arxiv": search_arxiv,
            "analyze_paper": analyze_paper,
        },
    )

    return assistant, user_proxy


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    validate_env()

    # Start AgentSpec SDK reporter (exposes /agentspec/health, /health, /capabilities)
    reporter = setup_reporter()
    reporter.start_push_mode(interval_seconds=30)

    assistant, user_proxy = build_agents()

    print("research-agent ready. Enter a research query (Ctrl-C to exit).")
    while True:
        query = input("Query: ").strip()
        if not query:
            continue
        safe_query = scrub_pii(query)
        user_proxy.initiate_chat(
            assistant,
            message=f"Research the following topic and summarise key findings: {safe_query}",
        )


if __name__ == "__main__":
    main()
```

---

## Generated: requirements.txt

```
pyautogen>=0.2.0
openai>=1.30.0
agentspec>=0.1.0
python-dotenv>=1.0.0
```

---

## Generated: .env.example

```bash
# research-agent — environment variables
# Copy to .env and fill in real values

OPENAI_API_KEY=sk-...
```

---

## Why this agent demos grade F (pre-patch)

The `research-agent` in the demo cluster starts in a **broken state** to illustrate what
grade F looks like — and why grade F is **only reachable in `agent-sdk` mode**.

| Check | Severity | Status (pre-patch) | Impact |
|---|---|---|---|
| model:openai/gpt-4o | error/critical | **fail** "API key not set" | −30 |
| tool:search-arxiv | info/medium | **fail** "Handler not registered" | −10 |
| tool:analyze-paper | info/medium | **fail** "Handler not registered" | −10 |
| guardrails (audit) | medium | **fail** (no guardrails block) | −10 |

**Score: 40 / Grade: F / Phase: Unhealthy / Source: agent-sdk**

A manifest-static agent can only reach grade C at worst (structural violations like
`healthcheckable` and `discoverable`). Grade F requires live tool registration failures
detected via the SDK — which is exactly what `agent-sdk` mode provides.

After `make demo-patch`, all live checks pass, guardrails are added, and the agent
reaches **score=100 / grade=A**.

---

## SDK integration pattern (summary)

The key lines that enable `source=agent-sdk` mode:

```python
reporter = AgentSpecReporter.from_yaml("agent.yaml")
reporter.register_tool("search-arxiv",  search_arxiv)
reporter.register_tool("analyze-paper", analyze_paper)
reporter.start_push_mode(interval_seconds=30)
```

This causes the agent to serve:

| Endpoint | Description |
|---|---|
| `GET /agentspec/health` | Live HealthReport with per-check status and latency |
| `GET /health` | Liveness probe (`{"status":"ok"}`) |
| `GET /capabilities` | Declared tools with live registration status |

The sidecar detects the `/agentspec/health` endpoint and switches to `source=agent-sdk`,
enabling live compliance scoring instead of static manifest analysis.
