"""
agentspec — Python SDK for AgentSpec Universal Agent Manifests.

Usage:
    from agentspec import AgentSpecReporter

    reporter = AgentSpecReporter.from_yaml("agent.yaml")
    reporter.start_push_mode(
        control_plane_url="https://control-plane.agentspec.io",
        api_key="<key from agentspec register>",
    )
"""

from .reporter import AgentSpecReporter
from .types import HealthReport, HealthCheck

__all__ = ["AgentSpecReporter", "HealthReport", "HealthCheck"]
