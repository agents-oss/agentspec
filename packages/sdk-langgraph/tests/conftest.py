"""
Shared fixtures and helpers for agentspec-langgraph tests.

All LangGraph imports are mocked so the test suite runs without
requiring langgraph or langchain to be installed.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock


# ── Minimal mock objects ───────────────────────────────────────────────────────

class MockAIMessage:
    """Minimal AIMessage mock — only the fields we care about."""

    def __init__(
        self,
        content: str = "Hello!",
        tool_calls: list | None = None,
        usage_metadata: dict | None = None,
        response_metadata: dict | None = None,
        additional_kwargs: dict | None = None,
    ) -> None:
        self.content = content
        self.tool_calls = tool_calls or []
        self.usage_metadata = usage_metadata
        self.response_metadata = response_metadata or {}
        self.additional_kwargs = additional_kwargs or {}


class MockReporter:
    """Minimal AgentSpecReporter mock that records calls."""

    def __init__(self) -> None:
        self.tool_calls: list = []
        self.model_calls: list = []
        self.guardrail_invocations: list = []

    def record_tool_call(self, event: Any) -> None:
        self.tool_calls.append(event)

    def record_model_call(self, event: Any) -> None:
        self.model_calls.append(event)

    def record_guardrail_invocation(self, event: Any) -> None:
        self.guardrail_invocations.append(event)


def make_tool(name: str, return_value: Any = "result", raises: Exception | None = None) -> Any:
    """Create a minimal callable mock tool."""
    mock = MagicMock()
    mock.name = name
    mock.__name__ = name
    if raises is not None:
        mock.side_effect = raises
        if hasattr(mock, 'invoke'):
            mock.invoke.side_effect = raises
    else:
        mock.return_value = return_value
        if hasattr(mock, 'invoke'):
            mock.invoke.return_value = return_value
    return mock
