"""
Async HTTP prober for the agentspec-sidecar control plane.

Probes two endpoints in parallel:
  GET {base_url}/health/ready  →  ReadyReport
  GET {base_url}/gap           →  GapReport

Both are already implemented in the sidecar (port 4001).
"""

from __future__ import annotations

import asyncio  # HIGH-2: top-level import, not inside function body
import atexit

import httpx

from models import GapReport, GapObserved, HealthSummary, ProbeResult, ReadyReport

# HIGH-5: module-level client — connection pool shared across all probe calls.
# Limits: max 20 keepalive + 100 total connections (safe for large clusters).
# Closed at process exit via atexit to avoid ResourceWarning in tests.
_CLIENT = httpx.AsyncClient(
    limits=httpx.Limits(max_keepalive_connections=20, max_connections=100),
    timeout=httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0),
)


def _close_client() -> None:
    """Best-effort close on interpreter shutdown (sync wrapper)."""
    import asyncio as _asyncio
    try:
        loop = _asyncio.get_event_loop()
        if not loop.is_closed():
            loop.run_until_complete(_CLIENT.aclose())
    except Exception:
        pass


atexit.register(_close_client)


async def probe_agent(base_url: str, timeout: int = 10) -> ProbeResult:
    """
    Probe the sidecar control plane and return a combined ProbeResult.

    Uses the module-level AsyncClient for connection pooling.

    Args:
        base_url: e.g. 'http://gymcoach-sidecar.default.svc.cluster.local:4001'
        timeout:  Per-request read timeout in seconds (overrides client default).

    Raises:
        httpx.ConnectError:   DNS failure or connection refused — caller classifies
                              this as a configuration error, not a transient failure.
        httpx.HTTPStatusError: non-2xx response from sidecar.
        Exception:            any other network/parse failure — caller should handle.
    """
    health_resp, gap_resp = await _probe_parallel(base_url, timeout=timeout)

    health = ReadyReport.model_validate(health_resp)
    gap = GapReport.model_validate(gap_resp)

    return ProbeResult(health=health, gap=gap)


async def _probe_parallel(base_url: str, timeout: int) -> tuple[dict, dict]:
    """Fire both sidecar requests concurrently using the shared client."""
    per_request = httpx.Timeout(connect=5.0, read=timeout, write=5.0, pool=5.0)

    async def fetch(path: str) -> dict:
        r = await _CLIENT.get(f"{base_url}{path}", timeout=per_request)
        r.raise_for_status()
        return r.json()

    results = await asyncio.gather(
        fetch("/health/ready"),
        fetch("/gap"),
    )
    return results[0], results[1]


def make_unavailable_probe(error: str) -> ProbeResult:
    """
    Synthetic ProbeResult used when the probe itself fails entirely.
    Sets health to unavailable, score to 0, source to manifest-static.
    """
    return ProbeResult(
        health=ReadyReport(
            status="unavailable",
            source="manifest-static",
            agentName="unknown",
            timestamp="",
            summary=HealthSummary(),
            checks=[],
            error=error,
        ),
        gap=GapReport(
            score=0,
            issues=[],
            source="manifest-static",
            observed=GapObserved(),
        ),
    )
