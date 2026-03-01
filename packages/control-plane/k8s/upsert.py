"""
Upsert AgentObservation CRs in the agentspec-remote namespace.

HIGH-5 fix: catches kubernetes_asyncio.client.exceptions.ApiException specifically
instead of bare Exception, to avoid masking programming errors.
"""
from __future__ import annotations

import logging
from typing import Any

from kubernetes_asyncio.client.exceptions import ApiException

logger = logging.getLogger(__name__)

GROUP = "agentspec.io"
VERSION = "v1"
PLURAL = "agentobservations"
NAMESPACE = "agentspec-remote"


def build_status_patch(health: dict[str, Any], gap: dict[str, Any]) -> dict[str, Any]:
    """
    Derive AgentObservation .status from heartbeat data.

    Phase mapping:  ready→Healthy, degraded→Degraded, unavailable→Unhealthy
    Grade mapping:  A≥90, B≥75, C≥60, D≥45, F<45
    """
    status_to_phase = {
        "ready": "Healthy",
        "degraded": "Degraded",
        "unavailable": "Unhealthy",
    }
    try:
        score = int(gap.get("score", 0))
    except (ValueError, TypeError):
        score = 0
    score = max(0, min(score, 100))  # clamp to valid range
    phase = status_to_phase.get(health.get("status", ""), "Unknown")

    if score >= 90:
        grade = "A"
    elif score >= 75:
        grade = "B"
    elif score >= 60:
        grade = "C"
    elif score >= 45:
        grade = "D"
    else:
        grade = "F"

    return {
        "phase": phase,
        "grade": grade,
        "score": score,
        "health": health,
        "gap": gap,
    }


async def upsert_agent_observation(
    agent_name: str,
    status_patch: dict[str, Any],
    *,
    _client: Any = None,
) -> None:
    """
    Upsert AgentObservation CR in agentspec-remote namespace.

    Create if missing (404), patch-status if it already exists.
    Propagates non-404 ApiException to the caller.
    """
    if _client is None:
        from kubernetes_asyncio import client as k8s_client, config as k8s_config  # noqa: PLC0415

        try:
            k8s_config.load_incluster_config()
        except Exception:
            await k8s_config.load_kube_config()
        _client = k8s_client.CustomObjectsApi()

    body: dict[str, Any] = {
        "apiVersion": f"{GROUP}/{VERSION}",
        "kind": "AgentObservation",
        "metadata": {"name": agent_name, "namespace": NAMESPACE},
        "spec": {"source": "control-plane"},
        "status": status_patch,
    }

    try:
        await _client.get_namespaced_custom_object(
            group=GROUP,
            version=VERSION,
            namespace=NAMESPACE,
            plural=PLURAL,
            name=agent_name,
        )
        # CR exists → patch only the status sub-resource
        await _client.patch_namespaced_custom_object_status(
            group=GROUP,
            version=VERSION,
            namespace=NAMESPACE,
            plural=PLURAL,
            name=agent_name,
            body={"status": status_patch},
        )
        logger.debug("Patched AgentObservation '%s'", agent_name)
    except ApiException as exc:
        if exc.status == 404:
            await _client.create_namespaced_custom_object(
                group=GROUP,
                version=VERSION,
                namespace=NAMESPACE,
                plural=PLURAL,
                body=body,
            )
            logger.info("Created AgentObservation '%s'", agent_name)
        else:
            logger.error(
                "k8s API error upserting AgentObservation '%s': %s", agent_name, exc
            )
            raise
