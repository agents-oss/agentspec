"""
RemoteAgentWatcher — polls the AgentSpec control plane and upserts
AgentObservation CRs for remote agents (Bedrock, Vertex, Docker, local)
into the `agentspec-remote` namespace.

Flow every poll_interval seconds:
  1. GET /api/v1/agents  (X-Admin-Key auth)
  2. List existing CRs in agentspec-remote namespace
  3. Upsert CR for each agent returned by control plane
  4. Delete CRs for agents no longer in the control plane list

CR spec.source = "control-plane" signals the daemon in operator.py to
skip the sidecar probe loop — status is managed by the heartbeat flow.

Module-level names (k8s_config_loader, CustomObjectsApi, ApiClient) are
intentionally exported at the top level so unit tests can patch them without
requiring a live Kubernetes cluster.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

import httpx
from kubernetes_asyncio import config as k8s_config
from kubernetes_asyncio.client import ApiClient, CustomObjectsApi

logger = logging.getLogger("agentspec.remote_watcher")

# RFC-1123 DNS label — same pattern as operator.py
_DNS_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?$")

_AGENT_LIMIT_WARN = 500

# CRD coordinates used in every kubernetes_asyncio call
_CRD_GROUP = "agentspec.io"
_CRD_VERSION = "v1"
_CRD_PLURAL = "agentobservations"


async def k8s_config_loader() -> None:
    """
    Load Kubernetes configuration.

    Tries in-cluster config first (for production pod), then falls back to
    kubeconfig (for local/dev use). Exported at module level so tests can
    patch it to a no-op without network access.
    """
    try:
        await k8s_config.load_incluster_config()
    except Exception:
        await k8s_config.load_kube_config()


class RemoteAgentWatcher:
    """
    Background watcher that syncs remote agents from the control plane
    into AgentObservation CRs in the given namespace.

    Lifecycle:
        await watcher.start()   # creates asyncio.Task
        await watcher.stop()    # cancels and awaits task
    """

    def __init__(
        self,
        control_plane_url: str,
        api_key: str,
        poll_interval: int = 30,
        namespace: str = "agentspec-remote",
    ) -> None:
        if not _DNS_LABEL_RE.match(namespace):
            raise ValueError(
                f"namespace {namespace!r} is not a valid RFC-1123 DNS label "
                f"(must match [a-z0-9][a-z0-9\\-]{{0,61}}[a-z0-9], no dots)"
            )
        self._url = control_plane_url.rstrip("/")
        self._api_key = api_key
        self._poll_interval = max(5, min(poll_interval, 3600))
        self._namespace = namespace
        self._task: asyncio.Task | None = None
        self._api_client: Any | None = None
        self._http_client: httpx.AsyncClient | None = None
        # Track lastSeen per agent name to skip no-op upserts
        self._seen_at: dict[str, str] = {}

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the background watch loop as an asyncio Task."""
        if self._task is not None and not self._task.done():
            return
        # Shared clients live for the watcher's lifetime — avoids creating a
        # new connection pool on every poll interval.
        self._http_client = httpx.AsyncClient(timeout=10.0)
        try:
            await k8s_config_loader()
            self._api_client = ApiClient()
        except Exception as exc:
            logger.warning(
                "RemoteAgentWatcher: could not initialise k8s client — %s. "
                "Will retry on first sync.",
                exc,
            )
            self._api_client = None

        self._task = asyncio.ensure_future(self._watch_loop())
        logger.info(
            "RemoteAgentWatcher started — polling %s every %ds → ns=%s",
            self._url,
            self._poll_interval,
            self._namespace,
        )

    async def stop(self) -> None:
        """Cancel the watch loop and wait for clean exit."""
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None

        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

        if self._api_client is not None:
            try:
                await self._api_client.close()
            except Exception:
                pass
            self._api_client = None

        logger.info("RemoteAgentWatcher stopped")

    # ── Watch loop ────────────────────────────────────────────────────────────

    async def _watch_loop(self) -> None:
        while True:
            try:
                await self._sync_once()
            except asyncio.CancelledError:
                raise
            except (httpx.RequestError, Exception) as exc:
                # Log transient network issues as warnings; everything else
                # (programming errors, unexpected k8s failures) as errors so
                # they surface in dashboards without killing the loop.
                level = logger.warning if isinstance(exc, httpx.RequestError) else logger.error
                level("RemoteAgentWatcher sync error (will retry): %s", exc)
            await asyncio.sleep(self._poll_interval)

    async def _sync_once(self) -> None:
        if self._api_client is None:
            try:
                await k8s_config_loader()
                self._api_client = ApiClient()
            except Exception as exc:
                logger.warning("RemoteAgentWatcher: k8s client unavailable — %s", exc)
                return

        agents = await self._fetch_agents()
        if not agents:
            return
        existing = await self._list_existing_crs()
        await self._reconcile(agents, existing)

    # ── Control plane fetch ────────────────────────────────────────────────────

    async def _fetch_agents(self) -> list[dict]:
        """
        GET /api/v1/agents — returns list of AgentSummary dicts.

        Returns empty list on auth failure or malformed JSON so the caller
        can retry next interval without crashing.
        """
        # Use the persistent client; fall back to a temporary one if start()
        # was not called (e.g. unit tests that call _fetch_agents directly).
        client = self._http_client or httpx.AsyncClient(timeout=10.0)
        headers = {"X-Admin-Key": self._api_key}
        try:
            resp = await client.get(f"{self._url}/api/v1/agents", headers=headers)
        except httpx.RequestError as exc:
            logger.warning("RemoteAgentWatcher: network error fetching agents — %s", exc)
            return []

        if resp.status_code == 401:
            logger.warning(
                "RemoteAgentWatcher: 401 Unauthorized — check CONTROL_PLANE_KEY "
                "(api_key=[REDACTED])"
            )
            return []

        if not resp.is_success:
            logger.warning(
                "RemoteAgentWatcher: unexpected status %d from control plane",
                resp.status_code,
            )
            return []

        try:
            data = resp.json()
        except Exception as exc:
            logger.warning("RemoteAgentWatcher: malformed JSON from control plane — %s", exc)
            return []

        if not isinstance(data, list):
            logger.warning(
                "RemoteAgentWatcher: expected JSON array, got %s", type(data).__name__
            )
            return []

        if len(data) > _AGENT_LIMIT_WARN:
            logger.warning(
                "RemoteAgentWatcher: control plane returned %d agents (>%d)",
                len(data),
                _AGENT_LIMIT_WARN,
            )

        return data

    # ── Kubernetes helpers ────────────────────────────────────────────────────

    def _crd_api(self) -> CustomObjectsApi:
        """Return a CustomObjectsApi backed by the shared ApiClient."""
        client = self._api_client if self._api_client is not None else ApiClient()
        return CustomObjectsApi(client)

    def _cr_kwargs(self, name: str | None = None) -> dict[str, Any]:
        """Common keyword args for every agentobservations API call."""
        kwargs: dict[str, Any] = {
            "group": _CRD_GROUP,
            "version": _CRD_VERSION,
            "namespace": self._namespace,
            "plural": _CRD_PLURAL,
        }
        if name is not None:
            kwargs["name"] = name
        return kwargs

    async def _list_existing_crs(self) -> dict[str, str]:
        """Return {agentName: lastSeen} for CRs managed by this watcher."""
        crd_api = self._crd_api()
        try:
            result = await crd_api.list_namespaced_custom_object(
                **self._cr_kwargs(),
                label_selector="agentspec.io/managed-by=remote-watcher",
            )
        except Exception as exc:
            logger.warning(
                "RemoteAgentWatcher: failed to list CRs in %s — %s",
                self._namespace,
                exc,
            )
            return {}

        existing: dict[str, str] = {}
        for item in result.get("items", []):
            name = item.get("metadata", {}).get("name", "")
            annotations = item.get("metadata", {}).get("annotations", {}) or {}
            if name:
                existing[name] = annotations.get("agentspec.io/last-seen", "")
        return existing

    async def _upsert_cr(self, agent: dict) -> None:
        """
        Create or patch the AgentObservation CR for the given agent.

        Skips the k8s call if lastSeen is unchanged (idempotent).
        """
        name: str = agent.get("agentName", "")
        if not name or not _DNS_LABEL_RE.match(name):
            logger.warning(
                "RemoteAgentWatcher: skipping agent with invalid name %r "
                "(must be RFC-1123 DNS label)",
                name,
            )
            return

        last_seen = str(agent.get("lastSeen") or "")
        # Skip upsert if we have already synced this exact lastSeen value.
        # Use `name in self._seen_at` rather than `and last_seen` so that
        # an empty-string lastSeen is also correctly treated as "unchanged".
        if name in self._seen_at and self._seen_at[name] == last_seen:
            logger.debug(
                "RemoteAgentWatcher: [%s] lastSeen unchanged (%s) — skipping upsert",
                name,
                last_seen,
            )
            return

        cr = self._build_cr(name, agent, last_seen)
        crd_api = self._crd_api()

        try:
            await crd_api.get_namespaced_custom_object(**self._cr_kwargs(name))
            await crd_api.patch_namespaced_custom_object(**self._cr_kwargs(name), body=cr)
            logger.debug("RemoteAgentWatcher: patched CR for %s", name)
            self._seen_at[name] = last_seen
        except Exception as get_exc:
            if _is_not_found(get_exc):
                try:
                    await crd_api.create_namespaced_custom_object(**self._cr_kwargs(), body=cr)
                    logger.info("RemoteAgentWatcher: created CR for %s", name)
                    self._seen_at[name] = last_seen
                except Exception as create_exc:
                    logger.warning(
                        "RemoteAgentWatcher: failed to create CR for %s — %s",
                        name,
                        create_exc,
                    )
            else:
                logger.warning(
                    "RemoteAgentWatcher: failed to upsert CR for %s — %s",
                    name,
                    get_exc,
                )

    async def _delete_cr(self, name: str) -> None:
        """Delete a stale AgentObservation CR from the target namespace."""
        crd_api = self._crd_api()
        try:
            await crd_api.delete_namespaced_custom_object(**self._cr_kwargs(name))
            logger.info("RemoteAgentWatcher: deleted stale CR for %s", name)
        except Exception as exc:
            logger.warning(
                "RemoteAgentWatcher: failed to delete CR for %s — %s", name, exc
            )
        self._seen_at.pop(name, None)

    # ── Reconcile ────────────────────────────────────────────────────────────

    async def _reconcile(self, agents: list[dict], existing: dict[str, str]) -> None:
        """
        Upsert a CR for every agent from the control plane; delete stale CRs.
        """
        active_names = {a.get("agentName", "") for a in agents if a.get("agentName")}
        for agent in agents:
            await self._upsert_cr(agent)

        for name in set(existing) - active_names:
            logger.info(
                "RemoteAgentWatcher: agent %r no longer in control plane — deleting CR",
                name,
            )
            await self._delete_cr(name)

    # ── CR builder ────────────────────────────────────────────────────────────

    def _build_cr(self, name: str, agent: dict, last_seen: str) -> dict[str, Any]:
        return {
            "apiVersion": f"{_CRD_GROUP}/v1",
            "kind": "AgentObservation",
            "metadata": {
                "name": name,
                "namespace": self._namespace,
                # Label used by label_selector in _list_existing_crs()
                "labels": {"agentspec.io/managed-by": "remote-watcher"},
                "annotations": {
                    "agentspec.io/runtime": agent.get("runtime", "unknown"),
                    "agentspec.io/agent-id": agent.get("agentId", ""),
                    "agentspec.io/last-seen": last_seen,
                },
            },
            "spec": {
                "agentRef": {"name": name},
                "source": "control-plane",
            },
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_not_found(exc: Exception) -> bool:
    """Return True if the kubernetes_asyncio exception indicates HTTP 404."""
    if getattr(exc, "status", None) == 404:
        return True
    return "404" in str(exc) and "Not Found" in str(exc)
