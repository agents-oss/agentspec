"""
instrument_call_model — LangGraph call_model wrapper with AgentSpec instrumentation.

Wraps the `call_model(state)` node function to:
  1. Measure wall-clock latency of the LLM call
  2. Extract token usage from the AI message response metadata
  3. Emit a ModelCallEvent to the attached AgentSpecReporter

Usage:
    from agentspec_langgraph import instrument_call_model

    original_call_model = call_model  # your existing function

    call_model = instrument_call_model(
        original_call_model,
        reporter=reporter,
        model_id="groq/llama-3.3-70b-versatile",
    )

    # Use in LangGraph graph exactly as before:
    workflow.add_node("agent", call_model)
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any, Callable, Optional

from .events import ModelCallEvent


def instrument_call_model(
    fn: Callable[..., Any],
    reporter: Optional[Any] = None,
    model_id: str = "unknown/unknown",
    max_events: int = 10_000,
) -> Callable[..., Any]:
    """
    Wrap a LangGraph call_model node function with AgentSpec instrumentation.

    The wrapped function:
      - Times each LLM call
      - Extracts token usage from AIMessage.usage_metadata or response_metadata
      - Emits a ModelCallEvent to the reporter

    Parameters
    ----------
    fn:
        The original call_model(state) function to wrap.
    reporter:
        Optional AgentSpecReporter (or any object with record_model_call()).
        When provided, every model call triggers a callback.
    model_id:
        Model identifier as "provider/id". Used in the emitted event.
    max_events:
        Maximum number of call events to retain in memory (default: 10,000).
        Older events are dropped when the limit is reached.

    Returns
    -------
    A wrapped function with the same signature as `fn`.
    """
    call_log: deque[ModelCallEvent] = deque(maxlen=max_events)

    def wrapped(*args: Any, **kwargs: Any) -> Any:
        start = time.monotonic()
        result = fn(*args, **kwargs)
        latency_ms = (time.monotonic() - start) * 1000

        # Extract token usage from the AI message in the return value
        token_count, prompt_tokens, completion_tokens = _extract_token_usage(result)

        event = ModelCallEvent(
            model_id=model_id,
            latency_ms=latency_ms,
            token_count=token_count,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
        call_log.append(event)

        if reporter is not None:
            try:
                reporter.record_model_call(event)
            except Exception:
                pass  # Reporter errors never break the agent

        return result

    # Expose call log on the wrapped function for testing / introspection
    wrapped.get_calls = lambda: list(call_log)  # type: ignore[attr-defined]
    return wrapped


def _extract_token_usage(
    result: Any,
) -> tuple[int, Optional[int], Optional[int]]:
    """
    Extract token usage from a LangGraph node return value.

    LangGraph call_model typically returns: { "messages": [AIMessage] }
    AIMessage exposes token usage via:
      - message.usage_metadata  (LangChain 0.3+)
      - message.response_metadata["token_usage"]
      - message.additional_kwargs.get("usage")

    Returns (total_tokens, prompt_tokens, completion_tokens).
    All are 0 / None if not available.
    """
    if not isinstance(result, dict):
        return 0, None, None

    messages = result.get("messages", [])
    if not messages:
        return 0, None, None

    # Look at the last message (most recent AI response)
    last = messages[-1]

    # Strategy 1: usage_metadata (LangChain >= 0.3.0)
    usage_meta = getattr(last, "usage_metadata", None)
    if isinstance(usage_meta, dict):
        total = usage_meta.get("total_tokens", 0) or 0
        prompt = usage_meta.get("input_tokens") or usage_meta.get("prompt_tokens")
        completion = usage_meta.get("output_tokens") or usage_meta.get("completion_tokens")
        return int(total), _opt_int(prompt), _opt_int(completion)

    # Strategy 2: response_metadata["token_usage"] (OpenAI / Groq)
    response_meta = getattr(last, "response_metadata", {}) or {}
    token_usage = response_meta.get("token_usage") or response_meta.get("usage")
    if isinstance(token_usage, dict):
        total = (
            token_usage.get("total_tokens", 0)
            or (token_usage.get("prompt_tokens", 0) + token_usage.get("completion_tokens", 0))
        )
        prompt = token_usage.get("prompt_tokens") or token_usage.get("input_tokens")
        completion = token_usage.get("completion_tokens") or token_usage.get("output_tokens")
        return int(total), _opt_int(prompt), _opt_int(completion)

    # Strategy 3: additional_kwargs["usage"] (some older providers)
    additional = getattr(last, "additional_kwargs", {}) or {}
    usage = additional.get("usage")
    if isinstance(usage, dict):
        total = usage.get("total_tokens", 0) or 0
        return int(total), _opt_int(usage.get("prompt_tokens")), _opt_int(usage.get("completion_tokens"))

    return 0, None, None


def _opt_int(value: Any) -> Optional[int]:
    """Convert to int or return None."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
