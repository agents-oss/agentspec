"""
Event types emitted by the AgentSpec LangGraph sub-SDK.

These events are the bridge between the LangGraph execution path and the
AgentSpecReporter / OPA policy enforcement layer.

Emission flow:
  LangGraph lifecycle hook
      → AgentSpec wrapper intercepts
      → Event object created
      → Reporter.record_*(event) updates HealthReport
      → Optional: OPA query with event as input
      → OPA allow/deny decision enforced
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ToolCallEvent:
    """
    Emitted by AgentSpecToolNode on every tool invocation.

    Maps to HealthCheck category "tool" in AgentSpecReporter.
    OPA field: input.tools_called (list of names)
    """

    name: str
    """Tool name as declared in agent.yaml spec.tools[].name"""

    latency_ms: float
    """Wall-clock latency from tool invocation to return/raise."""

    success: bool
    """True if the tool returned without raising an exception."""

    error: Optional[str] = None
    """Exception message if success=False."""


@dataclass
class ModelCallEvent:
    """
    Emitted by instrument_call_model on every LLM invocation.

    Maps to HealthCheck category "model" in AgentSpecReporter.
    OPA fields: input.token_count, input.cost_today_usd, input.tokens_today
    """

    model_id: str
    """Model identifier as 'provider/id' (e.g. 'groq/llama-3.3-70b-versatile')."""

    latency_ms: float
    """Wall-clock latency from model invocation to first token / return."""

    token_count: int = 0
    """Total tokens consumed by this call (prompt + completion)."""

    prompt_tokens: Optional[int] = None
    """Prompt-only token count if available from the response metadata."""

    completion_tokens: Optional[int] = None
    """Completion-only token count if available from the response metadata."""


@dataclass
class GuardrailEvent:
    """
    Emitted by GuardrailMiddleware on every guardrail invocation.

    OPA field: input.guardrails_invoked (list of type strings)
    OPA fields: input.toxicity_score, input.hallucination_score
    """

    guardrail_type: str
    """Guardrail type as declared in agent.yaml (e.g. 'pii-detector', 'toxicity-filter')."""

    invoked: bool
    """True if the guardrail was actually called during this request."""

    blocked: bool
    """True if the guardrail blocked or scrubbed the request/response."""

    action: Optional[str] = None
    """Action taken: 'scrub', 'reject', 'warn', 'retry'."""

    reason: Optional[str] = None
    """Human-readable reason if blocked=True."""

    score: Optional[float] = None
    """
    For score-based guardrails (toxicity-filter, hallucination-detector):
    the computed score (0.0–1.0).
    """


@dataclass
class MemoryWriteEvent:
    """
    Emitted on every memory write operation.

    OPA field: input.memory_write { ttl_seconds, pii_scrubbed }
    """

    backend: str
    """Memory backend (e.g. 'redis', 'sqlite', 'in-memory')."""

    ttl_seconds: int
    """TTL applied to this write. Must match spec.memory.shortTerm.ttlSeconds."""

    pii_scrubbed: bool
    """Whether PII fields were scrubbed before writing."""

    key: Optional[str] = None
    """Optional: storage key (do NOT include user data)."""
