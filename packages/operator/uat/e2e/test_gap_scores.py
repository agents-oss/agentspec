"""
test_gap_scores.py — /gap score and grade assertions for all 5 demo agents.

/gap returns { score: int (0-100), issues: [...], source, modelId, observed }.
Grade is derived from score: A≥90, B≥75, C≥60, D≥45, F<45.
"""
from __future__ import annotations

import pytest
import httpx

# agent → (expected_grade, proxy_port, control_port)
EXPECTED: dict[str, tuple[str, int, int]] = {
    "gymcoach":        ("A", 4000, 4001),
    "trading-bot":     ("D", 4002, 4003),
    "voice-assistant": ("C", 4004, 4005),
    "fitness-tracker": ("A", 4006, 4007),
    "research-agent":  ("F", 4008, 4009),
}


def _score_to_grade(score: int) -> str:
    """Convert a 0-100 gap score to a letter grade (mirrors the sidecar logic)."""
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    if score >= 60:
        return "C"
    if score >= 45:
        return "D"
    return "F"


@pytest.mark.parametrize(
    "agent,expected_grade",
    [(agent, info[0]) for agent, info in EXPECTED.items()],
    ids=list(EXPECTED.keys()),
)
def test_gap_grade(agent: str, expected_grade: str, port_forward):
    _, proxy_port, control_port = EXPECTED[agent]
    _, control_url = port_forward(agent, proxy_port, control_port)

    r = httpx.get(f"{control_url}/gap", timeout=15)
    assert r.status_code == 200, (
        f"{agent}: /gap returned {r.status_code}"
    )

    body = r.json()
    score = body.get("score")
    assert score is not None, f"{agent}: /gap response missing 'score' field"

    actual_grade = _score_to_grade(score)
    assert actual_grade == expected_grade, (
        f"{agent}: score={score} → grade={actual_grade!r}, want={expected_grade!r}"
    )

    # Low-grade agents must have at least one issue surfaced
    if expected_grade in ("D", "F"):
        issues = body.get("issues", [])
        assert len(issues) > 0, (
            f"{agent}: grade={expected_grade!r} but no issues reported — "
            f"the gap endpoint should surface compliance failures"
        )


def test_gap_response_shape(port_forward):
    """Spot-check that /gap returns the expected top-level keys."""
    _, control_url = port_forward("gymcoach", 4000, 4001)
    r = httpx.get(f"{control_url}/gap", timeout=15)
    assert r.status_code == 200
    body = r.json()
    for key in ("score", "issues", "observed"):
        assert key in body, f"/gap response missing key '{key}'"


def test_gap_observed_fields(port_forward):
    """The 'observed' section must contain the three runtime probe fields."""
    _, control_url = port_forward("gymcoach", 4000, 4001)
    r = httpx.get(f"{control_url}/gap", timeout=15)
    assert r.status_code == 200
    observed = r.json().get("observed", {})
    for field in ("hasHealthEndpoint", "hasCapabilitiesEndpoint", "upstreamTools"):
        assert field in observed, f"/gap.observed missing field '{field}'"


def test_gap_issues_have_required_fields(port_forward):
    """Each issue in /gap must include 'property', 'severity', and 'description'."""
    _, control_url = port_forward("research-agent", 4008, 4009)
    r = httpx.get(f"{control_url}/gap", timeout=15)
    assert r.status_code == 200
    issues = r.json().get("issues", [])
    assert len(issues) > 0, "research-agent (grade F) must have issues"
    for issue in issues:
        for field in ("property", "severity", "description"):
            assert field in issue, (
                f"Issue missing required field '{field}': {issue}"
            )
