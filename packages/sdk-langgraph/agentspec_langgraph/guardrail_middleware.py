"""
GuardrailMiddleware — records which guardrails were invoked and reports to OPA.

Wraps guardrail functions with event recording so the OPA input document
can be populated with `input.guardrails_invoked` on each LLM request.

Usage:
    from agentspec_langgraph import GuardrailMiddleware

    middleware = GuardrailMiddleware(reporter=reporter, opa_url="http://localhost:8181")

    # Register each guardrail with its declared type:
    check_pii = middleware.wrap("pii-detector", original_pii_check)
    check_topics = middleware.wrap("topic-filter", original_topic_check)

    # In your agent's run_input_guardrails():
    def run_input_guardrails(user_input: str) -> str:
        user_input = check_pii(user_input)
        user_input = check_topics(user_input)
        return user_input
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional
from urllib.parse import urlparse

from .events import GuardrailEvent

if TYPE_CHECKING:
    from .sidecar_client import SidecarClient


class PolicyViolationError(Exception):
    """
    Raised when OPA returns allow=false for a request.

    Agents should catch this in their request handler and return
    an appropriate error response to the user.

    Attributes
    ----------
    violations:
        List of Rego deny rule IDs that fired (e.g. ["pii_detector_not_invoked"]).
    """

    def __init__(self, violations: List[str]) -> None:
        self.violations = violations
        ids = ", ".join(violations)
        super().__init__(f"OPA policy violation(s): {ids}")


class GuardrailMiddleware:
    """
    Records guardrail invocations and optionally enforces OPA policies.

    Thread-safe per-request context:
        Use middleware.new_request_context() to create a fresh context
        for each incoming request.
    """

    def __init__(
        self,
        reporter: Optional[Any] = None,
        opa_url: Optional[str] = None,
        agent_name: str = "unknown",
        fail_closed: bool = False,
    ) -> None:
        """
        Parameters
        ----------
        reporter:
            Optional AgentSpecReporter (any object with record_guardrail_invocation()).
        opa_url:
            Optional OPA base URL (e.g. "http://localhost:8181").
            Must use http or https scheme. When set, enforce_opa() will query OPA.
        agent_name:
            Agent name used in OPA queries (metadata.name from agent.yaml).
            Must be lowercase alphanumeric with hyphens/underscores, max 64 chars.
        fail_closed:
            When True, OPA unavailability raises PolicyViolationError instead of
            allowing the request (default: False = fail-open for dev convenience).
        """
        if opa_url is not None:
            parsed = urlparse(opa_url)
            if parsed.scheme not in ("http", "https"):
                raise ValueError(
                    f"opa_url must use http or https scheme, got: {parsed.scheme!r}"
                )
        self._reporter = reporter
        self._opa_url = opa_url
        self._agent_name = agent_name
        self._fail_closed = fail_closed
        self._events: List[GuardrailEvent] = []

    def wrap(
        self,
        guardrail_type: str,
        fn: Callable[..., Any],
    ) -> Callable[..., Any]:
        """
        Wrap a guardrail function with event recording.

        The wrapped function records a GuardrailEvent on every call,
        regardless of whether the guardrail blocks or passes.

        Parameters
        ----------
        guardrail_type:
            The guardrail type as declared in agent.yaml
            (e.g. "pii-detector", "topic-filter", "prompt-injection").
        fn:
            The guardrail function. Must accept at least one argument
            (the content to check) and return the (possibly modified) content.
        """
        middleware = self

        def wrapped(*args: Any, **kwargs: Any) -> Any:
            blocked = False
            reason: Optional[str] = None
            score: Optional[float] = None
            action: Optional[str] = None

            try:
                result = fn(*args, **kwargs)
                # Guardrail passed — check if it returned metadata
                if isinstance(result, dict) and "content" in result:
                    blocked = result.get("blocked", False)
                    reason = result.get("reason")
                    score = result.get("score")
                    action = result.get("action")
                    content = result["content"]
                else:
                    content = result

                event = GuardrailEvent(
                    guardrail_type=guardrail_type,
                    invoked=True,
                    blocked=blocked,
                    action=action,
                    reason=reason,
                    score=score,
                )
                middleware._record(event)
                return content

            except Exception as exc:
                # Guardrail raised — treat as blocked
                event = GuardrailEvent(
                    guardrail_type=guardrail_type,
                    invoked=True,
                    blocked=True,
                    reason=str(exc),
                )
                middleware._record(event)
                raise

        return wrapped

    def get_invoked_types(self) -> List[str]:
        """Return the guardrail type strings invoked in the current context."""
        return [e.guardrail_type for e in self._events if e.invoked]

    def get_events(self) -> List[GuardrailEvent]:
        """Return all recorded events (copy)."""
        return list(self._events)

    def reset(self) -> None:
        """
        Clear recorded events.

        Call this at the start of each new request to ensure per-request
        isolation. In async environments, prefer new_request_context().
        """
        self._events.clear()

    def new_request_context(
        self,
        request_id: Optional[str] = None,
        sidecar_client: Optional["SidecarClient"] = None,
    ) -> "_RequestContext":
        """
        Return a per-request context manager.

        On __aexit__ / __exit__: if a sidecar_client and request_id are provided,
        all GuardrailEvents recorded during the context are pushed to the sidecar
        as a fire-and-forget event batch (EventPush reporting path).

        Parameters
        ----------
        request_id:
            The X-Request-ID injected by the sidecar proxy on the incoming request.
            Required for EventPush. Obtain from the request headers:
              ``request_id = request.headers.get("x-request-id")``
        sidecar_client:
            Optional SidecarClient to push events to. When provided, events are
            pushed on context exit. When absent, no push occurs.

        Usage:
            client = SidecarClient(url="http://localhost:4001")
            async with middleware.new_request_context(
                request_id=request.headers.get("x-request-id"),
                sidecar_client=client,
            ) as ctx:
                content = ctx.wrap("pii-detector", pii_fn)(user_input)
                await ctx.enforce_opa(model_id=model_id)
        """
        return _RequestContext(
            self._reporter,
            self._opa_url,
            self._agent_name,
            fail_closed=self._fail_closed,
            request_id=request_id,
            sidecar_client=sidecar_client,
        )

    def enforce_opa(
        self,
        model_id: str = "unknown/unknown",
        agent_name: Optional[str] = None,
        guardrails_declared: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Synchronously query OPA with the current request context.

        Returns the OPA result dict: { allow, violations, opaUnavailable? }
        Raises PolicyViolationError if allow=False.

        Parameters
        ----------
        model_id:
            Model identifier (e.g. "groq/llama-3.3-70b-versatile").
        agent_name:
            Override the agent name for this query (defaults to constructor value).
        guardrails_declared:
            Guardrail types declared in agent.yaml. When provided, OPA can detect
            guardrails that were declared but not invoked. Defaults to invoked types.

        Requires: pip install httpx
        """
        opa_url = self._opa_url
        if not opa_url:
            return {"allow": True, "violations": []}

        try:
            import httpx
        except ImportError as exc:
            raise ImportError(
                "httpx is required for OPA enforcement. Install: pip install httpx"
            ) from exc

        target_name = agent_name or self._agent_name
        package_name = target_name.replace("-", "_")

        # Validate package_name to prevent path traversal in OPA URL
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", package_name):
            raise ValueError(
                f"Invalid agent name for OPA query: {target_name!r}. "
                "Must start with a lowercase letter, contain only lowercase "
                "alphanumeric characters, hyphens, or underscores, max 64 chars."
            )

        url = f"{opa_url}/v1/data/agentspec/agent/{package_name}/deny"
        invoked = self.get_invoked_types()

        opa_input = {
            "agent_name": target_name,
            "request_type": "llm_call",
            "model_id": model_id,
            "guardrails_invoked": invoked,
            "guardrails_declared": guardrails_declared if guardrails_declared is not None else invoked,
            "tools_called": [],
            "user_confirmed": False,
        }

        try:
            resp = httpx.post(
                url,
                json={"input": opa_input},
                timeout=3.0,
            )
            if not resp.is_success:
                if self._fail_closed:
                    raise PolicyViolationError(["opa_unreachable"])
                return {"allow": True, "violations": [], "opaUnavailable": True}

            body = resp.json()
            violations = body.get("result") or []
            if not isinstance(violations, list):
                violations = []

            violations = [v for v in violations if isinstance(v, str)]
            result = {"allow": len(violations) == 0, "violations": violations}
            if not result["allow"]:
                raise PolicyViolationError(violations)
            return result

        except PolicyViolationError:
            raise
        except Exception:
            if self._fail_closed:
                raise PolicyViolationError(["opa_unreachable"])
            return {"allow": True, "violations": [], "opaUnavailable": True}

    # ── Internal ───────────────────────────────────────────────────────────────

    def _record(self, event: GuardrailEvent) -> None:
        self._events.append(event)
        if self._reporter is not None:
            try:
                self._reporter.record_guardrail_invocation(event)
            except Exception:
                pass


