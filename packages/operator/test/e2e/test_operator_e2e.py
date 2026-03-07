"""
test_operator_e2e.py — Lightweight CI E2E suite for the AgentSpec operator.

Prerequisites (set up by e2e-k8s.yml before pytest runs):
  - kind cluster with agentspec-operator installed (webhook.enabled=true)
  - gymcoach deployment running in the 'demo' namespace

Three smoke tests:
  1. proxy_passthrough    — sidecar forwards requests to the agent backend
  2. agentobservation     — AgentObservation CR exists for gymcoach
  3. health_grade         — /agentspec/health returns a known status
"""
from __future__ import annotations

import json
import subprocess


def test_proxy_passthrough(gymcoach_urls):
    """Requests forwarded through the sidecar proxy reach the agent backend."""
    import httpx

    proxy_url, _ = gymcoach_urls
    r = httpx.get(f"{proxy_url}/health", timeout=10)
    assert r.status_code == 200, f"Proxy passthrough failed: {r.status_code} {r.text}"


def test_agentobservation_created(namespace):
    """An AgentObservation CR named 'gymcoach' exists in the namespace."""
    result = subprocess.run(
        [
            "kubectl", "get", "agentobservations", "gymcoach",
            "-n", namespace,
            "-o", "json",
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, (
        f"AgentObservation 'gymcoach' not found in namespace '{namespace}':\n"
        f"{result.stderr}"
    )
    data = json.loads(result.stdout)
    assert data["metadata"]["name"] == "gymcoach"


def test_health_grade(gymcoach_urls):
    """Sidecar /health/ready returns 'healthy' or 'degraded' (never 'unknown')."""
    import httpx

    _, control_url = gymcoach_urls
    r = httpx.get(f"{control_url}/health/ready", timeout=10)
    assert r.status_code == 200, f"Health endpoint returned {r.status_code}"
    data = r.json()
    status = data.get("status")
    assert status in {"healthy", "degraded", "ready"}, (
        f"Expected 'healthy', 'degraded', or 'ready', got: {status!r}"
    )
