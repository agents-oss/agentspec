"""
conftest.py — E2E test infrastructure for the AgentSpec demo cluster.

Provides:
  - demo_cluster (session): idempotent cluster bring-up
  - port_forward (function): kubectl port-forward per agent, cleaned up after each test
  - load_scenarios(): returns pytest.param list from scenarios/*.yaml
"""
from __future__ import annotations

import subprocess
import time
import yaml
import pytest
import httpx
from pathlib import Path

SCENARIOS_DIR = Path(__file__).parent / "scenarios"

# Agents that must be ready before tests run
_DEMO_AGENTS = ["gymcoach", "trading-bot", "voice-assistant", "fitness-tracker", "research-agent"]

# ── Cluster fixture (session-scoped, idempotent) ────────────────────────────

def _agents_already_ready() -> bool:
    """Return True if all demo-namespace deployments are already available."""
    try:
        r = subprocess.run(
            [
                "kubectl", "get", "deployments", "-n", "demo",
                "--context", "kind-agentspec",
                "-o", "jsonpath={range .items[*]}{.metadata.name}={.status.availableReplicas},{end}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode != 0:
            return False
        ready = {kv.split("=")[0]: kv.split("=")[1] for kv in r.stdout.rstrip(",").split(",") if "=" in kv}
        return all(ready.get(a, "0") == "1" for a in _DEMO_AGENTS)
    except Exception:
        return False


@pytest.fixture(scope="session", autouse=True)
def demo_cluster():
    """Ensure demo cluster is running.

    Fast path: if all 5 agent deployments already have availableReplicas=1, skips
    'make demo-cluster demo-operator demo-deploy' entirely (avoids expensive
    'kind load docker-image' when the cluster is already healthy).

    Cold start: runs the full make chain to bring up the cluster from scratch.
    Cluster is NOT torn down after the suite — run 'make demo-down' manually.
    """
    if _agents_already_ready():
        yield
        return

    root = Path(__file__).parents[4]  # packages/operator/uat/e2e → repo root
    result = subprocess.run(
        ["make", "demo-provision"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.fail(
            f"Failed to bring up demo cluster:\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        )
    yield
    # No teardown — cluster stays up between runs for faster iteration.
    # Run `make demo-down` manually to tear down.


# ── Port-forward fixture (function-scoped) ──────────────────────────────────

@pytest.fixture
def port_forward(demo_cluster):
    """Start kubectl port-forward for one agent.

    Usage inside a test::

        def test_foo(port_forward):
            proxy_url, control_url = port_forward("gymcoach", 4000, 4001)
            r = httpx.get(f"{control_url}/agentspec/health")

    Yields a callable.  Forwards are cleaned up when the test ends.
    """
    procs: list[subprocess.Popen] = []

    def _forward(agent: str, proxy_port: int, control_port: int):
        for local_port, remote_port in [(proxy_port, 4000), (control_port, 4001)]:
            p = subprocess.Popen(
                [
                    "kubectl", "port-forward",
                    "-n", "demo",
                    f"deployment/{agent}",
                    f"{local_port}:{remote_port}",
                    "--context", "kind-agentspec",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            procs.append(p)

        _wait_ready(f"http://localhost:{control_port}/health/live")
        return (
            f"http://localhost:{proxy_port}",
            f"http://localhost:{control_port}",
        )

    yield _forward

    for p in procs:
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


# ── Readiness helper ─────────────────────────────────────────────────────────

def _wait_ready(url: str, timeout: int = 30) -> None:
    """Poll url until it responds with a non-5xx status (or timeout)."""
    deadline = time.time() + timeout
    last_exc: Exception | None = None
    while time.time() < deadline:
        try:
            r = httpx.get(url, timeout=2)
            if r.status_code < 500:
                return
        except Exception as exc:
            last_exc = exc
        time.sleep(1)
    raise TimeoutError(
        f"Agent not ready at {url} after {timeout}s"
        + (f": {last_exc}" if last_exc else "")
    )


# ── YAML scenario loader for pytest parametrize ──────────────────────────────

def load_scenarios() -> list:
    """Return a list of pytest.param objects — one per scenario YAML file."""
    scenarios = []
    for f in sorted(SCENARIOS_DIR.glob("*.yaml")):
        data = yaml.safe_load(f.read_text())
        scenarios.append(pytest.param(data, id=f.stem))
    return scenarios
