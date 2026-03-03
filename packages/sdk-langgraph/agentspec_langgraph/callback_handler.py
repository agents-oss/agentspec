"""
AgentSpecCallbackHandler — LangChain/LangGraph native callback integration.

Implements BaseCallbackHandler to capture tool, model, and chain events
automatically from any LangGraph graph — including prebuilt patterns like
create_react_agent — without manual tool wrapping.

Usage (preferred for create_react_agent and prebuilt graphs):

    from agentspec_langgraph import AgentSpecCallbackHandler, SidecarClient
    from langgraph.prebuilt import create_react_agent

    handler = AgentSpecCallbackHandler(
        agent_name="gymcoach",
        model_id="groq/llama-3.3-70b-versatile",
    )

    agent = create_react_agent(llm, tools)

    # Pass handler via config — no tool wrapping needed
    result = await agent.ainvoke(
        {"messages": [...]},
        config={"callbacks": [handler]},
    )

    # On request exit: push all collected events
    sidecar = SidecarClient()
    sidecar.push_events_sync(
        request_id=request_id,
        agent_name="gymcoach",
        events=handler.flush(),
    )

Usage (with manual StateGraph):

    handler = AgentSpecCallbackHandler(model_id="groq/llama-3.3-70b-versatile")

    result = await graph.ainvoke(
        input,
        config={"callbacks": [handler]},
    )

    events = handler.flush()  # list[ToolCallEvent | ModelCallEvent]
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Sequence, Union
from uuid import UUID

from .events import ModelCallEvent, ToolCallEvent


class AgentSpecCallbackHandler:
    """
    LangChain/LangGraph BaseCallbackHandler-compatible event collector.

    Records ToolCallEvent and ModelCallEvent from LangGraph's native event
    stream — works with ToolNode, create_react_agent, and any graph that
    accepts a RunnableConfig callbacks list.

    This is the recommended instrumentation approach for prebuilt graphs.
    For manual StateGraph construction, AgentSpecToolNode is also supported.

    Thread-safe: events are collected per-handler instance. Create one
    handler per request for per-request isolation.
    """

    # LangChain callback protocol requires these class attributes
    raise_error: bool = False
    ignore_agent: bool = False
    ignore_chat_model: bool = False
    ignore_chain: bool = False
    ignore_custom_event: bool = False
    ignore_llm: bool = False
    ignore_retriever: bool = False
    ignore_retry: bool = False

    def __init__(
        self,
        agent_name: str = "unknown",
        model_id: str = "unknown/unknown",
    ) -> None:
        """
        Parameters
        ----------
        agent_name:
            Agent name from metadata.name in agent.yaml. Used for logging only;
            the events themselves are pushed via SidecarClient with the agent name.
        model_id:
            Model identifier as "provider/id" used in emitted ModelCallEvents.
            Should match the model string from agent.yaml spec.model.
        """
        self._agent_name = agent_name
        self._model_id = model_id
        self._events: list[Union[ToolCallEvent, ModelCallEvent]] = []
        # Per-run timing: run_id → start time
        self._tool_starts: dict[str, tuple[str, float]] = {}  # run_id → (name, t0)
        self._llm_starts: dict[str, float] = {}  # run_id → t0

    # ── Tool callbacks ─────────────────────────────────────────────────────────

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        inputs: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        name = serialized.get("name") or serialized.get("id", ["unknown"])[-1]
        self._tool_starts[str(run_id)] = (str(name), time.monotonic())

    def _finish_tool(
        self,
        run_id: UUID,
        success: bool,
        error: Optional[BaseException] = None,
    ) -> None:
        """Record a ToolCallEvent for a completed (success or error) tool run."""
        key = str(run_id)
        if key in self._tool_starts:
            name, t0 = self._tool_starts.pop(key)
            latency_ms = (time.monotonic() - t0) * 1000
            self._events.append(
                ToolCallEvent(
                    name=name,
                    latency_ms=latency_ms,
                    success=success,
                    error=str(error) if error is not None else None,
                )
            )

    def on_tool_end(
        self,
        output: Any,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        tags: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> None:
        self._finish_tool(run_id, success=True)

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        tags: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> None:
        self._finish_tool(run_id, success=False, error=error)

    # ── LLM / Chat model callbacks ─────────────────────────────────────────────

    def on_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        self._llm_starts[str(run_id)] = time.monotonic()

    def on_chat_model_start(
        self,
        serialized: Dict[str, Any],
        messages: List[List[Any]],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        self._llm_starts[str(run_id)] = time.monotonic()

    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        key = str(run_id)
        t0 = self._llm_starts.pop(key, None)
        latency_ms = (time.monotonic() - t0) * 1000 if t0 else 0.0

        # Extract token usage from LLMResult
        total_tokens = 0
        prompt_tokens: Optional[int] = None
        completion_tokens: Optional[int] = None

        try:
            usage = (
                getattr(response, "llm_output", {}) or {}
            ).get("token_usage") or {}
            if isinstance(usage, dict):
                total_tokens = int(usage.get("total_tokens", 0) or 0)
                prompt_tokens = usage.get("prompt_tokens")
                completion_tokens = usage.get("completion_tokens")
        except Exception:
            pass

        self._events.append(
            ModelCallEvent(
                model_id=self._model_id,
                latency_ms=latency_ms,
                token_count=total_tokens,
                prompt_tokens=int(prompt_tokens) if prompt_tokens is not None else None,
                completion_tokens=int(completion_tokens) if completion_tokens is not None else None,
            )
        )

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        self._llm_starts.pop(str(run_id), None)

    # ── Required no-op stubs (LangChain callback protocol) ────────────────────

    def on_chain_start(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_chain_end(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_chain_error(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_agent_action(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_agent_finish(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_retriever_start(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_retriever_end(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_retriever_error(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_text(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_custom_event(self, *args: Any, **kwargs: Any) -> None:
        pass

    # ── Public API ─────────────────────────────────────────────────────────────

    def get_events(self) -> List[Union[ToolCallEvent, ModelCallEvent]]:
        """Return all collected events (non-destructive)."""
        return list(self._events)

    def flush(self) -> List[Union[ToolCallEvent, ModelCallEvent]]:
        """Return all collected events and clear the internal buffer."""
        events = list(self._events)
        self._events.clear()
        self._tool_starts.clear()
        self._llm_starts.clear()
        return events
