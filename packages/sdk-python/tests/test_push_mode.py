"""
Unit tests for AgentSpecReporter push mode.

Tests written first (TDD) — verifies start_push_mode(), stop_push_mode(),
is_push_mode_active(), sync/async detection, idempotency, and error handling.
"""

from __future__ import annotations

import asyncio
import threading
from typing import List
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import respx

from agentspec.reporter import AgentSpecReporter


@pytest.fixture
def reporter(minimal_manifest):
    return AgentSpecReporter(manifest=minimal_manifest)


# ── Sync mode (no running event loop) ────────────────────────────────────────


def test_sync_mode_uses_threading_timer(reporter):
    """When no running event loop exists, start_push_mode() uses threading.Timer."""
    with patch.object(reporter, "_push_sync"):
        reporter.start_push_mode(
            control_plane_url="http://cp.example.com",
            api_key="test-key",
            interval_seconds=60,
        )
        assert reporter.is_push_mode_active()
        assert isinstance(reporter._timer, threading.Timer)
        reporter.stop_push_mode()


def test_sync_mode_fires_push_immediately(reporter):
    """First push fires immediately when start_push_mode() is called in sync mode."""
    call_count = 0

    original_fire = reporter._fire_and_reschedule

    def counting_push_sync():
        nonlocal call_count
        call_count += 1

    with patch.object(reporter, "_push_sync", side_effect=counting_push_sync):
        reporter.start_push_mode(
            control_plane_url="http://cp.example.com",
            api_key="test-key",
            interval_seconds=60,
        )
        # First push is synchronous — happens before start_push_mode() returns
        assert call_count >= 1
        reporter.stop_push_mode()


def test_sync_mode_stop_cancels_timer(reporter):
    """stop_push_mode() cancels the threading.Timer and sets _timer to None."""
    with patch.object(reporter, "_push_sync"):
        reporter.start_push_mode(
            control_plane_url="http://cp.example.com",
            api_key="test-key",
            interval_seconds=60,
        )
        reporter.stop_push_mode()

        assert not reporter.is_push_mode_active()
        assert reporter._timer is None


# ── Async mode (running event loop) ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_async_mode_uses_asyncio_task(minimal_manifest):
    """When a running event loop exists, start_push_mode() uses asyncio.create_task()."""
    reporter = AgentSpecReporter(manifest=minimal_manifest)

    # AsyncMock returns a coroutine that resolves to None — no unawaited coroutine warnings
    with patch.object(reporter, "_async_push_loop", new_callable=AsyncMock):
        reporter.start_push_mode(
            control_plane_url="http://cp.example.com",
            api_key="test-key",
            interval_seconds=60,
        )
        assert reporter._task is not None
        assert isinstance(reporter._task, asyncio.Task)
        reporter.stop_push_mode()
        await asyncio.sleep(0)  # let cancellation propagate


@pytest.mark.asyncio
async def test_async_mode_stop_cancels_task(minimal_manifest):
    """stop_push_mode() cancels the asyncio.Task and sets _task to None."""
    reporter = AgentSpecReporter(manifest=minimal_manifest)

    with patch.object(reporter, "_async_push_loop", new_callable=AsyncMock):
        reporter.start_push_mode(
            control_plane_url="http://cp.example.com",
            api_key="test-key",
            interval_seconds=60,
        )
        reporter.stop_push_mode()

        assert not reporter.is_push_mode_active()
        assert reporter._task is None
        await asyncio.sleep(0)


# ── Idempotency ───────────────────────────────────────────────────────────────


def test_idempotent_start_push_mode(reporter):
    """Calling start_push_mode() twice does not create a second timer."""
    with patch.object(reporter, "_push_sync"):
        reporter.start_push_mode(
            control_plane_url="http://cp.example.com",
            api_key="test-key",
            interval_seconds=60,
        )
        first_timer = reporter._timer

        reporter.start_push_mode(
            control_plane_url="http://cp.example.com",
            api_key="test-key",
            interval_seconds=60,
        )
        # Timer must be the same object — second call was a no-op
        assert reporter._timer is first_timer
        reporter.stop_push_mode()


# ── HTTP error handling ───────────────────────────────────────────────────────


@respx.mock
def test_http_4xx_calls_on_error_and_push_stays_active(reporter, monkeypatch):
    """HTTP 4xx from control plane triggers on_error, push mode stays active."""
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    respx.post("http://cp.example.com/api/v1/heartbeat").mock(
        return_value=httpx.Response(401)
    )

    errors: List[Exception] = []

    reporter.start_push_mode(
        control_plane_url="http://cp.example.com",
        api_key="test-key",
        interval_seconds=60,
        on_error=lambda e: errors.append(e),
    )

    assert len(errors) >= 1
    assert reporter.is_push_mode_active()
    reporter.stop_push_mode()


# ── HealthReport shape ────────────────────────────────────────────────────────


def test_get_report_shape_matches_health_report(reporter):
    """get_report() returns a HealthReport with all required fields."""
    from agentspec.types import HealthReport

    report = reporter.get_report()
    assert isinstance(report, HealthReport)
    assert hasattr(report, "agent_name")
    assert hasattr(report, "status")
    assert hasattr(report, "checks")
    assert hasattr(report, "summary")
    assert hasattr(report, "timestamp")
