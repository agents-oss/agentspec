"""
Unit tests for prober.py.

Covers:
  make_unavailable_probe  — synthetic failure probe shape
  probe_agent             — success path and ConnectError propagation
                            (httpx _CLIENT mocked; no network calls)
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from prober import make_unavailable_probe, probe_agent


# ── make_unavailable_probe ────────────────────────────────────────────────────

class TestMakeUnavailableProbe:
    def test_score_is_zero(self):
        result = make_unavailable_probe("connection refused")
        assert result.gap.score == 0

    def test_health_status_is_unavailable(self):
        result = make_unavailable_probe("timeout")
        assert result.health.status == "unavailable"

    def test_source_is_manifest_static(self):
        result = make_unavailable_probe("dns failure")
        assert result.health.source == "manifest-static"
        assert result.gap.source == "manifest-static"

    def test_error_message_preserved(self):
        result = make_unavailable_probe("ECONNREFUSED 127.0.0.1:4001")
        assert result.health.error == "ECONNREFUSED 127.0.0.1:4001"

    def test_no_checks(self):
        result = make_unavailable_probe("error")
        assert result.health.checks == []

    def test_no_issues(self):
        result = make_unavailable_probe("error")
        assert result.gap.issues == []

    def test_phase_maps_to_unhealthy(self):
        # health_status property: "unavailable" → "unhealthy"
        result = make_unavailable_probe("error")
        assert result.health.health_status == "unhealthy"


# ── probe_agent ───────────────────────────────────────────────────────────────

_HEALTH_PAYLOAD = {
    "status": "ready",
    "source": "agent-sdk",
    "agentName": "gymcoach",
    "timestamp": "2026-01-01T00:00:00+00:00",
    "summary": {"passed": 3, "failed": 0, "warnings": 0, "skipped": 0},
    "checks": [
        {
            "id": "model:anthropic",
            "category": "model",
            "status": "pass",
            "severity": "error",
            "latencyMs": 38,
        }
    ],
}

_GAP_PAYLOAD = {
    "score": 94,
    "issues": [],
    "source": "agent-sdk",
    "observed": {
        "hasHealthEndpoint": True,
        "hasCapabilitiesEndpoint": True,
        "upstreamTools": [],
    },
}


def _make_response(payload: dict) -> MagicMock:
    """Build a mock httpx.Response that returns payload from .json()."""
    resp = MagicMock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    return resp


class TestProbeAgent:
    async def test_success_returns_probe_result(self):
        health_resp = _make_response(_HEALTH_PAYLOAD)
        gap_resp = _make_response(_GAP_PAYLOAD)

        with patch("prober._CLIENT") as mock_client:
            mock_client.get = AsyncMock(side_effect=[health_resp, gap_resp])
            result = await probe_agent("http://gymcoach-sidecar.demo.svc.cluster.local:4001")

        assert result.health.status == "ready"
        assert result.health.agentName == "gymcoach"
        assert result.gap.score == 94
        assert result.gap.issues == []

    async def test_success_parses_model_check(self):
        health_resp = _make_response(_HEALTH_PAYLOAD)
        gap_resp = _make_response(_GAP_PAYLOAD)

        with patch("prober._CLIENT") as mock_client:
            mock_client.get = AsyncMock(side_effect=[health_resp, gap_resp])
            result = await probe_agent("http://test:4001")

        model_check = next(
            (c for c in result.health.checks if c.category == "model"), None
        )
        assert model_check is not None
        assert model_check.status == "pass"
        assert model_check.latencyMs == 38

    async def test_connect_error_propagates(self):
        """ConnectError (DNS / refused) must propagate — caller classifies severity."""
        with patch("prober._CLIENT") as mock_client:
            mock_client.get = AsyncMock(
                side_effect=httpx.ConnectError("Name or service not known")
            )
            with pytest.raises(httpx.ConnectError):
                await probe_agent("http://missing-sidecar.demo.svc.cluster.local:4001")

    async def test_http_status_error_propagates(self):
        """Non-2xx responses raise HTTPStatusError — caller handles gracefully."""
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            "503 Service Unavailable",
            request=MagicMock(),
            response=MagicMock(),
        )

        with patch("prober._CLIENT") as mock_client:
            mock_client.get = AsyncMock(return_value=mock_resp)
            with pytest.raises(httpx.HTTPStatusError):
                await probe_agent("http://test:4001")

    async def test_custom_timeout_passed_to_client(self):
        """The timeout parameter is forwarded to the underlying GET calls."""
        health_resp = _make_response(_HEALTH_PAYLOAD)
        gap_resp = _make_response(_GAP_PAYLOAD)

        with patch("prober._CLIENT") as mock_client:
            mock_client.get = AsyncMock(side_effect=[health_resp, gap_resp])
            await probe_agent("http://test:4001", timeout=5)

        # Both calls should have received an httpx.Timeout (not the default)
        for call in mock_client.get.call_args_list:
            assert "timeout" in call.kwargs
            assert isinstance(call.kwargs["timeout"], httpx.Timeout)
