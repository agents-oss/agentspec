"""
Pydantic models matching the AgentSpec TypeScript SDK HealthReport shape.
"""

from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel


class HealthCheck(BaseModel):
    id: str
    category: str
    status: Literal["pass", "fail", "warn", "skip"]
    severity: Literal["error", "warning", "info"]
    latency_ms: Optional[int] = None
    message: Optional[str] = None


class HealthReport(BaseModel):
    agent_name: str
    timestamp: str
    status: Literal["healthy", "degraded", "unhealthy"]
    summary: Dict[str, int]
    checks: List[HealthCheck]
