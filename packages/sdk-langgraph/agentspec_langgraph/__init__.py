"""
agentspec-langgraph — LangGraph sub-SDK for AgentSpec behavioral instrumentation.

This package provides two behavioral reporting paths to the AgentSpec sidecar:

  HeaderReporting (response headers):
    AgentSpecMiddleware — FastAPI/Starlette middleware that sets X-AgentSpec-*
    response headers after each request. The sidecar proxy reads and strips them.
    Use this when you want per-request OPA enforcement (track or enforce mode).

  EventPush (out-of-band event push):
    SidecarClient — fire-and-forget HTTP client that pushes a batch of behavioral
    events to POST /agentspec/events after each request completes.
    Always records regardless of OPA_PROXY_MODE; no headers needed.

Core instrumentation:
  - AgentSpecToolNode    → wraps LangGraph tools with timing + event recording
  - instrument_call_model → wraps call_model with token usage tracking
  - GuardrailMiddleware  → records guardrail invocations for OPA input
  - PolicyViolationError → raised when OPA denies a request

Quick start:

    from agentspec_langgraph import (
        AgentSpecToolNode,
        instrument_call_model,
        GuardrailMiddleware,
        SidecarClient,
    )
    from agentspec import AgentSpecReporter

    reporter = AgentSpecReporter.from_yaml("agent.yaml")
    sidecar = SidecarClient(url="http://localhost:4001")

    # Wrap tools
    tool_node = AgentSpecToolNode(tools=[plan_workout, log_session], reporter=reporter)
    workflow.add_node("tools", tool_node.as_langgraph_node())

    # Wrap call_model
    call_model = instrument_call_model(
        original_call_model,
        reporter=reporter,
        model_id="groq/llama-3.3-70b-versatile",
    )

    # Guardrail middleware with per-request context + sidecar push (EventPush)
    middleware = GuardrailMiddleware(
        reporter=reporter,
        opa_url="http://localhost:8181",
        agent_name="gymcoach",
    )

    async with middleware.new_request_context(
        request_id=request.headers.get("x-request-id"),
        sidecar_client=sidecar,
    ) as ctx:
        content = ctx.wrap("pii-detector", pii_fn)(user_input)
"""

from .callback_handler import AgentSpecCallbackHandler
from .events import GuardrailEvent, MemoryWriteEvent, ModelCallEvent, ToolCallEvent
from .fastapi_middleware import AgentSpecMiddleware, request_id_var
from .guardrail_middleware import GuardrailMiddleware, PolicyViolationError
from .model_instrumentation import instrument_call_model
from .sidecar_client import SidecarClient
from .tool_node import AgentSpecToolNode

__version__ = "0.1.0"

__all__ = [
    "AgentSpecToolNode",
    "AgentSpecCallbackHandler",
    "instrument_call_model",
    "GuardrailMiddleware",
    "PolicyViolationError",
    "SidecarClient",
    "AgentSpecMiddleware",
    "request_id_var",
    "ToolCallEvent",
    "ModelCallEvent",
    "GuardrailEvent",
    "MemoryWriteEvent",
]
