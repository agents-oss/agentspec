"""
Tests for AgentSpecCallbackHandler — LangChain/LangGraph callback integration.

Tests verify:
  - on_tool_start/end records ToolCallEvent with latency + success=True
  - on_tool_error records ToolCallEvent with success=False + error message
  - on_chat_model_start/on_llm_end records ModelCallEvent with token count
  - on_llm_error does not leave dangling start state
  - flush() returns events and clears buffer
  - get_events() is non-destructive
  - Multiple overlapping runs (same handler) collect all events
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from agentspec_langgraph.callback_handler import AgentSpecCallbackHandler
from agentspec_langgraph.events import ModelCallEvent, ToolCallEvent


# ── Helpers ────────────────────────────────────────────────────────────────────

def _run_id() -> UUID:
    return uuid4()


def _tool_start(handler: AgentSpecCallbackHandler, run_id: UUID, name: str) -> None:
    handler.on_tool_start({"name": name}, "input", run_id=run_id)


def _tool_end(handler: AgentSpecCallbackHandler, run_id: UUID) -> None:
    handler.on_tool_end("result", run_id=run_id)


def _tool_error(handler: AgentSpecCallbackHandler, run_id: UUID, err: str = "oops") -> None:
    handler.on_tool_error(RuntimeError(err), run_id=run_id)


def _llm_cycle(
    handler: AgentSpecCallbackHandler,
    run_id: UUID,
    total_tokens: int = 0,
) -> None:
    """Simulate a complete chat model start → end cycle."""
    handler.on_chat_model_start({}, [[]], run_id=run_id)
    # Build a minimal LLMResult-like object
    result = MagicMock()
    result.llm_output = {"token_usage": {"total_tokens": total_tokens,
                                          "prompt_tokens": total_tokens // 2,
                                          "completion_tokens": total_tokens - total_tokens // 2}}
    handler.on_llm_end(result, run_id=run_id)


# ── Tool event tests ───────────────────────────────────────────────────────────


class TestToolEvents:
    def test_tool_success_records_event(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        _tool_start(handler, rid, "plan-workout")
        _tool_end(handler, rid)

        events = handler.get_events()
        assert len(events) == 1
        e = events[0]
        assert isinstance(e, ToolCallEvent)
        assert e.name == "plan-workout"
        assert e.success is True
        assert e.latency_ms >= 0

    def test_tool_error_records_event_with_error(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        _tool_start(handler, rid, "plan-workout")
        _tool_error(handler, rid, "timeout")

        events = handler.get_events()
        assert len(events) == 1
        e = events[0]
        assert isinstance(e, ToolCallEvent)
        assert e.success is False
        assert "timeout" in (e.error or "")

    def test_tool_end_without_start_is_ignored(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        # end without start — must not raise, must not record
        _tool_end(handler, rid)
        assert handler.get_events() == []

    def test_tool_error_without_start_is_ignored(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        _tool_error(handler, rid)
        assert handler.get_events() == []

    def test_multiple_tools_all_recorded(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid1, rid2 = _run_id(), _run_id()
        _tool_start(handler, rid1, "tool-a")
        _tool_start(handler, rid2, "tool-b")
        _tool_end(handler, rid1)
        _tool_end(handler, rid2)

        events = handler.get_events()
        names = {e.name for e in events if isinstance(e, ToolCallEvent)}
        assert names == {"tool-a", "tool-b"}

    def test_serialized_id_fallback(self) -> None:
        """on_tool_start with no 'name' key falls back to last id segment."""
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        handler.on_tool_start({"id": ["langchain", "tools", "MyTool"]}, "input", run_id=rid)
        _tool_end(handler, rid)

        events = handler.get_events()
        assert events[0].name == "MyTool"  # type: ignore[union-attr]


# ── Model event tests ──────────────────────────────────────────────────────────


class TestModelEvents:
    def test_llm_end_records_model_event(self) -> None:
        handler = AgentSpecCallbackHandler(model_id="groq/llama-3.3-70b")
        rid = _run_id()
        _llm_cycle(handler, rid, total_tokens=200)

        events = handler.get_events()
        assert len(events) == 1
        e = events[0]
        assert isinstance(e, ModelCallEvent)
        assert e.model_id == "groq/llama-3.3-70b"
        assert e.token_count == 200
        assert e.latency_ms >= 0

    def test_llm_error_cleans_up_start(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        handler.on_llm_start({}, ["prompt"], run_id=rid)
        handler.on_llm_error(RuntimeError("api down"), run_id=rid)

        # No event recorded for errored LLM call
        assert handler.get_events() == []
        # Internal state cleaned up
        assert str(rid) not in handler._llm_starts

    def test_llm_end_without_start_records_zero_latency(self) -> None:
        """Graceful handling if end arrives without a matching start."""
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        result = MagicMock()
        result.llm_output = {}
        handler.on_llm_end(result, run_id=rid)  # no matching start

        events = handler.get_events()
        assert len(events) == 1
        assert events[0].latency_ms == 0.0  # type: ignore[union-attr]


# ── flush / get_events ─────────────────────────────────────────────────────────


class TestFlushAndGetEvents:
    def test_get_events_is_non_destructive(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        _tool_start(handler, rid, "x")
        _tool_end(handler, rid)

        first = handler.get_events()
        second = handler.get_events()
        assert len(first) == len(second) == 1

    def test_flush_returns_events_and_clears(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        _tool_start(handler, rid, "x")
        _tool_end(handler, rid)

        events = handler.flush()
        assert len(events) == 1
        assert handler.get_events() == []

    def test_flush_clears_pending_starts(self) -> None:
        handler = AgentSpecCallbackHandler()
        rid = _run_id()
        _tool_start(handler, rid, "x")  # start without end
        handler.flush()

        # Dangling starts are cleared
        assert handler._tool_starts == {}
        assert handler._llm_starts == {}

    def test_mixed_events_collected(self) -> None:
        handler = AgentSpecCallbackHandler(model_id="openai/gpt-4o")
        tool_rid = _run_id()
        llm_rid = _run_id()

        _tool_start(handler, tool_rid, "search")
        _tool_end(handler, tool_rid)
        _llm_cycle(handler, llm_rid, total_tokens=500)

        events = handler.get_events()
        assert len(events) == 2
        tool_events = [e for e in events if isinstance(e, ToolCallEvent)]
        model_events = [e for e in events if isinstance(e, ModelCallEvent)]
        assert len(tool_events) == 1
        assert len(model_events) == 1
        assert model_events[0].token_count == 500


# ── _InstrumentedTool.ainvoke ──────────────────────────────────────────────────


class TestInstrumentedToolAinvoke:
    @pytest.mark.asyncio
    async def test_ainvoke_async_tool_is_instrumented(self) -> None:
        from agentspec_langgraph.tool_node import AgentSpecToolNode

        async def async_tool(x: int) -> int:
            return x * 2

        async_tool.name = "double"  # type: ignore[attr-defined]

        node = AgentSpecToolNode([async_tool])
        from agentspec_langgraph.tool_node import _InstrumentedTool

        proxy = _InstrumentedTool(async_tool, node)
        result = await proxy.ainvoke(5)
        assert result == 10

        events = node.get_invocations()
        assert len(events) == 1
        assert events[0].name == "double"
        assert events[0].success is True

    @pytest.mark.asyncio
    async def test_ainvoke_sync_tool_runs_in_executor(self) -> None:
        from agentspec_langgraph.tool_node import AgentSpecToolNode, _InstrumentedTool

        call_count = {"n": 0}

        def sync_tool(x: int) -> int:
            call_count["n"] += 1
            return x + 1

        sync_tool.name = "increment"  # type: ignore[attr-defined]

        node = AgentSpecToolNode([sync_tool])
        proxy = _InstrumentedTool(sync_tool, node)
        result = await proxy.ainvoke(4)
        assert result == 5
        assert call_count["n"] == 1

        events = node.get_invocations()
        assert events[0].success is True

    @pytest.mark.asyncio
    async def test_ainvoke_records_failure(self) -> None:
        from agentspec_langgraph.tool_node import AgentSpecToolNode, _InstrumentedTool

        async def bad_tool(x: int) -> None:
            raise ValueError("boom")

        bad_tool.name = "bad"  # type: ignore[attr-defined]

        node = AgentSpecToolNode([bad_tool])
        proxy = _InstrumentedTool(bad_tool, node)

        with pytest.raises(ValueError, match="boom"):
            await proxy.ainvoke(1)

        events = node.get_invocations()
        assert events[0].success is False
        assert "boom" in (events[0].error or "")
