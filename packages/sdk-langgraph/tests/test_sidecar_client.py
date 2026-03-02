"""
Tests for SidecarClient — fire-and-forget behavioral event push to the sidecar.

Tests verify:
  - push_events_async swallows network errors
  - push_events_sync swallows network errors
  - Payload is correctly serialised for each event type
  - GuardrailMiddleware.new_request_context() auto-pushes on exit
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentspec_langgraph.events import (
    GuardrailEvent,
    MemoryWriteEvent,
    ModelCallEvent,
    ToolCallEvent,
)
from agentspec_langgraph.sidecar_client import SidecarClient, _serialise_event


# ── Serialisation ─────────────────────────────────────────────────────────────


class TestSerialiseEvent:
    def test_guardrail_event(self) -> None:
        event = GuardrailEvent(
            guardrail_type="pii-detector",
            invoked=True,
            blocked=False,
            action="scrub",
            score=0.3,
        )
        result = _serialise_event(event)
        assert result["type"] == "guardrail"
        assert result["guardrailType"] == "pii-detector"
        assert result["invoked"] is True
        assert result["blocked"] is False
        assert result["action"] == "scrub"
        assert result["score"] == 0.3

    def test_tool_event(self) -> None:
        event = ToolCallEvent(name="plan-workout", latency_ms=82.0, success=True)
        result = _serialise_event(event)
        assert result["type"] == "tool"
        assert result["name"] == "plan-workout"
        assert result["success"] is True
        assert result["latencyMs"] == 82.0

    def test_model_event(self) -> None:
        event = ModelCallEvent(
            model_id="groq/llama-3.3-70b",
            latency_ms=120.0,
            token_count=850,
        )
        result = _serialise_event(event)
        assert result["type"] == "model"
        assert result["modelId"] == "groq/llama-3.3-70b"
        assert result["tokenCount"] == 850

    def test_memory_event(self) -> None:
        event = MemoryWriteEvent(
            backend="redis", ttl_seconds=3600, pii_scrubbed=True
        )
        result = _serialise_event(event)
        assert result["type"] == "memory"
        assert result["backend"] == "redis"
        assert result["ttlSeconds"] == 3600
        assert result["piiScrubbed"] is True

    def test_dict_passthrough(self) -> None:
        d = {"type": "guardrail", "guardrailType": "custom"}
        assert _serialise_event(d) == d

    def test_unknown_type_returns_empty_dict(self) -> None:
        result = _serialise_event("not an event")
        assert result == {}


# ── SidecarClient.push_events_sync ────────────────────────────────────────────


class TestPushEventsSync:
    def test_swallows_connection_error(self) -> None:
        client = SidecarClient(url="http://127.0.0.1:19999")
        # Should not raise even when nothing is listening
        client.push_events_sync(
            request_id="req-1",
            agent_name="gymcoach",
            events=[GuardrailEvent("pii-detector", True, False)],
        )

    def test_swallows_timeout(self) -> None:
        client = SidecarClient(url="http://127.0.0.1:19999")
        client.push_events_sync(
            request_id="req-1",
            agent_name="gymcoach",
            events=[],
        )

    def test_sends_correct_payload(self) -> None:
        client = SidecarClient(url="http://sidecar:4001")
        captured: list[dict[str, Any]] = []

        def fake_post(url: str, json: Any, timeout: float) -> MagicMock:
            captured.append({"url": url, "json": json})
            m = MagicMock()
            m.status_code = 200
            return m

        with patch("httpx.post", side_effect=fake_post):
            client.push_events_sync(
                request_id="abc-123",
                agent_name="gymcoach",
                events=[
                    GuardrailEvent("pii-detector", True, False),
                    ToolCallEvent("plan-workout", 82.0, True),
                ],
            )

        assert len(captured) == 1
        payload = captured[0]["json"]
        assert payload["requestId"] == "abc-123"
        assert payload["agentName"] == "gymcoach"
        assert len(payload["events"]) == 2
        assert payload["events"][0]["type"] == "guardrail"
        assert payload["events"][1]["type"] == "tool"
        assert "sidecar:4001/agentspec/events" in captured[0]["url"]

    def test_swallows_http_error_response(self) -> None:
        client = SidecarClient(url="http://sidecar:4001")

        mock_resp = MagicMock()
        mock_resp.status_code = 500

        with patch("httpx.post", return_value=mock_resp):
            # Should not raise
            client.push_events_sync("req-1", "gymcoach", [])

    def test_returns_none_when_httpx_not_installed(self) -> None:
        client = SidecarClient(url="http://sidecar:4001")
        # Simulate httpx not available
        with patch.dict("sys.modules", {"httpx": None}):  # type: ignore[dict-item]
            # Should not raise
            client.push_events_sync("req-1", "gymcoach", [])


# ── SidecarClient.push_events_async ───────────────────────────────────────────


class TestPushEventsAsync:
    @pytest.mark.asyncio
    async def test_swallows_connection_error(self) -> None:
        client = SidecarClient(url="http://127.0.0.1:19999")
        # Should not raise
        await client.push_events_async(
            request_id="req-1",
            agent_name="gymcoach",
            events=[GuardrailEvent("pii-detector", True, False)],
        )

    @pytest.mark.asyncio
    async def test_sends_correct_payload_async(self) -> None:
        client = SidecarClient(url="http://sidecar:4001")
        captured: list[dict[str, Any]] = []

        mock_response = AsyncMock()
        mock_response.status_code = 200

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        async def fake_post(url: str, json: Any) -> AsyncMock:
            captured.append({"url": url, "json": json})
            return mock_response

        mock_client.post = fake_post

        with patch("httpx.AsyncClient", return_value=mock_client):
            await client.push_events_async(
                request_id="abc-123",
                agent_name="gymcoach",
                events=[ToolCallEvent("plan-workout", 82.0, True)],
            )

        assert len(captured) == 1
        payload = captured[0]["json"]
        assert payload["requestId"] == "abc-123"
        assert payload["events"][0]["type"] == "tool"


# ── GuardrailMiddleware integration ───────────────────────────────────────────


class TestRequestContextAutoPush:
    """new_request_context() auto-pushes events via sidecar_client on exit."""

    def test_sync_context_pushes_on_exit(self) -> None:
        from agentspec_langgraph import GuardrailMiddleware

        middleware = GuardrailMiddleware(agent_name="gymcoach")

        push_calls: list[dict[str, Any]] = []

        mock_client = MagicMock()
        mock_client.push_events_sync = lambda **kwargs: push_calls.append(kwargs)  # type: ignore[assignment]

        def pii_fn(text: str) -> str:
            return text

        with middleware.new_request_context(
            request_id="req-xyz",
            sidecar_client=mock_client,
        ) as ctx:
            ctx.wrap("pii-detector", pii_fn)("hello user")

        assert len(push_calls) == 1
        assert push_calls[0]["request_id"] == "req-xyz"
        assert push_calls[0]["agent_name"] == "gymcoach"
        events = push_calls[0]["events"]
        assert any(
            isinstance(e, GuardrailEvent) and e.guardrail_type == "pii-detector"
            for e in events
        )

    @pytest.mark.asyncio
    async def test_async_context_pushes_on_exit(self) -> None:
        from agentspec_langgraph import GuardrailMiddleware

        middleware = GuardrailMiddleware(agent_name="gymcoach")

        push_calls: list[dict[str, Any]] = []

        mock_client = MagicMock()

        async def fake_async_push(**kwargs: Any) -> None:
            push_calls.append(kwargs)

        mock_client.push_events_async = fake_async_push

        def pii_fn(text: str) -> str:
            return text

        async with middleware.new_request_context(
            request_id="req-async",
            sidecar_client=mock_client,
        ) as ctx:
            ctx.wrap("pii-detector", pii_fn)("hello")

        assert len(push_calls) == 1
        assert push_calls[0]["request_id"] == "req-async"

    def test_no_push_when_sidecar_client_not_provided(self) -> None:
        from agentspec_langgraph import GuardrailMiddleware

        middleware = GuardrailMiddleware(agent_name="gymcoach")

        def pii_fn(text: str) -> str:
            return text

        # Should not raise, no sidecar_client means no push
        with middleware.new_request_context() as ctx:
            ctx.wrap("pii-detector", pii_fn)("hello")

    def test_no_push_when_request_id_not_provided(self) -> None:
        from agentspec_langgraph import GuardrailMiddleware

        middleware = GuardrailMiddleware(agent_name="gymcoach")
        push_calls: list[Any] = []

        mock_client = MagicMock()
        mock_client.push_events_sync = lambda **kwargs: push_calls.append(kwargs)  # type: ignore[assignment]

        def pii_fn(text: str) -> str:
            return text

        # No request_id → no push
        with middleware.new_request_context(sidecar_client=mock_client) as ctx:
            ctx.wrap("pii-detector", pii_fn)("hello")

        assert len(push_calls) == 0

    def test_no_push_when_no_events_recorded(self) -> None:
        from agentspec_langgraph import GuardrailMiddleware

        middleware = GuardrailMiddleware(agent_name="gymcoach")
        push_calls: list[Any] = []

        mock_client = MagicMock()
        mock_client.push_events_sync = lambda **kwargs: push_calls.append(kwargs)  # type: ignore[assignment]

        # Context with no guardrail calls → no push
        with middleware.new_request_context(
            request_id="req-empty",
            sidecar_client=mock_client,
        ):
            pass

        assert len(push_calls) == 0

    def test_push_error_is_swallowed(self) -> None:
        from agentspec_langgraph import GuardrailMiddleware

        middleware = GuardrailMiddleware(agent_name="gymcoach")

        mock_client = MagicMock()
        mock_client.push_events_sync.side_effect = RuntimeError("network down")

        def pii_fn(text: str) -> str:
            return text

        # push error must not propagate
        with middleware.new_request_context(
            request_id="req-fail",
            sidecar_client=mock_client,
        ) as ctx:
            ctx.wrap("pii-detector", pii_fn)("hello")
        # No exception raised

    def test_fail_closed_propagated_to_request_context(self) -> None:
        """H1: fail_closed=True must be inherited by the inner GuardrailMiddleware
        created inside _RequestContext, so enforce_opa() inside the context
        also raises on OPA unavailability instead of failing open."""
        from agentspec_langgraph import GuardrailMiddleware
        from agentspec_langgraph.guardrail_middleware import PolicyViolationError

        # Middleware configured fail_closed — OPA URL set but nothing listening
        middleware = GuardrailMiddleware(
            agent_name="gymcoach",
            opa_url="http://127.0.0.1:19998",
            fail_closed=True,
        )

        with middleware.new_request_context() as ctx:
            # The inner context's fail_closed must be True
            assert ctx._fail_closed is True

            # enforce_opa() with nothing listening should raise (fail-closed)
            with pytest.raises(PolicyViolationError):
                ctx.enforce_opa(model_id="openai/gpt-4o")

    def test_fail_open_default_in_request_context(self) -> None:
        """fail_closed defaults to False — enforce_opa() must not raise on OPA unavailability."""
        from agentspec_langgraph import GuardrailMiddleware

        middleware = GuardrailMiddleware(
            agent_name="gymcoach",
            opa_url="http://127.0.0.1:19998",
            fail_closed=False,
        )

        with middleware.new_request_context() as ctx:
            assert ctx._fail_closed is False
            # Should not raise — fail-open
            result = ctx.enforce_opa(model_id="openai/gpt-4o")
            assert result["allow"] is True
