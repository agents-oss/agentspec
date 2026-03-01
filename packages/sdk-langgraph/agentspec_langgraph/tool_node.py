"""
AgentSpecToolNode — LangGraph tool wrapper with AgentSpec instrumentation.

Wraps each tool invocation to:
  1. Measure wall-clock latency
  2. Record success / failure
  3. Emit a ToolCallEvent to the attached AgentSpecReporter

Usage:
    from agentspec_langgraph import AgentSpecToolNode

    # Wrap tools with instrumentation
    tool_node = AgentSpecToolNode(
        tools=[plan_workout, log_session],
        reporter=reporter,
    )

    # Use in LangGraph graph:
    workflow.add_node("tools", tool_node.as_langgraph_node())

    # Or use the instrumented tool list directly:
    instrumented_tools = tool_node.instrumented_tools
    llm_with_tools = llm.bind_tools(instrumented_tools)
"""

from __future__ import annotations

import inspect
import time
from collections import deque
from typing import Any, Callable, List, Optional

from .events import ToolCallEvent


class AgentSpecToolNode:
    """
    Wraps a list of tools (callables or LangChain @tool-decorated functions)
    with AgentSpec instrumentation.

    LangGraph integration:
        tool_node.as_langgraph_node() returns a ToolNode ready for the graph.

    Direct instrumentation:
        tool_node.invoke_tool(name, *args, **kwargs) to call a specific tool
        with timing and event emission.
    """

    def __init__(
        self,
        tools: List[Any],
        reporter: Optional[Any] = None,
        max_events: int = 10_000,
    ) -> None:
        """
        Parameters
        ----------
        tools:
            List of tool callables or LangChain @tool-decorated functions.
        reporter:
            Optional AgentSpecReporter (or any object with a record_tool_call()
            method). When provided, every tool invocation triggers a callback.
        max_events:
            Maximum number of invocation events to retain in memory (default: 10,000).
            Older events are dropped when the limit is reached.
        """
        self._tools = list(tools)
        self._reporter = reporter
        self._invocations: deque[ToolCallEvent] = deque(maxlen=max_events)

        # Build a name → tool mapping
        self._tool_map: dict[str, Any] = {}
        for t in self._tools:
            name = _tool_name(t)
            self._tool_map[name] = t

    # ── Public API ─────────────────────────────────────────────────────────────

    @property
    def tool_names(self) -> List[str]:
        """Names of all registered tools."""
        return list(self._tool_map.keys())

    @property
    def instrumented_tools(self) -> List[Any]:
        """
        Return the original tool objects unwrapped.

        For binding to an LLM via llm.bind_tools(), pass the original tools.
        Use invoke_tool() or as_langgraph_node() for instrumented execution.
        """
        return list(self._tools)

    def invoke_tool(self, name: str, *args: Any, **kwargs: Any) -> Any:
        """
        Invoke a registered tool by name with instrumentation.

        Supports both regular callables and LangChain tools (.invoke() method).
        Records a ToolCallEvent regardless of success or failure.

        Raises
        ------
        KeyError
            If `name` is not in the registered tools.
        """
        if name not in self._tool_map:
            raise KeyError(
                f"Tool '{name}' is not registered in AgentSpecToolNode. "
                f"Available tools: {self.tool_names}"
            )

        tool = self._tool_map[name]
        start = time.monotonic()

        try:
            if inspect.getattr_static(tool, 'invoke', None) is not None:
                result = tool.invoke(*args, **kwargs)
            else:
                result = tool(*args, **kwargs)

            latency_ms = (time.monotonic() - start) * 1000
            self._record(ToolCallEvent(name=name, latency_ms=latency_ms, success=True))
            return result

        except Exception as exc:
            latency_ms = (time.monotonic() - start) * 1000
            self._record(
                ToolCallEvent(
                    name=name,
                    latency_ms=latency_ms,
                    success=False,
                    error=str(exc),
                )
            )
            raise

    def get_invocations(self) -> List[ToolCallEvent]:
        """Return all recorded tool invocation events (copy)."""
        return list(self._invocations)

    def as_langgraph_node(self) -> Any:
        """
        Return a LangGraph ToolNode with instrumentation wired in.

        Each tool is wrapped so that every .invoke() call records a
        ToolCallEvent before delegating to the original implementation.

        Requires:
            pip install langgraph
        """
        try:
            from langgraph.prebuilt import ToolNode  # type: ignore[import]
        except ImportError as exc:
            raise ImportError(
                "langgraph is required to use as_langgraph_node(). "
                "Install it: pip install langgraph"
            ) from exc

        wrapped = [_InstrumentedTool(t, self) for t in self._tools]
        return ToolNode(wrapped)

    # ── Internal ───────────────────────────────────────────────────────────────

    def _record(self, event: ToolCallEvent) -> None:
        """Record event internally and notify reporter (errors are swallowed)."""
        self._invocations.append(event)
        if self._reporter is not None:
            try:
                self._reporter.record_tool_call(event)
            except Exception:
                pass  # Reporter errors never break the agent


# ── Helpers ────────────────────────────────────────────────────────────────────

def _tool_name(tool: Any) -> str:
    """Extract the display name from a tool object or callable."""
    return (
        getattr(tool, 'name', None)
        or getattr(tool, '__name__', None)
        or repr(tool)
    )


class _InstrumentedTool:
    """
    Thin proxy around a LangChain tool that intercepts .invoke() calls
    and records them via the parent AgentSpecToolNode.

    All other attributes (name, description, args_schema, …) are proxied
    from the original tool so LangGraph can introspect them normally.
    """

    def __init__(self, original: Any, node: 'AgentSpecToolNode') -> None:
        self._original = original
        self._node = node
        self.name = _tool_name(original)

    def __getattr__(self, item: str) -> Any:
        # Guard against recursion when _original is not yet set
        try:
            original = object.__getattribute__(self, "_original")
        except AttributeError:
            raise AttributeError(item)
        return getattr(original, item)

    def invoke(self, *args: Any, **kwargs: Any) -> Any:
        start = time.monotonic()
        try:
            if callable(getattr(type(self._original), 'invoke', None)):
                result = self._original.invoke(*args, **kwargs)
            else:
                result = self._original(*args, **kwargs)
            latency_ms = (time.monotonic() - start) * 1000
            self._node._record(
                ToolCallEvent(name=self.name, latency_ms=latency_ms, success=True)
            )
            return result
        except Exception as exc:
            latency_ms = (time.monotonic() - start) * 1000
            self._node._record(
                ToolCallEvent(
                    name=self.name,
                    latency_ms=latency_ms,
                    success=False,
                    error=str(exc),
                )
            )
            raise


