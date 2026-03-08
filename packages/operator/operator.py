"""
AgentSpec Kubernetes Operator — Kopf-based reconcile loop.

Watches AgentObservation CRs and probes the agentspec-sidecar control plane
at the interval specified in spec.checkInterval (default 30s).

Flow:
  1. on_agent_observed  — fires on create/resume, sets Pending status immediately
  2. reconcile_agent_health — daemon (one per CR), probes sidecar /health/ready + /gap,
     patches .status with phase / grade / score / violations / conditions

Using @kopf.daemon (not @kopf.timer) so that each CR's spec.checkInterval is
honoured exactly: the daemon sleeps for `spec.checkInterval` seconds between
probes, waking immediately if the CR is deleted or the operator shuts down.

The operator uses the in-cluster Kubernetes service account to patch status.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timezone

import httpx
import kopf
from kubernetes_asyncio import client as _k8s_client, config as _k8s_config
from kubernetes_asyncio.client import CustomObjectsApi

from prober import make_unavailable_probe, probe_agent
from remote_watcher import RemoteAgentWatcher
from status import build_status_patch

logger = logging.getLogger("agentspec.operator")

_remote_watcher: RemoteAgentWatcher | None = None
_k8s_api_client = None
_k8s_custom_api: CustomObjectsApi | None = None

# RFC-1123 DNS label: lowercase alphanumeric, hyphens allowed in the middle.
# Dots are explicitly rejected — a dotted name would escape the namespace scope
# and enable SSRF against arbitrary cluster-internal (or metadata) services.
_DNS_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?$")

# Ports below 1024 are privileged / well-known.
_PORT_MIN = 1024
_PORT_MAX = 65535

# Ports reserved for agentspec-sidecar internals that must not be used as the
# operator's target port (sidecarPort). Port 4000 is the sidecar proxy — routing
# operator traffic there bypasses the control-plane API. Port 4001 is the correct
# control-plane port (and the default); it is NOT blocked.
_BLOCKED_PORTS: frozenset[int] = frozenset({4000})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sidecar_url(spec: dict, name: str, namespace: str) -> str:
    """
    Build the cluster-DNS base URL for the sidecar control plane.

    Validates both the service name and port before constructing the URL to
    prevent SSRF: a dotted sidecarServiceName would escape the
    .{namespace}.svc.cluster.local suffix and reach arbitrary hosts.

    Raises:
        ValueError: if sidecarServiceName or sidecarPort fails validation.
    """
    raw_svc = spec.get("sidecarServiceName") or f"{name}-sidecar"
    port = int(spec.get("sidecarPort", 4001))

    if not _DNS_LABEL_RE.match(raw_svc):
        raise ValueError(
            f"sidecarServiceName {raw_svc!r} is not a valid DNS label "
            f"(must match [a-z0-9][a-z0-9\\-]{{0,61}}[a-z0-9], no dots)"
        )

    if not (_PORT_MIN <= port <= _PORT_MAX):
        raise ValueError(
            f"sidecarPort {port} is out of the allowed range "
            f"{_PORT_MIN}–{_PORT_MAX}"
        )

    if port in _BLOCKED_PORTS:
        raise ValueError(
            f"sidecarPort {port} conflicts with an agentspec-sidecar internal port "
            f"(proxy=4000). Use 4001 for the control-plane endpoint."
        )

    return f"http://{raw_svc}.{namespace}.svc.cluster.local:{port}"


# ── Lifecycle handlers ────────────────────────────────────────────────────────

@kopf.on.create("agentobservations")
@kopf.on.resume("agentobservations")
async def on_agent_observed(spec, name, namespace, patch, logger, **kwargs):
    """
    Set status to Pending immediately when an AgentObservation is created
    or when the operator restarts and resumes watching existing resources.

    Note: patch.status mutations are buffered locally and sent as a single
    PATCH /status request after this handler returns. If Kubernetes rejects
    the patch (e.g. CRD schema validation failure), Kopf logs the error and
    re-queues for retry — it does not raise inside the handler. The try/except
    here guards against unexpected Python-level errors during data construction.
    """
    try:
        t = _now_iso()
        patch.status["phase"] = "Pending"
        patch.status["lastChecked"] = t
        patch.status["violations"] = 0
        patch.status["conditions"] = [
            {
                "type": "Ready",
                "status": "Unknown",
                "reason": "Initializing",
                "message": "Operator starting first probe",
                "lastTransitionTime": t,
            },
            {
                "type": "Compliant",
                "status": "Unknown",
                "reason": "Initializing",
                "message": "",
                "lastTransitionTime": t,
            },
            {
                "type": "ModelReachable",
                "status": "Unknown",
                "reason": "Initializing",
                "message": "",
                "lastTransitionTime": t,
            },
        ]
        logger.info(f"[{name}] AgentObservation registered — waiting for first probe")
    except Exception as exc:
        logger.error(f"[{name}] failed to build initial status patch: {exc}")
        raise kopf.TemporaryError(str(exc), delay=10) from exc


# ── Per-resource reconciliation daemon ───────────────────────────────────────

@kopf.daemon(
    "agentobservations",
    initial_delay=5.0,          # first probe 5s after CR is created/resumed
    cancellation_timeout=5.0,   # give the daemon 5s to exit cleanly on CR delete
)
async def reconcile_agent_health(spec, name, namespace, logger, patch, stopped, **kwargs):
    """
    Long-running daemon: one instance per AgentObservation CR.

    Probes the sidecar's /health/ready and /gap endpoints, patches .status,
    then sleeps for spec.checkInterval seconds before the next probe.

    Using @kopf.daemon (instead of @kopf.timer) is the only Kopf primitive that
    supports true per-resource dynamic intervals: stopped.wait(interval) sleeps
    for exactly spec.checkInterval seconds but wakes immediately on CR deletion
    or operator shutdown.
    """
    # CRs created by RemoteAgentWatcher have source=control-plane.
    # Their status is managed entirely by the control-plane heartbeat flow —
    # probing a non-existent sidecar would always fail and add noise.
    if spec.get("source") == "control-plane":
        logger.debug(
            "[%s] source=control-plane — skipping sidecar probe, "
            "status managed by heartbeat flow",
            name,
        )
        await stopped.wait(3600)
        return

    # Validate spec once before entering the loop — invalid spec is permanent.
    try:
        base_url = _sidecar_url(spec, name, namespace)
    except ValueError as exc:
        logger.error(
            f"[{name}] invalid spec, daemon will not probe — {exc}. "
            f"Update the AgentObservation CR to fix."
        )
        raise kopf.PermanentError(str(exc)) from exc

    while not stopped:
        interval = max(5, min(int(spec.get("checkInterval", 30)), 3600))
        timeout = min(interval // 2, 20)  # half-interval, max 20s

        logger.debug(f"[{name}] probing {base_url}")

        await _run_probe(name, namespace, base_url, timeout, patch, logger)

        # HIGH-1: sleep for the per-resource interval, not a hardcoded global.
        # stopped.wait() returns True immediately when the daemon is cancelled.
        await stopped.wait(interval)


async def _patch_status_direct(name: str, namespace: str, status: dict, logger) -> None:
    """
    Write status to the Kubernetes API directly via CustomObjectsApi.

    kopf's `patch.status` is only flushed when the handler function returns.
    For @kopf.daemon handlers that loop indefinitely this never happens, so we
    must write status ourselves on every probe iteration.

    Falls back silently when _k8s_custom_api is None (outside-cluster / tests).
    """
    if _k8s_custom_api is None:
        return
    try:
        # CRDs only support merge-patch, not strategic-merge-patch.
        await _k8s_custom_api.patch_namespaced_custom_object_status(
            group="agentspec.io",
            version="v1",
            namespace=namespace,
            plural="agentobservations",
            name=name,
            body={"status": status},
            _content_type="application/merge-patch+json",
        )
    except Exception as exc:
        logger.warning(f"[{name}] direct status patch failed — {exc}")


async def _run_probe(
    name: str,
    namespace: str,
    base_url: str,
    timeout: int,
    patch,
    logger,
) -> None:
    """Execute one probe cycle and write status to the Kubernetes API."""
    try:
        result = await probe_agent(base_url, timeout=timeout)
        status_patch = build_status_patch(result)
        patch.status.update(status_patch)
        await _patch_status_direct(name, namespace, status_patch, logger)

        logger.info(
            f"[{name}] phase={status_patch['phase']} "
            f"grade={status_patch['grade']} "
            f"score={status_patch['score']} "
            f"violations={status_patch['violations']} "
            f"source={status_patch['source']}"
        )

    except httpx.ConnectError as exc:
        # HIGH-4: ConnectError covers both DNS failures (NXDOMAIN / SERVFAIL)
        # and connection refused — both indicate the Service doesn't exist or the
        # sidecar isn't running. Log at ERROR (not warning) so it's visible in
        # dashboards and doesn't look like a transient blip.
        logger.error(
            f"[{name}] sidecar unreachable at {base_url} — "
            f"check that the Service and sidecar container exist: {exc}"
        )
        fallback = make_unavailable_probe(f"ConnectError: {exc}")
        status_patch = build_status_patch(fallback)
        status_patch["phase"] = "Unknown"
        status_patch["lastChecked"] = _now_iso()
        patch.status.update(status_patch)
        await _patch_status_direct(name, namespace, status_patch, logger)

    except Exception as exc:
        # Transient failures (timeouts, 5xx, parse errors) — warn, don't alarm.
        logger.warning(f"[{name}] probe failed (transient?) — {exc}")
        fallback = make_unavailable_probe(str(exc))
        status_patch = build_status_patch(fallback)
        status_patch["phase"] = "Unknown"
        status_patch["lastChecked"] = _now_iso()
        patch.status.update(status_patch)
        await _patch_status_direct(name, namespace, status_patch, logger)


# ── Kopf operator settings ────────────────────────────────────────────────────

@kopf.on.startup()
async def startup(settings: kopf.OperatorSettings, **kwargs):
    """Configure Kopf operator global settings and launch background tasks."""
    global _remote_watcher, _k8s_api_client, _k8s_custom_api

    # Reduce noise: only log warnings from internal kopf machinery
    settings.posting.level = logging.WARNING
    settings.persistence.finalizer = "agentspec.io/operator-finalizer"
    logger.info("AgentSpec operator started")

    # Initialise the Kubernetes API client used for direct status patches inside
    # the daemon while-loop. kopf's `patch.status` is only flushed on handler
    # exit — for a long-running daemon that never exits we must write status
    # directly via the CustomObjectsApi on every probe iteration.
    # NOTE: load_incluster_config() is synchronous in kubernetes_asyncio; do not await it.
    try:
        _k8s_config.load_incluster_config()
        _k8s_api_client = _k8s_client.ApiClient()
        _k8s_custom_api = CustomObjectsApi(_k8s_api_client)
        logger.info("kubernetes_asyncio client initialised (in-cluster)")
    except Exception as exc:
        logger.warning("Could not load in-cluster k8s config (%s) — direct status patches disabled", exc)

    # Webhook: use kopf's native admission server (kopf 1.37+) instead of a
    # separate uvicorn process. Configured when WEBHOOK_ENABLED=true (set by Helm).
    if os.getenv("WEBHOOK_ENABLED", "false").lower() == "true":
        insecure = os.getenv("WEBHOOK_INSECURE_MODE", "false").lower() == "true"
        if insecure:
            settings.admission.server = kopf.WebhookServer(port=9443, host="0.0.0.0", insecure=True)
        else:
            settings.admission.server = kopf.WebhookServer(
                port=9443,
                host="0.0.0.0",
                certfile=os.getenv("WEBHOOK_TLS_CERT_FILE", "/tls/tls.crt"),
                pkeyfile=os.getenv("WEBHOOK_TLS_KEY_FILE", "/tls/tls.key"),
            )
        logger.info("[webhook] kopf native admission server configured on :9443")

    # Phase 6: start RemoteAgentWatcher when control plane is configured.
    # Enabled via CONTROL_PLANE_URL + CONTROL_PLANE_KEY env vars
    # (set by Helm when controlPlane.enabled=true).
    cp_url = os.getenv("CONTROL_PLANE_URL")
    cp_key = os.getenv("CONTROL_PLANE_KEY")
    if cp_url and cp_key:
        raw_interval = os.getenv("CONTROL_PLANE_POLL_INTERVAL", "30")
        try:
            poll_interval = int(raw_interval)
        except ValueError:
            logger.error(
                "CONTROL_PLANE_POLL_INTERVAL=%r is not a valid integer — defaulting to 30",
                raw_interval,
            )
            poll_interval = 30
        # RemoteAgentWatcher.__init__ also clamps, but be explicit here too
        poll_interval = max(5, min(poll_interval, 3600))
        _remote_watcher = RemoteAgentWatcher(
            control_plane_url=cp_url,
            api_key=cp_key,
            poll_interval=poll_interval,
        )
        await _remote_watcher.start()
        logger.info("RemoteAgentWatcher started → %s", cp_url)
    else:
        logger.info(
            "RemoteAgentWatcher disabled (CONTROL_PLANE_URL or CONTROL_PLANE_KEY not set)"
        )


def _apply_patch_ops(kopf_patch, spec: dict, ops: list[dict]) -> None:
    """
    Translate JSON Patch `add` ops from build_sidecar_patch() into dict
    assignments on kopf's Patch object.

    kopf converts Patch dict mutations to JSON Patch via as_json_patch(), which
    uses `replace` for existing paths and `add` for new paths. Assigning the
    full merged list achieves the same result as appending with `/containers/-`.
    """
    containers = list(spec.get("containers") or [])
    volumes = list(spec.get("volumes") or [])
    for op in ops:
        path = op["path"]
        if path == "/spec/containers/-":
            containers.append(op["value"])
        elif path == "/spec/volumes":
            volumes = [op["value"]]  # first volume: creates the array
        elif path == "/spec/volumes/-":
            volumes.append(op["value"])
    spec_patch = kopf_patch.setdefault("spec", {})
    spec_patch["containers"] = containers
    if volumes:
        spec_patch["volumes"] = volumes


@kopf.on.mutate("", "v1", "Pod", operations={"CREATE"})
async def inject_sidecar(body, spec, name, namespace, patch, logger, **kwargs):
    """
    Kopf native mutating admission handler — replaces the custom uvicorn/Starlette server.

    Intercepts Pod CREATE requests from the kube-apiserver and injects the
    agentspec-sidecar container when the pod meets injection criteria.

    Mutations are applied via the `patch` (kopf Patch object); no return value needed.
    """
    from webhook import (
        should_inject, is_sidecar_present, build_sidecar_patch,
        get_cr_name, _create_agent_observation,
        _INJECT_MODE, _EXCLUDED_NAMESPACES,
        _OPA_ENABLED, _OPA_IMAGE, _OPA_PROXY_MODE, _OPA_POLICY_CONFIGMAP_SUFFIX,
        _OPA_PROXY_MODE_KEY,
    )

    annotations = (body.get("metadata") or {}).get("annotations") or {}

    if namespace in _EXCLUDED_NAMESPACES:
        return

    if not should_inject(annotations, _INJECT_MODE):
        return

    if is_sidecar_present(spec):
        return

    opa_proxy_mode = annotations.get(_OPA_PROXY_MODE_KEY) or _OPA_PROXY_MODE

    # Auto-inject control plane URL when available so agents can push heartbeats
    cp_url = os.getenv("CONTROL_PLANE_URL", "")

    patch_ops = build_sidecar_patch(
        spec, annotations, _INJECT_MODE,
        _OPA_ENABLED, _OPA_IMAGE, opa_proxy_mode, _OPA_POLICY_CONFIGMAP_SUFFIX,
        control_plane_url=cp_url,
    )

    if not patch_ops:
        return

    _apply_patch_ops(patch, spec, patch_ops)

    if _k8s_api_client is not None:
        # For generateName pods, `name` is empty at admission time — fall back to generateName.
        pod_name = name or (body.get("metadata") or {}).get("generateName", "unknown")
        cr_name = get_cr_name(annotations, pod_name)
        try:
            check_interval = int(annotations.get("agentspec.io/check-interval", 30))
        except (ValueError, TypeError):
            check_interval = 30
        check_interval = max(5, min(check_interval, 3600))
        uid = (body.get("metadata") or {}).get("uid", "")
        task = asyncio.create_task(
            _create_agent_observation(cr_name, namespace, uid, pod_name, check_interval, _k8s_api_client)
        )
        task.add_done_callback(
            lambda t: logger.error("[webhook] CR creation task failed: %s", t.exception())
            if not t.cancelled() and t.exception() is not None
            else None
        )


@kopf.on.cleanup()
async def cleanup(**kwargs):
    """Stop background tasks on operator shutdown."""
    if _remote_watcher is not None:
        await _remote_watcher.stop()
        logger.info("RemoteAgentWatcher stopped")
    if _k8s_api_client is not None:
        await _k8s_api_client.close()
        logger.info("kubernetes_asyncio ApiClient closed")
