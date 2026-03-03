"""
test_opa_enforce.py — OPA enforce-mode test.

fitness-tracker has an OPA policy (ConfigMap).  This test patches the sidecar
deployment to OPA_PROXY_MODE=enforce, verifies that a request without guardrail
headers gets a 403 PolicyViolation response, then restores OPA_PROXY_MODE=track.

Requires kubectl access to the demo cluster (kind-agentspec context).
"""
from __future__ import annotations

import subprocess
import pytest
import httpx

from conftest import _wait_ready

CONTEXT = "kind-agentspec"
NAMESPACE = "demo"
SIDECAR_DEPLOYMENT = "fitness-tracker-sidecar"
PROXY_PORT = 4006
CONTROL_PORT = 4007


def _kubectl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    cmd = ["kubectl", "--context", CONTEXT, *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def _set_env(var: str, value: str) -> None:
    _kubectl(
        "set", "env",
        "-n", NAMESPACE,
        f"deployment/{SIDECAR_DEPLOYMENT}",
        f"{var}={value}",
    )


def _wait_rollout(deployment: str = SIDECAR_DEPLOYMENT, timeout: str = "90s") -> None:
    _kubectl(
        "rollout", "status",
        "-n", NAMESPACE,
        f"deployment/{deployment}",
        f"--timeout={timeout}",
    )


@pytest.fixture(autouse=False)
def enforce_mode(port_forward):
    """Patch fitness-tracker sidecar to enforce mode, restore on teardown."""
    # Bring up port-forwards first (they stay alive across the set-env/rollout)
    proxy_url, control_url = port_forward("fitness-tracker", PROXY_PORT, CONTROL_PORT)

    _set_env("OPA_PROXY_MODE", "enforce")
    _wait_rollout()

    # Wait until the sidecar is responding again after rollout
    _wait_ready(f"http://localhost:{CONTROL_PORT}/health/live", timeout=60)

    yield proxy_url, control_url

    # ── Restore track mode ────────────────────────────────────────────────────
    _set_env("OPA_PROXY_MODE", "track")
    _wait_rollout()


def test_opa_enforce_blocks_request_without_guardrail_headers(enforce_mode):
    """A /chat request with no guardrail headers must be blocked (403) in enforce mode."""
    proxy_url, _ = enforce_mode

    r = httpx.post(
        f"{proxy_url}/chat",
        json={"message": "test"},
        timeout=10,
    )

    assert r.status_code == 403, (
        f"Expected 403 from OPA enforce mode, got {r.status_code}: {r.text}"
    )
    body = r.json()
    assert body.get("error") == "PolicyViolation", (
        f"Expected error='PolicyViolation', got: {body}"
    )
    violations = body.get("violations", [])
    assert len(violations) > 0, (
        f"Expected at least one violation in the response body, got: {body}"
    )


def test_opa_enforce_allows_request_with_guardrail_headers(enforce_mode):
    """A /chat request WITH required guardrail headers must pass through (not 403)."""
    proxy_url, _ = enforce_mode

    r = httpx.post(
        f"{proxy_url}/chat",
        json={"message": "test"},
        headers={
            "x-agentspec-guardrails-invoked": "pii_scrubber,content_filter",
        },
        timeout=10,
    )

    # Any non-403 status is acceptable (the upstream agent may return 200, 500, etc.)
    assert r.status_code != 403, (
        f"Request with guardrail headers must NOT be blocked by OPA, got 403: {r.text}"
    )


def test_opa_track_mode_passes_all_requests(port_forward):
    """In default track mode, /chat without guardrail headers must NOT return 403."""
    proxy_url, _ = port_forward("fitness-tracker", PROXY_PORT, CONTROL_PORT)

    r = httpx.post(
        f"{proxy_url}/chat",
        json={"message": "hello"},
        timeout=10,
    )

    assert r.status_code != 403, (
        f"track mode must not block requests, got 403: {r.text}"
    )
