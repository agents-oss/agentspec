"""
Shared pytest fixtures for the operator test suite.

All fixtures return pure data objects — no I/O, no network, no Kubernetes.
"""

import pytest

from models import (
    GapIssue,
    GapObserved,
    GapReport,
    HealthCheck,
    HealthSummary,
    ProbeResult,
    ReadyReport,
)


# ── ReadyReport factories ─────────────────────────────────────────────────────

def make_health(
    status: str = "ready",
    source: str = "agent-sdk",
    checks: list | None = None,
    agent_name: str = "test-agent",
) -> ReadyReport:
    checks = checks or []
    passed = sum(1 for c in checks if c.status == "pass")
    failed = sum(1 for c in checks if c.status == "fail")
    warnings = sum(1 for c in checks if c.status == "warn")
    skipped = sum(1 for c in checks if c.status == "skip")
    return ReadyReport(
        status=status,
        source=source,
        agentName=agent_name,
        timestamp="2026-01-01T00:00:00+00:00",
        summary=HealthSummary(
            passed=passed, failed=failed, warnings=warnings, skipped=skipped
        ),
        checks=checks,
    )


def make_gap(
    score: int = 100,
    issues: list | None = None,
    source: str = "agent-sdk",
) -> GapReport:
    return GapReport(
        score=score,
        issues=issues or [],
        source=source,
        observed=GapObserved(
            hasHealthEndpoint=True,
            hasCapabilitiesEndpoint=True,
            upstreamTools=[],
        ),
    )


def make_model_check(status: str = "pass", latency_ms: int | None = 42) -> HealthCheck:
    return HealthCheck(
        id="model:anthropic",
        category="model",
        status=status,
        severity="error",
        latencyMs=latency_ms,
    )


def make_probe(
    health_status: str = "ready",
    gap_score: int = 100,
    issues: list | None = None,
    checks: list | None = None,
    source: str = "agent-sdk",
) -> ProbeResult:
    return ProbeResult(
        health=make_health(status=health_status, checks=checks or [], source=source),
        gap=make_gap(score=gap_score, issues=issues or [], source=source),
    )


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def healthy_probe() -> ProbeResult:
    """Fully compliant, healthy agent — expected grade A."""
    return make_probe(
        health_status="ready",
        gap_score=94,
        checks=[make_model_check("pass")],
    )


@pytest.fixture
def degraded_probe() -> ProbeResult:
    """Missing guardrails + model key unset — expected grade D."""
    issues = [
        GapIssue(
            severity="high",
            property="model.apiKey",
            description="Model endpoint unreachable",
            recommendation="Set OPENAI_API_KEY",
        ),
        GapIssue(
            severity="medium",
            property="auditable",
            description="No guardrails declared",
            recommendation="Add spec.guardrails",
        ),
    ]
    checks = [make_model_check("fail", latency_ms=None)]
    return make_probe(
        health_status="degraded",
        gap_score=45,
        issues=issues,
        checks=checks,
        source="manifest-static",
    )


@pytest.fixture
def unhealthy_probe() -> ProbeResult:
    """Worst-case — no compliance, grade F."""
    issues = [
        GapIssue(severity="critical", property="model.apiKey",
                 description="No model key", recommendation="Set key"),
        GapIssue(severity="high", property="auditable",
                 description="No guardrails", recommendation="Add guardrails"),
        GapIssue(severity="high", property="healthcheckable",
                 description="No /health endpoint", recommendation="Add health"),
        GapIssue(severity="medium", property="discoverable",
                 description="No /capabilities", recommendation="Add caps"),
    ]
    return make_probe(
        health_status="unavailable",
        gap_score=12,
        issues=issues,
        source="manifest-static",
    )
