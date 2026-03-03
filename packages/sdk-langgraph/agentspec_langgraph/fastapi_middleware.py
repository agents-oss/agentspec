"""
AgentSpecMiddleware — FastAPI/Starlette middleware for HeaderReporting.

HeaderReporting data path: after the agent processes a request, this middleware reads
behavioral state from GuardrailMiddleware and AgentSpecToolNode (via context vars)
and sets internal response headers. The sidecar proxy reads and strips them.

  X-AgentSpec-Guardrails-Invoked: pii-detector,toxicity-filter
  X-AgentSpec-Tools-Called:       plan-workout,log-session
  X-AgentSpec-User-Confirmed:     true

These headers are INTERNAL — the sidecar strips them before forwarding to the client.

Usage:
    from fastapi import FastAPI
    from agentspec_langgraph import AgentSpecMiddleware, GuardrailMiddleware

    app = FastAPI()
    app.add_middleware(
        AgentSpecMiddleware,
        guardrail_middleware=guardrail_middleware,  # GuardrailMiddleware instance
        tool_node=tool_node,                        # AgentSpecToolNode instance (optional)
    )

    # Or use the context-var approach if you create a new context per request:
    app.add_middleware(AgentSpecMiddleware)
    # Then in your route: set the context vars before processing.

For a simpler approach, use the SidecarClient (EventPush) which pushes events
out-of-band without needing middleware.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar
from typing import Any, Callable, List, Optional

# ── Context variables ─────────────────────────────────────────────────────────
# These allow request handlers and middleware to share per-request state
# without passing arguments through every function call.
#
# NOTE: list-typed vars use `default=None` (not `default=[]`) to avoid sharing
# a single mutable list object across all contexts that haven't called .set().
# AgentSpecMiddleware always calls .set([]) at request entry to create a fresh list.

#: The X-Request-ID for the current request (set by the middleware on entry).
request_id_var: ContextVar[str] = ContextVar("agentspec_request_id", default="")

#: Guardrail types invoked during the current request.
#: Set by GuardrailMiddleware when integrated with this middleware.
guardrails_invoked_var: ContextVar[Optional[List[str]]] = ContextVar(
    "agentspec_guardrails_invoked", default=None
)

#: Tool names called during the current request.
#: Set by AgentSpecToolNode when integrated with this middleware.
tools_called_var: ContextVar[Optional[List[str]]] = ContextVar(
    "agentspec_tools_called", default=None
)

#: Whether the user explicitly confirmed a destructive action.
user_confirmed_var: ContextVar[bool] = ContextVar(
    "agentspec_user_confirmed", default=False
)


class AgentSpecMiddleware:
    """
    Starlette/FastAPI ASGI middleware for HeaderReporting.

    Wraps each request:
    1. Reads X-Request-ID from incoming headers (falls back to uuid4).
    2. Stores the request_id in request_id_var context variable.
    3. On response: reads guardrails_invoked_var, tools_called_var, user_confirmed_var
       and sets the corresponding X-AgentSpec-* response headers.

    The sidecar proxy reads these headers and strips them before forwarding to the
    external client, so they never leak beyond the sidecar boundary.

    Parameters
    ----------
    app:
        The ASGI application to wrap.
    guardrail_middleware:
        Optional GuardrailMiddleware instance. When provided, the middleware
        reads invoked guardrail types from it on each request exit.
    tool_node:
        Optional AgentSpecToolNode instance. When provided, the middleware
        reads tool call names from it on each request exit.
    """

    def __init__(
        self,
        app: Any,
        guardrail_middleware: Optional[Any] = None,
        tool_node: Optional[Any] = None,
    ) -> None:
        self.app = app
        self._guardrail_middleware = guardrail_middleware
        self._tool_node = tool_node

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # ── 1. Read / generate X-Request-ID ─────────────────────────────────────
        headers = dict(scope.get("headers", []))
        request_id_bytes = headers.get(b"x-request-id", b"")
        request_id = (
            request_id_bytes.decode("ascii", errors="replace")
            if request_id_bytes
            else str(uuid.uuid4())
        )

        # ── 2. Set context variables for downstream use ──────────────────────────
        request_id_token = request_id_var.set(request_id)
        guardrails_token = guardrails_invoked_var.set([])
        tools_token = tools_called_var.set([])
        confirmed_token = user_confirmed_var.set(False)

        try:
            # ── 3. Process the request ───────────────────────────────────────────
            await self.app(scope, receive, self._make_send_wrapper(send))
        finally:
            # ── 4. Reset context variables ───────────────────────────────────────
            request_id_var.reset(request_id_token)
            guardrails_invoked_var.reset(guardrails_token)
            tools_called_var.reset(tools_token)
            user_confirmed_var.reset(confirmed_token)

    def _make_send_wrapper(self, send: Callable[..., Any]) -> Callable[..., Any]:
        """
        Wrap the ASGI send callable to inject X-AgentSpec-* headers when
        the "http.response.start" message is sent.
        """
        middleware = self

        async def send_wrapper(message: Any) -> None:
            if message.get("type") == "http.response.start":
                # Collect behavioral data
                guardrails = middleware._collect_guardrails()
                tools = middleware._collect_tools()
                confirmed = user_confirmed_var.get()

                # Inject internal headers
                extra_headers: list[tuple[bytes, bytes]] = []
                if guardrails:
                    extra_headers.append((
                        b"x-agentspec-guardrails-invoked",
                        ",".join(guardrails).encode("ascii"),
                    ))
                if tools:
                    extra_headers.append((
                        b"x-agentspec-tools-called",
                        ",".join(tools).encode("ascii"),
                    ))
                if confirmed:
                    extra_headers.append((
                        b"x-agentspec-user-confirmed",
                        b"true",
                    ))

                if extra_headers:
                    existing = list(message.get("headers", []))
                    message = {**message, "headers": existing + extra_headers}

            await send(message)

        return send_wrapper

    def _collect_guardrails(self) -> list[str]:
        """Read guardrail invocations from GuardrailMiddleware or context var."""
        # Prefer the context var (set by GuardrailMiddleware per-request context)
        from_var = guardrails_invoked_var.get()
        if from_var:
            return from_var
        # Fallback: read from shared GuardrailMiddleware instance
        if self._guardrail_middleware is not None:
            try:
                return list(self._guardrail_middleware.get_invoked_types())
            except Exception:
                pass
        return []

    def _collect_tools(self) -> list[str]:
        """Read tool call names from AgentSpecToolNode or context var."""
        from_var = tools_called_var.get()
        if from_var:
            return from_var
        # Fallback: read from shared AgentSpecToolNode instance
        if self._tool_node is not None:
            try:
                invocations = self._tool_node.get_invocations()
                return [e.name for e in invocations]
            except Exception:
                pass
        return []
