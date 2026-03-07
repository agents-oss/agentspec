"""
AgentSpec MutatingWebhook — pure business logic.

The HTTP admission layer is handled by kopf's native WebhookServer (port 9443),
configured in operator.py's startup() hook. This module provides the pure
functions consumed by the @kopf.on.admission() handler.

Pure functions (unit-testable, no I/O):
  should_inject()          — annotation / default injection gate
  is_sidecar_present()     — idempotency guard
  build_sidecar_patch()    — construct JSON Patch operations
  get_cr_name()            — AgentObservation CR naming
  build_admission_response() — AdmissionReview response envelope

k8s side-effect:
  _create_agent_observation() — creates AgentObservation CR (requires cluster)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("agentspec.webhook")

# ── Annotation keys ───────────────────────────────────────────────────────────

_INJECT_KEY = "agentspec.io/inject"
_AGENT_NAME_KEY = "agentspec.io/agent-name"
_CONFIGMAP_KEY = "agentspec.io/manifest-configmap"
_CHECK_INTERVAL_KEY = "agentspec.io/check-interval"
# Per-pod OPA proxy mode override: agentspec.io/opa-proxy-mode: enforce
_OPA_PROXY_MODE_KEY = "agentspec.io/opa-proxy-mode"

# ── Sidecar image ─────────────────────────────────────────────────────────────

_SIDECAR_IMAGE = os.getenv(
    "AGENTSPEC_SIDECAR_IMAGE",
    "ghcr.io/agentspec/sidecar:latest",
)

_DEFAULT_CONFIGMAP = "agentspec-manifest"

# check-interval boundaries — must align with CRD schema (minimum: 5, max: 3600)
_CHECK_INTERVAL_MIN = 5
_CHECK_INTERVAL_DEFAULT = 30

# ── Operator-level configuration (set via Helm values → env vars) ─────────────

# Injection trigger mode:
#   "annotation" — only inject pods with agentspec.io/inject: "true" (default)
#   "default"    — inject all pods; opt-out with agentspec.io/inject: "false"
_INJECT_MODE: str = os.getenv("AGENTSPEC_INJECT_MODE", "annotation")

# Namespaces excluded from injection even in "default" mode.
# Comma-separated. Checked by the webhook handler as a defence-in-depth layer
# on top of the MutatingWebhookConfiguration's namespaceSelector.
_EXCLUDED_NAMESPACES: frozenset[str] = frozenset(
    ns.strip()
    for ns in os.getenv(
        "AGENTSPEC_EXCLUDED_NAMESPACES",
        "kube-system,kube-public,kube-node-lease",
    ).split(",")
    if ns.strip()
)

# OPA injection — injects an OPA container alongside the sidecar when enabled.
_OPA_ENABLED: bool = os.getenv("AGENTSPEC_OPA_ENABLED", "false").lower() == "true"
_OPA_IMAGE: str = os.getenv("AGENTSPEC_OPA_IMAGE", "openpolicyagent/opa:0.70.0-static")
# Default per-request proxy mode for all injected pods: "track" | "enforce" | "off"
_OPA_PROXY_MODE: str = os.getenv("AGENTSPEC_OPA_PROXY_MODE", "track")
# Suffix used to derive the OPA policy ConfigMap name: "{agent-name}-{suffix}"
_OPA_POLICY_CONFIGMAP_SUFFIX: str = os.getenv(
    "AGENTSPEC_OPA_POLICY_CONFIGMAP_SUFFIX", "opa-policy"
)


# ── Pure business logic (unit-testable, no I/O) ───────────────────────────────

def should_inject(
    annotations: dict[str, str],
    inject_mode: str = _INJECT_MODE,
) -> bool:
    """
    Return True when this pod should receive sidecar injection.

    annotation mode (default, safe):
        Only inject when agentspec.io/inject == "true" (explicit opt-in).
        All other pods — including those with no annotation — are left untouched.

    default mode:
        Inject unless agentspec.io/inject == "false" (explicit opt-out).
        Use this for full-namespace coverage without annotating every Deployment.
        Requires excludedNamespaces and namespaceSelector to be correctly set.
    """
    inject_val = annotations.get(_INJECT_KEY)
    if inject_mode == "default":
        return inject_val != "false"
    return inject_val == "true"


def is_sidecar_present(pod_spec: dict) -> bool:
    """Return True if an 'agentspec-sidecar' container already exists in the pod."""
    containers = pod_spec.get("containers") or []
    return any(c.get("name") == "agentspec-sidecar" for c in containers)


def build_sidecar_patch(
    pod_spec: dict,
    annotations: dict[str, str],
    inject_mode: str = _INJECT_MODE,
    opa_enabled: bool = _OPA_ENABLED,
    opa_image: str = _OPA_IMAGE,
    opa_proxy_mode: str = _OPA_PROXY_MODE,
    opa_policy_configmap_suffix: str = _OPA_POLICY_CONFIGMAP_SUFFIX,
) -> list[dict[str, Any]]:
    """
    Build the JSON Patch operations to inject the agentspec-sidecar container
    (and optionally an OPA enforcement sidecar) into a pod.

    Returns an empty list when:
    - should_inject() returns False (based on inject_mode + annotations)
    - The sidecar is already present (idempotent guard)

    When opa_enabled is True, additionally injects:
    - agentspec-opa container (OPA server on port 8181)
    - agentspec-opa-policy volume (ConfigMap: "{agent-name}-{suffix}")
    - OPA_URL + OPA_PROXY_MODE env vars on the sidecar

    Per-pod mode override via annotation:
      agentspec.io/opa-proxy-mode: enforce  (overrides the global proxyMode)

    Does NOT contact k8s — pure function.
    """
    if not should_inject(annotations, inject_mode):
        return []

    if is_sidecar_present(pod_spec):
        return []

    configmap_name = annotations.get(_CONFIGMAP_KEY) or _DEFAULT_CONFIGMAP
    check_interval = annotations.get(_CHECK_INTERVAL_KEY, "")
    agent_name = annotations.get(_AGENT_NAME_KEY, "").strip()

    # Resolve effective OPA proxy mode: annotation overrides global default
    effective_opa_mode = annotations.get(_OPA_PROXY_MODE_KEY) or opa_proxy_mode

    # ── Sidecar container ──────────────────────────────────────────────────
    sidecar_env: list[dict] = [
        {"name": "AGENTSPEC_MANIFEST_PATH", "value": "/app/agent.yaml"},
    ]
    if check_interval:
        sidecar_env.append({"name": "AGENTSPEC_CHECK_INTERVAL", "value": check_interval})
    if opa_enabled:
        sidecar_env.append({"name": "OPA_URL", "value": "http://localhost:8181"})
        sidecar_env.append({"name": "OPA_PROXY_MODE", "value": effective_opa_mode})

    sidecar: dict[str, Any] = {
        "name": "agentspec-sidecar",
        "image": _SIDECAR_IMAGE,
        "ports": [
            {"containerPort": 4000},
            {"containerPort": 4001},
        ],
        "env": sidecar_env,
        "volumeMounts": [
            {
                "name": "agent-yaml",
                "mountPath": "/app/agent.yaml",
                "subPath": "agent.yaml",
            }
        ],
    }

    # Track whether the pod already has a volumes list so we create vs. append
    has_volumes = pod_spec.get("volumes") is not None

    def _volume_op(volume_spec: dict[str, Any]) -> dict[str, Any]:
        """Append to existing volumes list or create it on first call."""
        nonlocal has_volumes
        if has_volumes:
            path = "/spec/volumes/-"
        else:
            path = "/spec/volumes"
            has_volumes = True
        return {"op": "add", "path": path, "value": volume_spec}

    ops: list[dict[str, Any]] = [
        {"op": "add", "path": "/spec/containers/-", "value": sidecar},
        _volume_op({"name": "agent-yaml", "configMap": {"name": configmap_name}}),
    ]

    # ── OPA container (optional) ───────────────────────────────────────────
    if opa_enabled:
        policy_cm_name = f"{agent_name or 'agent'}-{opa_policy_configmap_suffix}"
        opa_container: dict[str, Any] = {
            "name": "agentspec-opa",
            "image": opa_image,
            "args": [
                "run",
                "--server",
                "--addr=:8181",
                "--log-level=error",
                "/policies/policy.rego",
                "/policies/data.json",
            ],
            "ports": [{"containerPort": 8181}],
            "volumeMounts": [
                {
                    "name": "agentspec-opa-policy",
                    "mountPath": "/policies",
                    "readOnly": True,
                }
            ],
            "securityContext": {
                "allowPrivilegeEscalation": False,
                "readOnlyRootFilesystem": True,
                "runAsNonRoot": True,
                "runAsUser": 1000,
                "capabilities": {"drop": ["ALL"]},
            },
            "resources": {
                "requests": {"cpu": "25m", "memory": "64Mi"},
                "limits": {"cpu": "100m", "memory": "128Mi"},
            },
        }
        ops.append({"op": "add", "path": "/spec/containers/-", "value": opa_container})
        ops.append(_volume_op({
            "name": "agentspec-opa-policy",
            "configMap": {"name": policy_cm_name},
        }))

    return ops


def get_cr_name(annotations: dict[str, str], pod_name: str) -> str:
    """
    Determine the AgentObservation CR name.

    Uses agentspec.io/agent-name annotation if set and non-empty,
    otherwise falls back to the pod name.
    """
    name = annotations.get(_AGENT_NAME_KEY, "").strip()
    return name if name else pod_name


def build_admission_response(uid: str, patch_ops: list[dict]) -> dict:
    """
    Build a complete AdmissionReview response envelope.

    - allowed is always True (sidecar injection is best-effort; failurePolicy:
      Ignore on the webhook means a non-200 would also be benign, but returning
      allowed:true is cleaner)
    - patch / patchType are omitted entirely when patch_ops is empty
      (sending null values causes validation warnings in some k8s versions)
    """
    response: dict[str, Any] = {
        "uid": uid,
        "allowed": True,
    }

    if patch_ops:
        encoded = base64.b64encode(json.dumps(patch_ops).encode()).decode()
        response["patch"] = encoded
        response["patchType"] = "JSONPatch"

    return {
        "apiVersion": "admission.k8s.io/v1",
        "kind": "AdmissionReview",
        "response": response,
    }


# ── k8s CR creation (requires cluster) ───────────────────────────────────────

async def _create_agent_observation(
    name: str,
    namespace: str,
    pod_uid: str,
    pod_name: str,
    check_interval: int,
    api_client,
) -> None:
    """
    Create an AgentObservation CR in the same namespace as the pod.

    Owner reference is set only when pod_uid is non-empty (it is empty on
    Pod CREATE before the API server assigns a UID). Without an ownerReference
    the CR persists until the pod label/annotation-based GC deletes it.

    This function is intentionally not unit-tested (requires a live k8s API).
    Integration tests verify this path.
    """
    from kubernetes_asyncio import client as k8s_client

    custom = k8s_client.CustomObjectsApi(api_client)

    now = datetime.now(timezone.utc).isoformat()
    metadata: dict[str, Any] = {
        "name": name,
        "namespace": namespace,
        "annotations": {
            "agentspec.io/injected-by": "webhook",
            "agentspec.io/injected-at": now,
        },
    }

    # ownerReference is only valid when the pod already has a UID (i.e. it was
    # admitted via UPDATE rather than CREATE, or the pod name is deterministic).
    if pod_uid:
        metadata["ownerReferences"] = [
            {
                "apiVersion": "v1",
                "kind": "Pod",
                "name": pod_name,
                "uid": pod_uid,
                "blockOwnerDeletion": True,
                "controller": True,
            }
        ]

    body = {
        "apiVersion": "agentspec.io/v1",
        "kind": "AgentObservation",
        "metadata": metadata,
        "spec": {"checkInterval": check_interval},
    }

    try:
        await custom.create_namespaced_custom_object(
            group="agentspec.io",
            version="v1",
            namespace=namespace,
            plural="agentobservations",
            body=body,
        )
        logger.info(f"[webhook] created AgentObservation {name!r} in {namespace!r}")
    except Exception as exc:
        # 409 Conflict = CR already exists (idempotent re-inject scenario)
        if hasattr(exc, "status") and exc.status == 409:
            logger.debug(f"[webhook] AgentObservation {name!r} already exists — skipping create")
        else:
            logger.error(f"[webhook] failed to create AgentObservation {name!r}: {exc}")


