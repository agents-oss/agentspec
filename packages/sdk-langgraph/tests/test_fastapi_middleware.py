"""
Tests for AgentSpecMiddleware — FastAPI/Starlette ASGI middleware.

Tests verify:
  - Middleware instantiation and basic passthrough
  - X-Request-ID extraction from incoming headers
  - X-Request-ID auto-generation when absent
  - Context variable setting (request_id, guardrails, tools)
  - X-AgentSpec-* response header injection from context vars
  - Non-HTTP scopes (e.g. websocket) pass through without modification
  - Exception propagation (middleware does not swallow errors)
  - Integration with GuardrailMiddleware and AgentSpecToolNode instances
"""

from __future__ import annotations

import uuid
from typing import Any, List, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from agentspec_langgraph.fastapi_middleware import (
    AgentSpecMiddleware,
    guardrails_invoked_var,
    request_id_var,
    tools_called_var,
    user_confirmed_var,
)


# ── Helpers ────────────────────────────────────────────────────────────────────


class CapturedResponse:
    """Captures ASGI send() messages for assertions."""

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send(self, message: dict[str, Any]) -> None:
        self.messages.append(message)

    @property
    def response_start(self) -> Optional[dict[str, Any]]:
        for m in self.messages:
            if m.get("type") == "http.response.start":
                return m
        return None

    def get_response_headers(self) -> dict[bytes, bytes]:
        start = self.response_start
        if not start:
            return {}
        return dict(start.get("headers", []))


def _make_http_scope(
    path: str = "/chat",
    method: str = "POST",
    headers: Optional[list[tuple[bytes, bytes]]] = None,
) -> dict[str, Any]:
    """Build a minimal ASGI HTTP scope."""
    return {
        "type": "http",
        "method": method,
        "path": path,
        "headers": headers or [],
    }


def _make_ws_scope() -> dict[str, Any]:
    """Build a minimal ASGI WebSocket scope."""
    return {"type": "websocket"}


def _make_inner_app(
    status_code: int = 200,
    body: bytes = b'{"ok":true}',
) -> Any:
    """
    Return a minimal ASGI app that sends a response.start + response.body.
    Captures the context vars at call time for assertions.
    """
    captured_ctx: dict[str, Any] = {}

    async def app(scope: Any, receive: Any, send: Any) -> None:
        # Capture the context variables set by the middleware
        captured_ctx["request_id"] = request_id_var.get()
        captured_ctx["guardrails_invoked"] = guardrails_invoked_var.get()
        captured_ctx["tools_called"] = tools_called_var.get()
        captured_ctx["user_confirmed"] = user_confirmed_var.get()

        await send({
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json"),
            ],
        })
        await send({
            "type": "http.response.body",
            "body": body,
        })

    app._captured_ctx = captured_ctx  # type: ignore[attr-defined]
    return app


# ── Instantiation ──────────────────────────────────────────────────────────────


class TestMiddlewareInstantiation:
    def test_basic_construction(self) -> None:
        inner = AsyncMock()
        mw = AgentSpecMiddleware(inner)
        assert mw.app is inner
        assert mw._guardrail_middleware is None
        assert mw._tool_node is None

    def test_construction_with_dependencies(self) -> None:
        inner = AsyncMock()
        guardrail = MagicMock()
        tool_node = MagicMock()
        mw = AgentSpecMiddleware(inner, guardrail_middleware=guardrail, tool_node=tool_node)
        assert mw._guardrail_middleware is guardrail
        assert mw._tool_node is tool_node


# ── Non-HTTP passthrough ──────────────────────────────────────────────────────


class TestNonHttpPassthrough:
    @pytest.mark.asyncio
    async def test_websocket_scope_passes_through(self) -> None:
        call_count = {"n": 0}

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            call_count["n"] += 1

        mw = AgentSpecMiddleware(inner)
        await mw(_make_ws_scope(), AsyncMock(), AsyncMock())
        assert call_count["n"] == 1


# ── Request ID handling ──────────────────────────────────────────────────────


