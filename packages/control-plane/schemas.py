"""
Pydantic request/response models for the AgentSpec control plane API.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field

# k8s resource name pattern: lowercase alphanumeric and hyphens,
# must start and end with alphanumeric, max 63 chars (RFC 1123 DNS label).
_K8S_NAME_PATTERN = r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"


# ── Register ───────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    agentName: str = Field(
        ...,
        min_length=1,
        max_length=63,
        pattern=_K8S_NAME_PATTERN,
        description="Must be a valid Kubernetes resource name (lowercase, hyphens, ≤63 chars).",
    )
    runtime: str = Field(..., pattern=r"^(bedrock|vertex|docker|local|k8s)$")
    manifest: Optional[dict[str, Any]] = None


class RegisterResponse(BaseModel):
    agentId: str
    apiKey: str
    expiresAt: Optional[datetime] = None


# ── Heartbeat ─────────────────────────────────────────────────────────────────

class HeartbeatRequest(BaseModel):
    health: dict[str, Any]
    gap: dict[str, Any]


# ── Stored health report (GET /agents/{name}/health response) ─────────────────

class StoredHealthReport(BaseModel):
    """Schema for the health report stored in heartbeat rows.

    Pydantic v2 ignores unknown fields by default (extra='ignore'),
    so model_dump() strips any fields not declared here — preventing
    raw DB dict passthrough of unexpected or sensitive data.
    """

    status: str
    agentName: str
    timestamp: str
    source: str
    summary: dict[str, Any]
    checks: list[dict[str, Any]]


# ── Agent summary (list endpoint) ─────────────────────────────────────────────

class AgentSummary(BaseModel):
    agentId: str
    agentName: str
    runtime: str
    phase: str
    grade: str
    score: int
    lastSeen: Optional[datetime]