class _RequestContext:
    """
    Per-request context that isolates guardrail recording.

    On exit, if a sidecar_client and request_id were provided, all GuardrailEvents
    recorded during the context are pushed to the sidecar (EventPush reporting path).

    This is the preferred way to use GuardrailMiddleware in async code.
    """

    def __init__(
        self,
        reporter: Optional[Any],
        opa_url: Optional[str],
        agent_name: str,
        fail_closed: bool = False,
        request_id: Optional[str] = None,
        sidecar_client: Optional[Any] = None,
    ) -> None:
        self._inner = GuardrailMiddleware(
            reporter=reporter,
            opa_url=opa_url,
            agent_name=agent_name,
            fail_closed=fail_closed,
        )
        self._agent_name = agent_name
        self._request_id = request_id
        self._sidecar_client = sidecar_client

    def __enter__(self) -> "GuardrailMiddleware":
        return self._inner

    def __exit__(self, *_: Any) -> None:
        self._push_sync()

    async def __aenter__(self) -> "GuardrailMiddleware":
        return self._inner

    async def __aexit__(self, *_: Any) -> None:
        await self._push_async()

    def _push_sync(self) -> None:
        """Push guardrail events synchronously (fire-and-forget)."""
        if not self._sidecar_client or not self._request_id:
            return
        events = self._inner.get_events()
        if not events:
            return
        try:
            self._sidecar_client.push_events_sync(
                request_id=self._request_id,
                agent_name=self._agent_name,
                events=list(events),
            )
        except Exception:
            pass  # Fire-and-forget — swallow all errors

    async def _push_async(self) -> None:
        """Push guardrail events asynchronously (fire-and-forget)."""
        if not self._sidecar_client or not self._request_id:
            return
        events = self._inner.get_events()
        if not events:
            return
        try:
            await self._sidecar_client.push_events_async(
                request_id=self._request_id,
                agent_name=self._agent_name,
                events=list(events),
            )
        except Exception:
            pass  # Fire-and-forget — swallow all errors
