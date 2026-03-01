"""
Tests for k8s/upsert.py — build_status_patch() and upsert_agent_observation().

HIGH-5 fix: tests now raise kubernetes_asyncio.client.exceptions.ApiException
instead of a plain Exception, matching the specific catch in the implementation.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from kubernetes_asyncio.client.exceptions import ApiException

from k8s.upsert import GROUP, NAMESPACE, PLURAL, VERSION, build_status_patch, upsert_agent_observation
from tests.conftest import make_gap, make_health


# ── build_status_patch ────────────────────────────────────────────────────────

@pytest.mark.parametrize("health_status,expected_phase", [
    ("ready", "Healthy"),
    ("degraded", "Degraded"),
    ("unavailable", "Unhealthy"),
    ("unknown-value", "Unknown"),
])
def test_build_status_patch_phase_mapping(health_status, expected_phase):
    patch = build_status_patch(make_health(health_status), make_gap(80))
    assert patch["phase"] == expected_phase


@pytest.mark.parametrize("score,expected_grade", [
    (95, "A"),
    (90, "A"),
    (89, "B"),
    (75, "B"),
    (74, "C"),
    (60, "C"),
    (59, "D"),
    (45, "D"),
    (44, "F"),
    (0, "F"),
])
def test_build_status_patch_grade_mapping(score, expected_grade):
    patch = build_status_patch(make_health(), make_gap(score))
    assert patch["grade"] == expected_grade
    assert patch["score"] == score


def test_build_status_patch_includes_health_and_gap():
    health = make_health("ready")
    gap = make_gap(80)
    patch = build_status_patch(health, gap)
    assert patch["health"] == health
    assert patch["gap"] == gap


def test_build_status_patch_missing_status_defaults_unknown():
    patch = build_status_patch({}, {"score": 50})
    assert patch["phase"] == "Unknown"
    assert patch["grade"] == "D"  # 50 is in the 45-59 range


# ── HIGH-5: upsert catches ApiException, not bare Exception ───────────────────

@pytest.mark.asyncio
async def test_upsert_creates_cr_when_not_found():
    """Uses real ApiException(status=404) — verifies HIGH-5 fix."""
    mock_client = AsyncMock()
    mock_client.get_namespaced_custom_object.side_effect = ApiException(status=404)
    mock_client.create_namespaced_custom_object.return_value = {}

    status_patch = build_status_patch(make_health("ready"), make_gap(90))
    await upsert_agent_observation("my-agent", status_patch, _client=mock_client)

    mock_client.create_namespaced_custom_object.assert_called_once()
    call_kwargs = mock_client.create_namespaced_custom_object.call_args.kwargs
    assert call_kwargs["group"] == GROUP
    assert call_kwargs["namespace"] == NAMESPACE
    body = call_kwargs["body"]
    assert body["metadata"]["name"] == "my-agent"
    assert body["spec"]["source"] == "control-plane"
    assert body["status"]["phase"] == "Healthy"


@pytest.mark.asyncio
async def test_upsert_patches_status_when_cr_exists():
    mock_client = AsyncMock()
    mock_client.get_namespaced_custom_object.return_value = {"metadata": {"name": "my-agent"}}
    mock_client.patch_namespaced_custom_object_status.return_value = {}

    status_patch = build_status_patch(make_health("ready"), make_gap(90))
    await upsert_agent_observation("my-agent", status_patch, _client=mock_client)

    mock_client.patch_namespaced_custom_object_status.assert_called_once()
    call_kwargs = mock_client.patch_namespaced_custom_object_status.call_args.kwargs
    assert call_kwargs["name"] == "my-agent"
    assert call_kwargs["body"]["status"]["phase"] == "Healthy"
    mock_client.create_namespaced_custom_object.assert_not_called()


@pytest.mark.asyncio
async def test_upsert_propagates_non_404_api_exceptions():
    """Non-404 ApiException must propagate — not silently caught."""
    mock_client = AsyncMock()
    mock_client.get_namespaced_custom_object.side_effect = ApiException(status=500)

    with pytest.raises(ApiException) as exc_info:
        await upsert_agent_observation(
            "bad-agent",
            build_status_patch(make_health(), make_gap()),
            _client=mock_client,
        )
    assert exc_info.value.status == 500


@pytest.mark.asyncio
async def test_upsert_correct_namespace_and_plural():
    mock_client = AsyncMock()
    mock_client.get_namespaced_custom_object.side_effect = ApiException(status=404)
    mock_client.create_namespaced_custom_object.return_value = {}

    await upsert_agent_observation(
        "agent-ns-check",
        build_status_patch(make_health(), make_gap()),
        _client=mock_client,
    )

    get_kwargs = mock_client.get_namespaced_custom_object.call_args.kwargs
    assert get_kwargs["namespace"] == "agentspec-remote"
    assert get_kwargs["plural"] == "agentobservations"
    assert get_kwargs["group"] == "agentspec.io"
    assert get_kwargs["version"] == "v1"


# ── MEDIUM (new): build_status_patch robustness ───────────────────────────────

def test_build_status_patch_non_numeric_score_defaults_to_zero():
    """Non-numeric score must not raise — clamp to 0 and grade F."""
    patch = build_status_patch(make_health(), {"score": "not-a-number"})
    assert patch["score"] == 0
    assert patch["grade"] == "F"


def test_build_status_patch_none_score_defaults_to_zero():
    """None score must not raise."""
    patch = build_status_patch(make_health(), {"score": None})
    assert patch["score"] == 0


def test_build_status_patch_score_clamped_above_100():
    """Score > 100 must be clamped to 100."""
    patch = build_status_patch(make_health(), {"score": 200})
    assert patch["score"] == 100
    assert patch["grade"] == "A"


def test_build_status_patch_score_clamped_below_zero():
    """Negative score must be clamped to 0."""
    patch = build_status_patch(make_health(), {"score": -10})
    assert patch["score"] == 0
    assert patch["grade"] == "F"


@pytest.mark.asyncio
async def test_upsert_idempotent_called_twice():
    mock_client = AsyncMock()
    mock_client.get_namespaced_custom_object.side_effect = [
        ApiException(status=404),
        {"metadata": {"name": "idempotent-agent"}},
    ]
    mock_client.create_namespaced_custom_object.return_value = {}
    mock_client.patch_namespaced_custom_object_status.return_value = {}

    status_patch = build_status_patch(make_health(), make_gap())
    await upsert_agent_observation("idempotent-agent", status_patch, _client=mock_client)
    await upsert_agent_observation("idempotent-agent", status_patch, _client=mock_client)

    assert mock_client.create_namespaced_custom_object.call_count == 1
    assert mock_client.patch_namespaced_custom_object_status.call_count == 1
