"""
agentspec-langgraph — LangGraph sub-SDK for AgentSpec behavioral instrumentation.

This package is Layer 1 of the AgentSpec OPA integration:
  - AgentSpecToolNode    → wraps LangGraph tools with timing + event recording
  - instrument_call_model → wraps call_model with token usage tracking
  - GuardrailMiddleware  → records guardrail invocations for OPA input
  - PolicyViolationError → raised when OPA denies a request

Quick start:

    from agentspec_langgraph import (
        AgentSpecToolNode,
        instrument_call_model,
        GuardrailMiddleware,
    )
    from agentspec import AgentSpecReporter

    reporter = AgentSpecReporter.from_yaml("agent.yaml")

    # Wrap tools
    tool_node = AgentSpecToolNode(tools=[plan_workout, log_session], reporter=reporter)
    workflow.add_node("tools", tool_node.as_langgraph_node())

    # Wrap call_model
    call_model = instrument_call_model(
        original_call_model,
        reporter=reporter,
        model_id="groq/llama-3.3-70b-versatile",
    )

    # Guardrail middleware (optional OPA enforcement)
    middleware = GuardrailMiddleware(
        reporter=reporter,
        opa_url="http://localhost:8181",
        agent_name="gymcoach",
    )
"""

from .events import GuardrailEvent, MemoryWriteEvent, ModelCallEvent, ToolCallEvent
from .guardrail_middleware import GuardrailMiddleware, PolicyViolationError
from .model_instrumentation import instrument_call_model
from .tool_node import AgentSpecToolNode

__version__ = "0.1.0"

__all__ = [
    "AgentSpecToolNode",
    "instrument_call_model",
    "GuardrailMiddleware",
    "PolicyViolationError",
    "ToolCallEvent",
    "ModelCallEvent",
    "GuardrailEvent",
    "MemoryWriteEvent",
]