class TestRequestIdHandling:
    @pytest.mark.asyncio
    async def test_request_id_extracted_from_headers(self) -> None:
        inner = _make_inner_app()
        mw = AgentSpecMiddleware(inner)
        captured = CapturedResponse()

        scope = _make_http_scope(headers=[
            (b"x-request-id", b"test-req-abc-123"),
        ])
        await mw(scope, AsyncMock(), captured.send)

        assert inner._captured_ctx["request_id"] == "test-req-abc-123"

    @pytest.mark.asyncio
    async def test_request_id_generated_when_absent(self) -> None:
        inner = _make_inner_app()
        mw = AgentSpecMiddleware(inner)
        captured = CapturedResponse()

        scope = _make_http_scope(headers=[])
        await mw(scope, AsyncMock(), captured.send)

        req_id = inner._captured_ctx["request_id"]
        assert len(req_id) > 0
        # Should be a valid UUID
        uuid.UUID(req_id)  # raises ValueError if not valid

    @pytest.mark.asyncio
    async def test_context_vars_reset_after_request(self) -> None:
        """Context vars must be reset even after normal completion."""
        inner = _make_inner_app()
        mw = AgentSpecMiddleware(inner)

        # Set a sentinel to detect reset
        token = request_id_var.set("sentinel-before")

        scope = _make_http_scope(headers=[(b"x-request-id", b"during-req")])
        await mw(scope, AsyncMock(), CapturedResponse().send)

        # After the middleware, the context should be restored to the previous value
        assert request_id_var.get() == "sentinel-before"
        request_id_var.reset(token)


# ── Header injection ─────────────────────────────────────────────────────────


class TestHeaderInjection:
    @pytest.mark.asyncio
    async def test_no_extra_headers_when_no_behavioral_data(self) -> None:
        inner = _make_inner_app()
        mw = AgentSpecMiddleware(inner)
        captured = CapturedResponse()

        await mw(_make_http_scope(), AsyncMock(), captured.send)

        headers = captured.get_response_headers()
        assert b"x-agentspec-guardrails-invoked" not in headers
        assert b"x-agentspec-tools-called" not in headers
        assert b"x-agentspec-user-confirmed" not in headers

    @pytest.mark.asyncio
    async def test_guardrails_header_injected(self) -> None:
        """When guardrails context var is populated, the header is set."""

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            # Simulate guardrail middleware recording invocations
            g = guardrails_invoked_var.get()
            if g is not None:
                g.extend(["pii-detector", "toxicity-filter"])

            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [],
            })
            await send({"type": "http.response.body", "body": b""})

        mw = AgentSpecMiddleware(inner)
        captured = CapturedResponse()

        await mw(_make_http_scope(), AsyncMock(), captured.send)

        headers = captured.get_response_headers()
        assert b"x-agentspec-guardrails-invoked" in headers
        assert headers[b"x-agentspec-guardrails-invoked"] == b"pii-detector,toxicity-filter"

    @pytest.mark.asyncio
    async def test_tools_called_header_injected(self) -> None:
        """When tools context var is populated, the header is set."""

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            t = tools_called_var.get()
            if t is not None:
                t.extend(["plan-workout", "log-session"])

            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [],
            })
            await send({"type": "http.response.body", "body": b""})

        mw = AgentSpecMiddleware(inner)
        captured = CapturedResponse()

        await mw(_make_http_scope(), AsyncMock(), captured.send)

        headers = captured.get_response_headers()
        assert b"x-agentspec-tools-called" in headers
        assert headers[b"x-agentspec-tools-called"] == b"plan-workout,log-session"

    @pytest.mark.asyncio
    async def test_user_confirmed_header_injected(self) -> None:
        """When user_confirmed context var is True, the header is set."""

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            user_confirmed_var.set(True)

            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [],
            })
            await send({"type": "http.response.body", "body": b""})

        mw = AgentSpecMiddleware(inner)
        captured = CapturedResponse()

        await mw(_make_http_scope(), AsyncMock(), captured.send)

        headers = captured.get_response_headers()
        assert b"x-agentspec-user-confirmed" in headers
        assert headers[b"x-agentspec-user-confirmed"] == b"true"


