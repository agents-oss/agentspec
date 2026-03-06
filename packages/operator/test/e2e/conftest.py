"""
conftest.py — Minimal CI fixtures for the operator K8s E2E suite.

Assumes the gymcoach deployment is already running in the 'demo' namespace
(applied by the e2e-k8s.yml workflow before pytest runs).

Provides:
  - namespace: the Kubernetes namespace where gymcoach is deployed
  - gymcoach_urls: (proxy_url, control_url) via kubectl port-forward
"""
from __future__ import annotations

import subprocess
import time

import httpx
import pytest

_PROXY_LOCAL_PORT = 14000
_CONTROL_LOCAL_PORT = 14001


@pytest.fixture(scope="session")
def namespace() -> str:
    return "demo"


@pytest.fixture(scope="session")
def gymcoach_urls(namespace: str):
    """Port-forward gymcoach proxy (4000) and control (4001) for the test session."""
    procs: list[subprocess.Popen] = []

    for local, remote in [(_PROXY_LOCAL_PORT, 4000), (_CONTROL_LOCAL_PORT, 4001)]:
        p = subprocess.Popen(
            [
                "kubectl", "port-forward",
                "-n", namespace,
                "deployment/gymcoach",
                f"{local}:{remote}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        procs.append(p)

    _wait_ready(f"http://localhost:{_CONTROL_LOCAL_PORT}/health/live")

    yield (
        f"http://localhost:{_PROXY_LOCAL_PORT}",
        f"http://localhost:{_CONTROL_LOCAL_PORT}",
    )

    for p in procs:
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


def _wait_ready(url: str, timeout: int = 30) -> None:
    """Poll url until it returns a non-5xx status (or raises TimeoutError)."""
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
        f"Not ready at {url} after {timeout}s"
        + (f": {last_exc}" if last_exc else "")
    )
