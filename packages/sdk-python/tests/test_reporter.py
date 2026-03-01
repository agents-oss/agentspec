"""
Unit tests for AgentSpecReporter.from_yaml() and get_report().

Tests written first (TDD) — verifies reporter construction and HealthReport shape.
"""

import os

import pytest
import yaml

from agentspec.reporter import AgentSpecReporter
from agentspec.types import HealthCheck, HealthReport


def test_from_yaml_creates_reporter(tmp_path, minimal_manifest):
    """from_yaml() reads an agent.yaml file and returns an AgentSpecReporter."""
    manifest_file = tmp_path / "agent.yaml"
    manifest_file.write_text(yaml.dump(minimal_manifest))

    reporter = AgentSpecReporter.from_yaml(str(manifest_file))
    assert reporter is not None
    assert isinstance(reporter, AgentSpecReporter)


def test_from_yaml_stores_agent_name(tmp_path, minimal_manifest):
    """Reporter loaded from YAML reflects the correct agent name."""
    manifest_file = tmp_path / "agent.yaml"
    manifest_file.write_text(yaml.dump(minimal_manifest))

    reporter = AgentSpecReporter.from_yaml(str(manifest_file))
    report = reporter.get_report()
    assert report.agent_name == "test-agent"


def test_from_yaml_raises_on_missing_file():
    """from_yaml() raises FileNotFoundError for a non-existent path."""
    with pytest.raises(FileNotFoundError):
        AgentSpecReporter.from_yaml("/no/such/file/agent.yaml")


def test_get_report_returns_health_report(minimal_manifest):
    """get_report() returns a HealthReport Pydantic model instance."""
    reporter = AgentSpecReporter(manifest=minimal_manifest)
    report = reporter.get_report()
    assert isinstance(report, HealthReport)


def test_get_report_agent_name(minimal_manifest):
    """get_report().agent_name matches metadata.name from the manifest."""
    reporter = AgentSpecReporter(manifest=minimal_manifest)
    report = reporter.get_report()
    assert report.agent_name == "test-agent"


def test_get_report_status_is_valid(minimal_manifest):
    """get_report().status is one of 'healthy', 'degraded', or 'unhealthy'."""
    reporter = AgentSpecReporter(manifest=minimal_manifest)
    report = reporter.get_report()
    assert report.status in ("healthy", "degraded", "unhealthy")


def test_get_report_has_timestamp(minimal_manifest):
    """get_report().timestamp is a non-empty ISO string."""
    reporter = AgentSpecReporter(manifest=minimal_manifest)
    report = reporter.get_report()
    assert isinstance(report.timestamp, str)
    assert len(report.timestamp) > 0


def test_get_report_has_summary(minimal_manifest):
    """get_report().summary contains integer counts."""
    reporter = AgentSpecReporter(manifest=minimal_manifest)
    report = reporter.get_report()
    assert isinstance(report.summary, dict)
    assert "passed" in report.summary
    assert "failed" in report.summary


def test_get_report_checks_is_list(minimal_manifest):
    """get_report().checks is a list of HealthCheck objects."""
    reporter = AgentSpecReporter(manifest=minimal_manifest)
    report = reporter.get_report()
    assert isinstance(report.checks, list)
    for check in report.checks:
        assert isinstance(check, HealthCheck)


def test_get_report_unhealthy_when_env_var_missing(minimal_manifest, monkeypatch):
    """get_report() returns 'unhealthy' when the declared env var is absent."""
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    reporter = AgentSpecReporter(manifest=minimal_manifest)
    report = reporter.get_report()
    assert report.status == "unhealthy"
    assert report.summary["failed"] >= 1


def test_get_report_healthy_when_env_var_set(minimal_manifest, monkeypatch):
    """get_report() returns 'healthy' when all declared env vars are present."""
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test-key")
    reporter = AgentSpecReporter(manifest=minimal_manifest)
    report = reporter.get_report()
    assert report.status == "healthy"
    assert report.summary["passed"] >= 1
