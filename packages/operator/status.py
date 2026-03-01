"""
Status patch builder: translates a ProbeResult into a Kubernetes status object
suitable for patching .status on an AgentObservation resource.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from models import HealthCheck, ProbeResult, ReadyReport, GapReport


def score_to_grade(score: int) -> str:
    """
    Map 0-100 compliance score to A-F letter grade.

    Aligned with the SDK grading scale defined in CLAUDE.md:
      A >= 90, B >= 75, C >= 60, D >= 45, F < 45
    """
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    if score >= 60:
        return "C"
    if score >= 45:
        return "D"
    return "F"


def build_status_patch(result: ProbeResult) -> dict:
    """
    Translate a ProbeResult into a dict suitable for patch.status.update().

    Maps:
      health.status  → phase  (Healthy / Degraded / Unhealthy / Unknown)
      gap.score      → grade + score
      gap.issues     → violations count
      health.source  → source
      gap.modelId    → model.id (always populated from manifest)
      model check    → model.status + model.latencyMs
      conditions[]   → Ready | Compliant | ModelReachable
    """
    h: ReadyReport = result.health
    g: GapReport = result.gap

    phase = _health_to_phase(h.health_status)

    model_check = next(
        (c for c in h.checks if c.category == "model"), None
    )

    summary_dict = h.summary.model_dump()

    return {
        "phase": phase,
        "grade": score_to_grade(g.score),
        "score": g.score,
        "source": h.source,
        "lastChecked": h.timestamp or _now_iso(),
        "violations": len(g.issues),
        "model": _model_status(model_check, g.modelId),
        "summary": summary_dict,
        "conditions": _build_conditions(h, g),
    }


# ── Internal helpers ──────────────────────────────────────────────────────────

def _health_to_phase(health_status: str) -> str:
    return {
        "healthy": "Healthy",
        "degraded": "Degraded",
        "unhealthy": "Unhealthy",
    }.get(health_status, "Unknown")


def _model_status(model_check: Optional[HealthCheck], gap_model_id: str = "unknown") -> dict:
    if model_check is None:
        # No live model check — use the model ID from the gap report (from manifest)
        return {"status": "unknown", "id": gap_model_id}
    # check.id is "model:<provider>/<model-id>" — strip the "model:" prefix
    model_id = model_check.id.removeprefix("model:") if model_check.id.startswith("model:") else model_check.id
    result = {"status": model_check.status, "id": model_id}
    if model_check.latencyMs is not None:
        result["latencyMs"] = model_check.latencyMs
    return result


def _build_conditions(h: ReadyReport, g: GapReport) -> list[dict]:
    t = _now_iso()
    is_healthy = h.health_status == "healthy"
    is_compliant = len(g.issues) == 0

    model_check = next((c for c in h.checks if c.category == "model"), None)

    return [
        {
            "type": "Ready",
            "status": "True" if is_healthy else "False",
            "reason": "AllChecksPassed" if is_healthy else "ChecksFailed",
            "message": "" if is_healthy else f"Agent status: {h.status}",
            "lastTransitionTime": t,
        },
        {
            "type": "Compliant",
            "status": "True" if is_compliant else "False",
            "reason": "NoViolations" if is_compliant else "ViolationsDetected",
            "message": "" if is_compliant else f"{len(g.issues)} violation(s) detected",
            "lastTransitionTime": t,
        },
        {
            "type": "ModelReachable",
            "status": _model_reachable_status(model_check),
            "reason": "ModelCheck",
            "message": _model_reachable_message(model_check),
            "lastTransitionTime": t,
        },
    ]


def _model_reachable_status(model_check: Optional[HealthCheck]) -> str:
    if model_check is None:
        return "Unknown"
    if model_check.status == "pass":
        return "True"
    if model_check.status == "fail":
        return "False"
    return "Unknown"  # warn / skip


def _model_reachable_message(model_check: Optional[HealthCheck]) -> str:
    if model_check is None:
        return "No model check in health report"
    if model_check.message:
        return model_check.message
    return ""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
