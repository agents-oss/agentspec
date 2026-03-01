"""
TDD tests for GuardrailMiddleware.

Written before the implementation.
OPA is mocked via HTTP — tests run without OPA or httpx installed.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from agentspec_langgraph import GuardrailMiddleware, GuardrailEvent, PolicyViolationError
from tests.conftest import MockReporter


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def reporter():
    return MockReporter()


@pytest.fixture
def middleware(reporter):
    return GuardrailMiddleware(reporter=reporter, agent_name="gymcoach")


def pass_through(content: str) -> str:
    """Simple guardrail that passes content unchanged."""
    return content


def scrub_pii(content: str) -> str:
    """Simple PII scrubber — replaces 'email@example.com'."""
    return content.replace("email@example.com", "[REDACTED]")


def blocking_guardrail(content: str) -> str:
    raise ValueError("Content violates topic policy")


# ── wrap() tests ──────────────────────────────────────────────────────────────

def test_wrapped_guardrail_returns_content(middleware):
    wrapped = middleware.wrap("pii-detector", pass_through)
    result = wrapped("hello world")
    assert result == "hello world"


def test_wrapped_guardrail_records_event(middleware, reporter):
    wrapped = middleware.wrap("pii-detector", pass_through)
    wrapped("input text")
    assert len(reporter.guardrail_invocations) == 1


def test_wrapped_guardrail_event_type_matches(middleware, reporter):
    wrapped = middleware.wrap("topic-filter", pass_through)
    wrapped("input text")
    event = reporter.guardrail_invocations[0]
    assert event.guardrail_type == "topic-filter"


def test_wrapped_guardrail_invoked_is_true(middleware, reporter):
    wrapped = middleware.wrap("pii-detector", pass_through)
    wrapped("input text")
    assert reporter.guardrail_invocations[0].invoked is True


def test_wrapped_guardrail_blocked_false_when_passes(middleware, reporter):
    wrapped = middleware.wrap("prompt-injection", pass_through)
    wrapped("benign input")
    assert reporter.guardrail_invocations[0].blocked is False


def test_wrapped_guardrail_blocked_true_on_exception(middleware, reporter):
    wrapped = middleware.wrap("topic-filter", blocking_guardrail)
    with pytest.raises(ValueError):
        wrapped("bad content")
    assert reporter.guardrail_invocations[0].blocked is True


def test_wrapped_guardrail_exception_propagates(middleware):
    wrapped = middleware.wrap("topic-filter", blocking_guardrail)
    with pytest.raises(ValueError, match="Content violates topic policy"):
        wrapped("bad content")


def test_scrubbing_guardrail_modifies_content(middleware):
    wrapped = middleware.wrap("pii-detector", scrub_pii)
    result = wrapped("contact email@example.com for info")
    assert "REDACTED" in result
    assert "email@example.com" not in result


# ── get_invoked_types tests ───────────────────────────────────────────────────

def test_get_invoked_types_returns_called_types(middleware):
    middleware.wrap("pii-detector", pass_through)("text")
    middleware.wrap("topic-filter", pass_through)("text")
    types = middleware.get_invoked_types()
    assert "pii-detector" in types
    assert "topic-filter" in types


def test_get_invoked_types_empty_before_any_call(middleware):
    assert middleware.get_invoked_types() == []


def test_get_events_returns_all_events(middleware):
    middleware.wrap("pii-detector", pass_through)("text")
    middleware.wrap("prompt-injection", pass_through)("text")
    events = middleware.get_events()
    assert len(events) == 2


def test_get_events_returns_copy(middleware):
    middleware.wrap("pii-detector", pass_through)("text")
    events = middleware.get_events()
    events.clear()
    assert len(middleware.get_events()) == 1


# ── reset() tests ─────────────────────────────────────────────────────────────

def test_reset_clears_all_events(middleware):
    middleware.wrap("pii-detector", pass_through)("text")
    middleware.wrap("topic-filter", pass_through)("text")
    middleware.reset()
    assert middleware.get_invoked_types() == []
    assert middleware.get_events() == []


# ── Reporter error isolation ───────────────────────────────────────────────────

def test_reporter_error_does_not_propagate():
    bad_reporter = MagicMock()
    bad_reporter.record_guardrail_invocation.side_effect = RuntimeError("reporter down")

    middleware = GuardrailMiddleware(reporter=bad_reporter, agent_name="gymcoach")
    wrapped = middleware.wrap("pii-detector", pass_through)
    # Should NOT raise
    result = wrapped("hello")
    assert result == "hello"


# ── Works without reporter ─────────────────────────────────────────────────────

def test_works_without_reporter():
    middleware = GuardrailMiddleware(agent_name="test-agent")
    wrapped = middleware.wrap("pii-detector", pass_through)
    result = wrapped("hello world")
    assert result == "hello world"
    assert len(middleware.get_events()) == 1


# ── Multiple invocations ───────────────────────────────────────────────────────

def test_multiple_guardrail_types_accumulate(middleware):
    for gtype in ["pii-detector", "topic-filter", "prompt-injection"]:
        middleware.wrap(gtype, pass_through)("text")
    assert len(middleware.get_invoked_types()) == 3


# ── new_request_context tests ─────────────────────────────────────────────────

def test_new_request_context_provides_isolated_middleware(reporter):
    outer = GuardrailMiddleware(reporter=reporter, agent_name="test")
    outer.wrap("pii-detector", pass_through)("initial text")

    with outer.new_request_context() as ctx:
        ctx.wrap("topic-filter", pass_through)("request text")
        # Context has its own events — does not see outer events
        assert "pii-detector" not in ctx.get_invoked_types()
        assert "topic-filter" in ctx.get_invoked_types()


# ── enforce_opa tests ─────────────────────────────────────────────────────────

def test_enforce_opa_returns_allow_true_when_opa_unavailable(reporter):
    """When OPA_URL is not set, allow=True (fail-open)."""
    middleware = GuardrailMiddleware(reporter=reporter, agent_name="gymcoach")
    # No opa_url set
    result = middleware.enforce_opa(model_id="groq/test")
    assert result["allow"] is True


def test_enforce_opa_allow_true_when_opa_reachable_no_violations(reporter):
    """When OPA returns empty deny set, allow=True."""
    middleware = GuardrailMiddleware(
        reporter=reporter,
        opa_url="http://localhost:8181",
        agent_name="gymcoach",
    )
    middleware.wrap("pii-detector", pass_through)("text")

    mock_httpx = MagicMock()
    mock_response = MagicMock()
    mock_response.is_success = True
    mock_response.json.return_value = {"result": []}
    mock_httpx.post.return_value = mock_response

    with patch.dict("sys.modules", {"httpx": mock_httpx}):
        result = middleware.enforce_opa(model_id="groq/test")
    assert result["allow"] is True
    assert result["violations"] == []


def test_enforce_opa_raises_policy_violation_on_deny(reporter):
    """When OPA returns non-empty deny set, raise PolicyViolationError."""
    middleware = GuardrailMiddleware(
        reporter=reporter,
        opa_url="http://localhost:8181",
        agent_name="gymcoach",
    )

    mock_httpx = MagicMock()
    mock_response = MagicMock()
    mock_response.is_success = True
    mock_response.json.return_value = {"result": ["pii_detector_not_invoked"]}
    mock_httpx.post.return_value = mock_response

    with patch.dict("sys.modules", {"httpx": mock_httpx}):
        with pytest.raises(PolicyViolationError) as exc_info:
            middleware.enforce_opa(model_id="groq/test")

    assert "pii_detector_not_invoked" in exc_info.value.violations


def test_enforce_opa_allow_true_when_opa_fails(reporter):
    """OPA HTTP failure = fail-open (allow=True)."""
    middleware = GuardrailMiddleware(
        reporter=reporter,
        opa_url="http://localhost:8181",
        agent_name="gymcoach",
    )

    mock_httpx = MagicMock()
    mock_httpx.post.side_effect = ConnectionError("ECONNREFUSED")

    with patch.dict("sys.modules", {"httpx": mock_httpx}):
        result = middleware.enforce_opa(model_id="groq/test")

    assert result["allow"] is True
    assert result.get("opaUnavailable") is True


def test_enforce_opa_sanitizes_agent_name_with_hyphen(reporter):
    """Agent names with hyphens must have hyphens replaced with underscores in OPA URL."""
    middleware = GuardrailMiddleware(
        reporter=reporter,
        opa_url="http://localhost:8181",
        agent_name="fitness-tracker",
    )

    mock_httpx = MagicMock()
    mock_response = MagicMock()
    mock_response.is_success = True
    mock_response.json.return_value = {"result": []}
    mock_httpx.post.return_value = mock_response

    with patch.dict("sys.modules", {"httpx": mock_httpx}):
        middleware.enforce_opa(model_id="groq/test")

    call_url = mock_httpx.post.call_args[0][0]
    assert "fitness_tracker" in call_url
    assert "fitness-tracker" not in call_url


# ── PolicyViolationError tests ────────────────────────────────────────────────

def test_policy_violation_error_contains_violation_list():
    violations = ["pii_detector_not_invoked", "memory_ttl_mismatch"]
    err = PolicyViolationError(violations)
    assert err.violations == violations


def test_policy_violation_error_has_readable_message():
    err = PolicyViolationError(["some_violation"])
    assert "some_violation" in str(err)


# ── GuardrailEvent type tests ─────────────────────────────────────────────────

def test_guardrail_event_fields(middleware, reporter):
    middleware.wrap("toxicity-filter", pass_through)("clean text")
    event = reporter.guardrail_invocations[0]
    assert isinstance(event, GuardrailEvent)
    assert event.guardrail_type == "toxicity-filter"
    assert event.invoked is True
    assert isinstance(event.blocked, bool)
