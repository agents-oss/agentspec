"""
TDD tests for AgentSpecToolNode.

Written before the implementation — these tests define the expected behaviour.
All LangGraph imports are mocked so the suite runs without langgraph installed.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock, patch

import pytest

# ── Mock langgraph before any import ──────────────────────────────────────────

_mock_langgraph = MagicMock()
_mock_langgraph.prebuilt.ToolNode = MagicMock(return_value=MagicMock())
sys.modules.setdefault("langgraph", _mock_langgraph)
sys.modules.setdefault("langgraph.prebuilt", _mock_langgraph.prebuilt)

from agentspec_langgraph import AgentSpecToolNode, ToolCallEvent  # noqa: E402
from tests.conftest import MockReporter, make_tool  # noqa: E402


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def reporter():
    return MockReporter()


@pytest.fixture
def tools():
    return [make_tool("plan-workout", "plan-result"), make_tool("log-session", "log-result")]


@pytest.fixture
def node(tools, reporter):
    return AgentSpecToolNode(tools=tools, reporter=reporter)


# ── Construction tests ────────────────────────────────────────────────────────

def test_tool_names_are_accessible(node, tools):
    assert "plan-workout" in node.tool_names
    assert "log-session" in node.tool_names


def test_tool_count_matches_input(node, tools):
    assert len(node.tool_names) == len(tools)


def test_instrumented_tools_returns_original_list(node, tools):
    assert len(node.instrumented_tools) == len(tools)


def test_no_invocations_initially(node):
    assert node.get_invocations() == []


# ── invoke_tool tests ─────────────────────────────────────────────────────────

def test_invoke_tool_returns_tool_result(node):
    result = node.invoke_tool("plan-workout")
    assert result == "plan-result"


def test_invoke_tool_records_event(node):
    node.invoke_tool("plan-workout")
    events = node.get_invocations()
    assert len(events) == 1
    assert events[0].name == "plan-workout"


def test_invoke_tool_event_success_true(node):
    node.invoke_tool("log-session")
    assert node.get_invocations()[0].success is True


def test_invoke_tool_event_has_positive_latency(node):
    node.invoke_tool("plan-workout")
    assert node.get_invocations()[0].latency_ms >= 0


def test_invoke_tool_notifies_reporter(node, reporter):
    node.invoke_tool("plan-workout")
    assert len(reporter.tool_calls) == 1
    assert reporter.tool_calls[0].name == "plan-workout"


def test_invoke_tool_multiple_events_accumulate(node):
    node.invoke_tool("plan-workout")
    node.invoke_tool("log-session")
    assert len(node.get_invocations()) == 2


def test_invoke_tool_raises_key_error_for_unknown_tool(node):
    with pytest.raises(KeyError, match="unknown-tool"):
        node.invoke_tool("unknown-tool")


def test_invoke_tool_records_failure_on_exception(reporter):
    failing_tool = MagicMock()
    failing_tool.name = "failing-tool"
    failing_tool.side_effect = ValueError("something broke")

    node = AgentSpecToolNode(tools=[failing_tool], reporter=reporter)

    with pytest.raises(ValueError, match="something broke"):
        node.invoke_tool("failing-tool")

    events = node.get_invocations()
    assert len(events) == 1
    assert events[0].success is False
    assert events[0].error == "something broke"


def test_invoke_tool_failure_still_notifies_reporter(reporter):
    failing_tool = MagicMock()
    failing_tool.name = "error-tool"
    failing_tool.side_effect = RuntimeError("oops")

    node = AgentSpecToolNode(tools=[failing_tool], reporter=reporter)

    with pytest.raises(RuntimeError):
        node.invoke_tool("error-tool")

    assert len(reporter.tool_calls) == 1
    assert reporter.tool_calls[0].success is False


def test_invoke_tool_calls_invoke_method_when_available():
    """Tools with .invoke() method should use it (LangChain tool pattern)."""
    tool = MagicMock()
    tool.name = "lc-tool"
    tool.invoke = MagicMock(return_value="invoke-result")

    node = AgentSpecToolNode(tools=[tool])
    result = node.invoke_tool("lc-tool")

    assert result == "invoke-result"
    tool.invoke.assert_called_once()


# ── Reporter error isolation tests ────────────────────────────────────────────

def test_reporter_error_does_not_propagate(tools):
    """Reporter errors must never break the agent."""
    bad_reporter = MagicMock()
    bad_reporter.record_tool_call.side_effect = RuntimeError("reporter down")

    node = AgentSpecToolNode(tools=tools, reporter=bad_reporter)
    # Should NOT raise despite reporter error
    result = node.invoke_tool("plan-workout")
    assert result == "plan-result"


# ── None reporter tests ────────────────────────────────────────────────────────

def test_works_without_reporter():
    tool = MagicMock()
    tool.name = "simple-tool"
    tool.return_value = "ok"

    node = AgentSpecToolNode(tools=[tool])
    result = node.invoke_tool("simple-tool")
    assert result == "ok"
    assert len(node.get_invocations()) == 1


# ── as_langgraph_node tests ───────────────────────────────────────────────────

def test_as_langgraph_node_returns_langgraph_tool_node(node):
    """as_langgraph_node() should return a LangGraph ToolNode."""
    lg_node = node.as_langgraph_node()
    # The mock ToolNode constructor was called
    assert lg_node is not None


def test_as_langgraph_node_raises_import_error_without_langgraph(tools):
    """When langgraph is not installed, raise ImportError with helpful message."""
    # Temporarily remove mock so import fails
    saved = sys.modules.pop("langgraph.prebuilt", None)
    saved_lg = sys.modules.pop("langgraph", None)
    try:
        # Force real import (will fail if langgraph not actually installed)
        with patch.dict("sys.modules", {"langgraph": None, "langgraph.prebuilt": None}):
            node_fresh = AgentSpecToolNode(tools=tools)
            with pytest.raises(ImportError, match="langgraph"):
                node_fresh.as_langgraph_node()
    finally:
        if saved_lg:
            sys.modules["langgraph"] = saved_lg
        if saved:
            sys.modules["langgraph.prebuilt"] = saved


# ── get_invocations immutability test ─────────────────────────────────────────

def test_get_invocations_returns_copy(node):
    node.invoke_tool("plan-workout")
    invocations = node.get_invocations()
    invocations.clear()  # mutate the returned copy
    # Original should still have 1 event
    assert len(node.get_invocations()) == 1


# ── ToolCallEvent type checks ─────────────────────────────────────────────────

def test_tool_call_event_has_required_fields(node):
    node.invoke_tool("plan-workout")
    event = node.get_invocations()[0]
    assert isinstance(event, ToolCallEvent)
    assert event.name == "plan-workout"
    assert isinstance(event.latency_ms, float)
    assert isinstance(event.success, bool)
    assert event.error is None
