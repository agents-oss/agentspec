"""
Pydantic v2 models mirroring the TypeScript types from:
  - packages/sdk/src/health/index.ts  (HealthReport, HealthCheck)
  - packages/sidecar/src/control-plane/gap.ts  (GapReport, GapIssue)
  - packages/sidecar/src/control-plane/health.ts  (ReadyReport — /health/ready response)

These are the exact shapes returned by the agentspec-sidecar control plane (port 4001).
"""

from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field


# ── HealthCheck ───────────────────────────────────────────────────────────────

CheckStatus = Literal["pass", "fail", "warn", "skip"]
CheckSeverity = Literal["error", "warning", "info"]
CheckCategory = Literal[
    "env", "file", "model", "model-fallback", "mcp",
    "memory", "subagent", "eval", "service", "tool"
]


class HealthCheck(BaseModel):
    """Single health check result from the sidecar or SDK reporter."""
    id: str
    category: CheckCategory
    status: CheckStatus
    severity: CheckSeverity
    latencyMs: Optional[int] = None
    message: Optional[str] = None
    remediation: Optional[str] = None


# ── HealthSummary ─────────────────────────────────────────────────────────────

class HealthSummary(BaseModel):
    passed: int = 0
    failed: int = 0
    warnings: int = 0
    skipped: int = 0


# ── ReadyReport (/health/ready) ───────────────────────────────────────────────
# Note: /health/ready maps HealthStatus to a slightly different status string:
#   healthy   → "ready"
#   degraded  → "degraded"
#   unhealthy → "unavailable"
# The 'source' field indicates whether live SDK data was used.

HealthReadyStatus = Literal["ready", "degraded", "unavailable"]
DataSource = Literal["agent-sdk", "manifest-static"]


class ReadyReport(BaseModel):
    """Response shape from GET /health/ready on the agentspec-sidecar."""
    status: HealthReadyStatus
    source: DataSource
    agentName: str
    timestamp: str
    summary: HealthSummary = Field(default_factory=HealthSummary)
    checks: list[HealthCheck] = Field(default_factory=list)
    error: Optional[str] = None  # present when status=unavailable

    @property
    def health_status(self) -> str:
        """Translate ready status back to canonical health status for phase mapping."""
        return {
            "ready": "healthy",
            "degraded": "degraded",
            "unavailable": "unhealthy",
        }.get(self.status, "unknown")


# ── GapIssue ──────────────────────────────────────────────────────────────────

GapSeverity = Literal["critical", "high", "medium", "low"]


class GapIssue(BaseModel):
    severity: GapSeverity
    property: str
    description: str
    recommendation: str


# ── GapObserved ───────────────────────────────────────────────────────────────

class GapObserved(BaseModel):
    hasHealthEndpoint: bool = False
    hasCapabilitiesEndpoint: bool = False
    upstreamTools: list[str] = Field(default_factory=list)


# ── GapReport (/gap) ──────────────────────────────────────────────────────────

class GapReport(BaseModel):
    """Response shape from GET /gap on the agentspec-sidecar."""
    score: int = Field(ge=0, le=100)
    issues: list[GapIssue] = Field(default_factory=list)
    source: DataSource
    modelId: str = "unknown"
    observed: GapObserved = Field(default_factory=GapObserved)


# ── ProbeResult (combined) ────────────────────────────────────────────────────

class ProbeResult(BaseModel):
    """Combined result from probing both /health/ready and /gap."""
    health: ReadyReport
    gap: GapReport
