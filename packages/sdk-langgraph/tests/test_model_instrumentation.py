"""
TDD tests for instrument_call_model.

Written before the implementation.
LangGraph is mocked — tests run without langgraph installed.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from agentspec_langgraph import instrument_call_model, ModelCallEvent
from tests.conftest import MockAIMessage, MockReporter


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def reporter():
    return MockReporter()


def make_call_model(ai_message: MockAIMessage) -> object:
    """Return a minimal call_model function that returns {'messages': [ai_message]}."""
    def call_model(state):
        return {"messages": [ai_message]}
    return call_model


# ── Basic wrapping tests ──────────────────────────────────────────────────────

def test_wrapped_function_returns_original_result(reporter):
    msg = MockAIMessage(content="Hello!")
    call_model = instrument_call_model(
        make_call_model(msg), reporter=reporter, model_id="groq/llama-3.3-70b-versatile"
    )
    result = call_model({"messages": []})
    assert result["messages"][0].content == "Hello!"


def test_wrapped_function_records_model_call_event(reporter):
    msg = MockAIMessage()
    call_model = instrument_call_model(
        make_call_model(msg), reporter=reporter, model_id="openai/gpt-4o"
    )
    call_model({"messages": []})
    assert len(reporter.model_calls) == 1


def test_event_model_id_matches_parameter(reporter):
    msg = MockAIMessage()
    call_model = instrument_call_model(
        make_call_model(msg), reporter=reporter, model_id="groq/llama-3.3-70b-versatile"
    )
    call_model({"messages": []})
    assert reporter.model_calls[0].model_id == "groq/llama-3.3-70b-versatile"


def test_event_latency_ms_is_positive(reporter):
    msg = MockAIMessage()
    call_model = instrument_call_model(make_call_model(msg), reporter=reporter)
    call_model({"messages": []})
    assert reporter.model_calls[0].latency_ms >= 0


def test_event_is_model_call_event_instance(reporter):
    msg = MockAIMessage()
    call_model = instrument_call_model(make_call_model(msg), reporter=reporter)
    call_model({"messages": []})
    assert isinstance(reporter.model_calls[0], ModelCallEvent)


# ── Token usage extraction tests ──────────────────────────────────────────────

def test_extracts_token_count_from_usage_metadata(reporter):
    msg = MockAIMessage(
        usage_metadata={"total_tokens": 342, "input_tokens": 200, "output_tokens": 142}
    )
    call_model = instrument_call_model(make_call_model(msg), reporter=reporter)
    call_model({"messages": []})
    event = reporter.model_calls[0]
    assert event.token_count == 342
    assert event.prompt_tokens == 200
    assert event.completion_tokens == 142


def test_extracts_token_count_from_response_metadata_token_usage(reporter):
    msg = MockAIMessage(
        response_metadata={
            "token_usage": {
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "total_tokens": 150,
            }
        }
    )
    call_model = instrument_call_model(make_call_model(msg), reporter=reporter)
    call_model({"messages": []})
    event = reporter.model_calls[0]
    assert event.token_count == 150
    assert event.prompt_tokens == 100
    assert event.completion_tokens == 50


def test_extracts_token_count_from_additional_kwargs_usage(reporter):
    msg = MockAIMessage(
        additional_kwargs={"usage": {"prompt_tokens": 80, "completion_tokens": 40, "total_tokens": 120}}
    )
    call_model = instrument_call_model(make_call_model(msg), reporter=reporter)
    call_model({"messages": []})
    event = reporter.model_calls[0]
    assert event.token_count == 120


def test_token_count_zero_when_no_usage_metadata(reporter):
    msg = MockAIMessage()  # no usage metadata
    call_model = instrument_call_model(make_call_model(msg), reporter=reporter)
    call_model({"messages": []})
    assert reporter.model_calls[0].token_count == 0


def test_prompt_tokens_none_when_not_available(reporter):
    msg = MockAIMessage()
    call_model = instrument_call_model(make_call_model(msg), reporter=reporter)
    call_model({"messages": []})
    assert reporter.model_calls[0].prompt_tokens is None


# ── Without reporter tests ─────────────────────────────────────────────────────

def test_works_without_reporter():
    """instrument_call_model must work even when reporter=None."""
    msg = MockAIMessage(content="ok")
    call_model = instrument_call_model(make_call_model(msg))
    result = call_model({"messages": []})
    assert result["messages"][0].content == "ok"


def test_call_log_accessible_without_reporter():
    """get_calls() is exposed on the wrapped function."""
    msg = MockAIMessage()
    call_model = instrument_call_model(make_call_model(msg))
    call_model({"messages": []})
    calls = call_model.get_calls()
    assert len(calls) == 1


# ── Reporter error isolation ───────────────────────────────────────────────────

def test_reporter_error_does_not_propagate():
    """Reporter errors must not affect agent execution."""
    bad_reporter = MagicMock()
    bad_reporter.record_model_call.side_effect = RuntimeError("reporter down")

    msg = MockAIMessage(content="still working")
    call_model = instrument_call_model(make_call_model(msg), reporter=bad_reporter)
    result = call_model({"messages": []})
    assert result["messages"][0].content == "still working"


# ── Multiple call accumulation ─────────────────────────────────────────────────

def test_multiple_calls_accumulate_in_log(reporter):
    msg = MockAIMessage(usage_metadata={"total_tokens": 10, "input_tokens": 5, "output_tokens": 5})
    call_model = instrument_call_model(make_call_model(msg), reporter=reporter)
    call_model({"messages": []})
    call_model({"messages": []})
    call_model({"messages": []})
    assert len(reporter.model_calls) == 3
    calls = call_model.get_calls()
    assert len(calls) == 3


# ── Non-dict return value ──────────────────────────────────────────────────────

def test_handles_non_dict_return(reporter):
    """Gracefully handle call_model functions that return non-dict values."""
    def raw_call_model(state):
        return "raw response"

    call_model = instrument_call_model(raw_call_model, reporter=reporter)
    result = call_model({"messages": []})
    assert result == "raw response"
    assert reporter.model_calls[0].token_count == 0