# ── Exception propagation ────────────────────────────────────────────────────


class TestExceptionPropagation:
    @pytest.mark.asyncio
    async def test_exception_in_inner_app_propagates(self) -> None:
        """Middleware must not swallow exceptions from the inner app."""

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            raise ValueError("inner app error")

        mw = AgentSpecMiddleware(inner)

        with pytest.raises(ValueError, match="inner app error"):
            await mw(_make_http_scope(), AsyncMock(), AsyncMock())

    @pytest.mark.asyncio
    async def test_context_vars_reset_after_exception(self) -> None:
        """Context vars must be reset even when the inner app raises."""

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            raise RuntimeError("boom")

        mw = AgentSpecMiddleware(inner)
        token = request_id_var.set("before-error")

        with pytest.raises(RuntimeError, match="boom"):
            await mw(
                _make_http_scope(headers=[(b"x-request-id", b"error-req")]),
                AsyncMock(),
                AsyncMock(),
            )

        # Context should be restored
        assert request_id_var.get() == "before-error"
        request_id_var.reset(token)


# ── GuardrailMiddleware integration ──────────────────────────────────────────


class TestGuardrailMiddlewareIntegration:
    @pytest.mark.asyncio
    async def test_fallback_to_guardrail_middleware_instance(self) -> None:
        """When context var is empty, middleware reads from GuardrailMiddleware instance."""
        guardrail_mw = MagicMock()
        guardrail_mw.get_invoked_types.return_value = ["pii-detector"]

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            # Do NOT populate the context var — leave it empty
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [],
            })
            await send({"type": "http.response.body", "body": b""})

        mw = AgentSpecMiddleware(inner, guardrail_middleware=guardrail_mw)
        captured = CapturedResponse()

        await mw(_make_http_scope(), AsyncMock(), captured.send)

        headers = captured.get_response_headers()
        assert b"x-agentspec-guardrails-invoked" in headers
        assert headers[b"x-agentspec-guardrails-invoked"] == b"pii-detector"


# ── AgentSpecToolNode integration ────────────────────────────────────────────


class TestToolNodeIntegration:
    @pytest.mark.asyncio
    async def test_fallback_to_tool_node_instance(self) -> None:
        """When context var is empty, middleware reads from tool_node.get_invocations()."""
        tool_node = MagicMock()
        mock_event = MagicMock()
        mock_event.name = "plan-workout"
        tool_node.get_invocations.return_value = [mock_event]

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [],
            })
            await send({"type": "http.response.body", "body": b""})

        mw = AgentSpecMiddleware(inner, tool_node=tool_node)
        captured = CapturedResponse()

        await mw(_make_http_scope(), AsyncMock(), captured.send)

        headers = captured.get_response_headers()
        assert b"x-agentspec-tools-called" in headers
        assert headers[b"x-agentspec-tools-called"] == b"plan-workout"


# ── Existing response headers preserved ──────────────────────────────────────


class TestExistingHeadersPreserved:
    @pytest.mark.asyncio
    async def test_existing_headers_not_clobbered(self) -> None:
        """Extra X-AgentSpec-* headers are appended, not replacing existing ones."""

        async def inner(scope: Any, receive: Any, send: Any) -> None:
            g = guardrails_invoked_var.get()
            if g is not None:
                g.append("pii-detector")

            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"x-custom-header", b"custom-value"),
                    (b"content-type", b"application/json"),
                ],
            })
            await send({"type": "http.response.body", "body": b""})

        mw = AgentSpecMiddleware(inner)
        captured = CapturedResponse()

        await mw(_make_http_scope(), AsyncMock(), captured.send)

        headers = captured.get_response_headers()
        assert headers[b"x-custom-header"] == b"custom-value"
        assert headers[b"content-type"] == b"application/json"
        assert b"x-agentspec-guardrails-invoked" in headers
