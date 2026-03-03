"""
SidecarClient — fire-and-forget behavioral event push to the AgentSpec sidecar.

EventPush reporting path: the sdk-langgraph SidecarClient pushes a batch of behavioral
events to POST /agentspec/events after each request completes. The sidecar
updates its audit ring with real behavioral data and optionally re-evaluates OPA.

Usage:
    from agentspec_langgraph import SidecarClient

    client = SidecarClient(url="http://localhost:4001")

    # Sync (in regular code)
    client.push_events_sync(
        request_id="abc-123",
        agent_name="gymcoach",
        events=[
            {"type": "guardrail", "guardrailType": "pii-detector",
             "invoked": True, "blocked": False},
            {"type": "tool", "name": "plan-workout", "success": True, "latencyMs": 82},
        ],
    )

    # Async (in async code)
    await client.push_events_async(request_id=..., agent_name=..., events=[...])
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .events import GuardrailEvent, MemoryWriteEvent, ModelCallEvent, ToolCallEvent


def _get_httpx() -> Any:
    """Return the httpx module if installed, or None."""
    try:
        import httpx  # type: ignore[import]
        return httpx
    except ImportError:
        return None


def _build_payload(request_id: str, agent_name: str, events: list[Any]) -> dict[str, Any]:
    """Build the JSON payload for POST /agentspec/events."""
    return {
        "requestId": request_id,
        "agentName": agent_name,
        "events": [_serialise_event(e) for e in events],
    }


def _serialise_event(event: Any) -> dict[str, Any]:
    """Convert an event dataclass to the sidecar wire format."""
    from .events import GuardrailEvent, MemoryWriteEvent, ModelCallEvent, ToolCallEvent

    if isinstance(event, GuardrailEvent):
        return {
            "type": "guardrail",
            "guardrailType": event.guardrail_type,
            "invoked": event.invoked,
            "blocked": event.blocked,
            "score": event.score,
            "action": event.action,
        }
    if isinstance(event, ToolCallEvent):
        return {
            "type": "tool",
            "name": event.name,
            "success": event.success,
            "latencyMs": event.latency_ms,
        }
    if isinstance(event, ModelCallEvent):
        return {
            "type": "model",
            "modelId": event.model_id,
            "tokenCount": event.token_count,
        }
    if isinstance(event, MemoryWriteEvent):
        return {
            "type": "memory",
            "backend": event.backend,
            "ttlSeconds": event.ttl_seconds,
            "piiScrubbed": event.pii_scrubbed,
        }
    # Fallback: treat as already-serialised dict
    if isinstance(event, dict):
        return event
    return {}


class SidecarClient:
    """
    Fire-and-forget client for pushing behavioral events to the AgentSpec sidecar.

    Both async and sync variants swallow all errors — a push failure never
    propagates to the agent's request handler.
    """

    def __init__(self, url: str = "http://localhost:4001") -> None:
        """
        Parameters
        ----------
        url:
            Sidecar control plane base URL (default: http://localhost:4001).
            This is the control plane port, NOT the proxy port (4000).
        """
        self._url = url.rstrip("/")

    async def push_events_async(
        self,
        request_id: str,
        agent_name: str,
        events: list[Any],
    ) -> None:
        """
        Push a batch of behavioral events to the sidecar (async, fire-and-forget).

        Accepts event dataclass instances (GuardrailEvent, ToolCallEvent, etc.)
        or pre-serialised dicts. All errors are swallowed.

        Parameters
        ----------
        request_id:
            The X-Request-ID injected by the sidecar proxy on the incoming request.
        agent_name:
            Agent name from metadata.name in agent.yaml.
        events:
            List of event objects or dicts to report.
        """
        httpx = _get_httpx()
        if httpx is None:
            return  # httpx not installed — skip silently

        payload = _build_payload(request_id, agent_name, events)
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.post(
                    f"{self._url}/agentspec/events",
                    json=payload,
                )
        except Exception:
            pass  # Fire-and-forget — swallow all errors

    def push_events_sync(
        self,
        request_id: str,
        agent_name: str,
        events: list[Any],
    ) -> None:
        """
        Push a batch of behavioral events to the sidecar (sync, fire-and-forget).

        Accepts event dataclass instances or pre-serialised dicts.
        All errors are swallowed.

        Parameters
        ----------
        request_id:
            The X-Request-ID injected by the sidecar proxy on the incoming request.
        agent_name:
            Agent name from metadata.name in agent.yaml.
        events:
            List of event objects or dicts to report.
        """
        httpx = _get_httpx()
        if httpx is None:
            return  # httpx not installed — skip silently

        payload = _build_payload(request_id, agent_name, events)
        try:
            httpx.post(
                f"{self._url}/agentspec/events",
                json=payload,
                timeout=3.0,
            )
        except Exception:
            pass  # Fire-and-forget — swallow all errors
