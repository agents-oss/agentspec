"""
Integration tests for RemoteAgentWatcher — in-process, no cluster required.

These tests run the full watcher lifecycle (start → poll → stop) against a fake
in-process control plane and a stateful in-memory Kubernetes store.  No real
HTTP server and no Kubernetes cluster are needed.

Scope (what is NOT mocked):
  - _fetch_agents()   — parses real JSON from the fake HTTP transport
  - _sync_once()      — full reconcile path end-to-end
  - _reconcile()      — upsert + delete dispatch
  - _upsert_cr()      — create-or-patch logic with _seen_at idempotency cache
  - _delete_cr()      — stale-CR deletion
  - _watch_loop()     — real asyncio.Task with real asyncio.sleep
  - start() / stop()  — task lifecycle management

Only the two external boundaries are replaced:
  * HTTP transport  → FakeControlPlane (stateful agent list, validates auth header)
  * k8s CRD API    → FakeK8sStore     (stateful in-memory CR dict, records calls)

Injection technique:
  start() calls self._http_client = httpx.AsyncClient(...) then
  asyncio.ensure_future(self._watch_loop()).  Because ensure_future only
  *schedules* the coroutine, the task has not yet executed when start()
  returns.  We overwrite _http_client immediately after start() —
  the task always sees the fake client on its first (and every subsequent) poll.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from remote_watcher import RemoteAgentWatcher

# ── Constants ─────────────────────────────────────────────────────────────────

_CP_URL = "https://cp.example.com"
_ADMIN_KEY = "test-admin-key"
# RemoteAgentWatcher.__init__ clamps poll_interval to max(5, ...).
# We bypass that by setting _poll_interval directly after construction so
# integration tests complete in seconds rather than minutes.
_POLL = 1        # actual asyncio.sleep duration used in _watch_loop
_TIMEOUT = 4.0   # _wait_for ceiling: 4 × poll interval


# ── Fake control plane ────────────────────────────────────────────────────────

class FakeControlPlane:
    """
    Stateful in-memory fake for GET /api/v1/agents.

    Tests mutate ``.agents`` between poll cycles to drive state changes
    (agent appears, disappears, lastSeen advances, etc.).

    Auth: validates the X-Admin-Key header and returns 401 if wrong.
    The returned httpx client mock is injected into watcher._http_client.
    """

    def __init__(
        self,
        agents: list[dict] | None = None,
        api_key: str = _ADMIN_KEY,
        status_code: int = 200,
    ) -> None:
        self.agents: list[dict] = list(agents or [])
        self._api_key = api_key
        self.status_code = status_code  # set to 5xx to simulate errors

    def make_http_client(self) -> AsyncMock:
        plane = self  # capture for closure

        async def handle_get(url: str, *, headers: dict | None = None, **_):
            resp = MagicMock()
            if (headers or {}).get("X-Admin-Key") != plane._api_key:
                resp.status_code = 401
                resp.is_success = False
                return resp
            if not (200 <= plane.status_code < 300):
                resp.status_code = plane.status_code
                resp.is_success = False
                return resp
            resp.status_code = 200
            resp.is_success = True
            resp.json.return_value = list(plane.agents)   # snapshot at call time
            return resp

        client = AsyncMock()
        client.get = AsyncMock(side_effect=handle_get)
        client.aclose = AsyncMock()
        return client


# ── Fake k8s store ────────────────────────────────────────────────────────────

class FakeK8sStore:
    """
    Stateful in-memory store of AgentObservation CRs — simulates the k8s API.

    _list_existing_crs() reads metadata.name + metadata.annotations from returned
    items, so list_crs() preserves the full annotation dict from the stored CR.

    Tracks create / patch / delete calls so tests can assert on them without
    inspecting mock call history.
    """

    def __init__(self) -> None:
        self._crs: dict[str, dict] = {}   # name → full CR body
        self.creates: list[dict] = []
        self.patches: list[dict] = []
        self.deletes: list[str] = []

    @property
    def cr_names(self) -> set[str]:
        return set(self._crs)

    def make_crd_api(self) -> AsyncMock:
        store = self

        async def list_crs(**_):
            items = []
            for name, cr in store._crs.items():
                annotations = (cr.get("metadata") or {}).get("annotations") or {}
                items.append({"metadata": {"name": name, "annotations": annotations}})
            return {"items": items}

        async def get_cr(name: str | None = None, **_):
            if name not in store._crs:
                exc = Exception(f"404 Not Found: {name}")
                exc.status = 404  # type: ignore[attr-defined]
                raise exc
            return store._crs[name]

        async def create_cr(body: dict | None = None, **_):
            assert body is not None
            name = body["metadata"]["name"]
            store._crs[name] = body
            store.creates.append(body)

        async def patch_cr(name: str | None = None, body: dict | None = None, **_):
            assert body is not None
            store._crs[name] = body
            store.patches.append(body)

        async def delete_cr(name: str | None = None, **_):
            store._crs.pop(name, None)
            store.deletes.append(name)

        api = AsyncMock()
        api.list_namespaced_custom_object = AsyncMock(side_effect=list_crs)
        api.get_namespaced_custom_object = AsyncMock(side_effect=get_cr)
        api.create_namespaced_custom_object = AsyncMock(side_effect=create_cr)
        api.patch_namespaced_custom_object = AsyncMock(side_effect=patch_cr)
        api.delete_namespaced_custom_object = AsyncMock(side_effect=delete_cr)
        return api


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_agent(
    name: str = "bedrock-assistant",
    runtime: str = "bedrock",
    agent_id: str = "agt_abc123",
    last_seen: str = "2026-01-01T00:00:00+00:00",
) -> dict:
    return {
        "agentId": agent_id,
        "agentName": name,
        "runtime": runtime,
        "phase": "Healthy",
        "grade": "B",
        "score": 82,
        "lastSeen": last_seen,
    }


def _make_watcher(**kwargs) -> RemoteAgentWatcher:
    w = RemoteAgentWatcher(
        control_plane_url=_CP_URL,
        api_key=_ADMIN_KEY,
        poll_interval=30,   # constructor clamps to max(5, ...) — value doesn't matter
        **kwargs,
    )
    w._poll_interval = _POLL   # bypass the clamp for fast test cycles
    return w


async def _wait_for(condition, timeout: float = _TIMEOUT, interval: float = 0.05) -> None:
    """
    Poll ``condition()`` every ``interval`` seconds until True or timeout.
    Raises TimeoutError so a failing test surfaces a clear message rather than
    hanging for the full timeout before crashing elsewhere.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if condition():
            return
        await asyncio.sleep(interval)
    raise TimeoutError(f"Condition not met within {timeout}s")


@asynccontextmanager
async def _running(
    watcher: RemoteAgentWatcher,
    fake_http_client: AsyncMock,
    fake_crd_api: AsyncMock,
):
    """
    Context manager that:
      1. Patches k8s_config_loader and ApiClient (no cluster needed).
      2. Calls watcher.start() — creates real asyncio.Task.
      3. Overwrites watcher._http_client with fake_http_client BEFORE the
         scheduled task executes its first poll (safe because ensure_future
         only enqueues the coroutine; the current coroutine still owns the loop).
      4. Overwrites watcher._crd_api with a lambda returning fake_crd_api.
         Direct assignment is used (not patch.object) so the override persists
         reliably across every coroutine context switch in the asyncio task.
      5. Yields the running watcher.
      6. Calls watcher.stop() on exit regardless of exceptions.
    """
    with (
        patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
        patch("remote_watcher.ApiClient", return_value=MagicMock()),
    ):
        await watcher.start()
        watcher._http_client = fake_http_client   # overwrite before first poll
        watcher._crd_api = lambda: fake_crd_api   # direct assignment, survives context switches
        try:
            yield watcher
        finally:
            await watcher.stop()


# ── CR shape assertions ───────────────────────────────────────────────────────

def _assert_cr_shape(cr: dict, agent: dict, namespace: str = "agentspec-remote") -> None:
    """Centralised CR shape check reused across multiple tests."""
    assert cr["apiVersion"] == "agentspec.io/v1"
    assert cr["kind"] == "AgentObservation"
    assert cr["metadata"]["name"] == agent["agentName"]
    assert cr["metadata"]["namespace"] == namespace
    # label required for label_selector in _list_existing_crs()
    assert cr["metadata"]["labels"]["agentspec.io/managed-by"] == "remote-watcher"
    # annotations carry runtime metadata
    assert cr["metadata"]["annotations"]["agentspec.io/runtime"] == agent["runtime"]
    assert cr["metadata"]["annotations"]["agentspec.io/agent-id"] == agent["agentId"]
    assert cr["metadata"]["annotations"]["agentspec.io/last-seen"] == agent["lastSeen"]
    # spec signals the daemon to skip the sidecar probe
    assert cr["spec"]["source"] == "control-plane"
    assert cr["spec"]["agentRef"]["name"] == agent["agentName"]


# ── Test: CR creation ─────────────────────────────────────────────────────────

class TestCrCreation:
    async def test_new_agent_cr_created_with_correct_shape(self):
        """
        Single agent appears in control plane →
        watcher creates one AgentObservation CR with the full expected shape.
        """
        agent = _make_agent()
        cp = FakeControlPlane(agents=[agent])
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            await _wait_for(lambda: len(store.creates) >= 1)

        assert len(store.creates) == 1
        _assert_cr_shape(store.creates[0], agent)

    async def test_multiple_agents_all_crs_created(self):
        """
        Three agents in control plane → three CRs created, one per agent.
        """
        agents = [
            _make_agent("bedrock-assistant", "bedrock"),
            _make_agent("vertex-trader", "vertex"),
            _make_agent("local-dev-agent", "local"),
        ]
        cp = FakeControlPlane(agents=agents)
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            await _wait_for(lambda: len(store.creates) >= 3)

        assert store.cr_names == {"bedrock-assistant", "vertex-trader", "local-dev-agent"}
        for agent in agents:
            cr = next(c for c in store.creates if c["metadata"]["name"] == agent["agentName"])
            _assert_cr_shape(cr, agent)


# ── Test: idempotency ─────────────────────────────────────────────────────────

class TestIdempotency:
    async def test_unchanged_last_seen_no_second_upsert(self):
        """
        Two poll cycles, same agent, same lastSeen →
        k8s create called exactly once (idempotency via _seen_at cache).
        """
        agent = _make_agent(last_seen="2026-01-01T00:00:00+00:00")
        cp = FakeControlPlane(agents=[agent])
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            await _wait_for(lambda: len(store.creates) >= 1)
            # Let a second poll cycle complete — lastSeen is still the same
            await asyncio.sleep(_POLL + 0.3)

        assert len(store.creates) == 1
        assert len(store.patches) == 0

    async def test_updated_last_seen_triggers_patch(self):
        """
        Agent's lastSeen advances between polls →
        watcher patches the existing CR on the second cycle.
        """
        agent = _make_agent(last_seen="2026-01-01T00:00:00+00:00")
        cp = FakeControlPlane(agents=[agent])
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            await _wait_for(lambda: len(store.creates) >= 1)
            # Advance lastSeen — triggers a patch on the next poll
            cp.agents[0]["lastSeen"] = "2026-01-02T00:00:00+00:00"
            await _wait_for(lambda: len(store.patches) >= 1)

        assert len(store.creates) == 1
        assert len(store.patches) == 1
        patched_cr = store.patches[0]
        assert patched_cr["metadata"]["annotations"]["agentspec.io/last-seen"] == \
            "2026-01-02T00:00:00+00:00"


# ── Test: agent removal ───────────────────────────────────────────────────────

class TestAgentRemoval:
    async def test_agent_removed_cr_deleted(self):
        """
        One agent disappears from a two-agent control plane →
        watcher deletes its stale CR on the next poll.

        Two agents are used so the returned list stays non-empty: _sync_once
        has an early-return guard (`if not agents: return`) that skips
        reconciliation when the control plane returns an empty list, treating
        it as a transient error rather than an intentional deregistration.
        """
        bedrock = _make_agent("bedrock-assistant", "bedrock")
        vertex = _make_agent("vertex-trader", "vertex")
        cp = FakeControlPlane(agents=[bedrock, vertex])
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            await _wait_for(lambda: store.cr_names == {"bedrock-assistant", "vertex-trader"})
            # Remove bedrock-assistant — vertex-trader keeps the list non-empty
            cp.agents.remove(bedrock)
            await _wait_for(lambda: len(store.deletes) >= 1)

        assert "bedrock-assistant" in store.deletes
        assert "bedrock-assistant" not in store.cr_names
        assert "vertex-trader" in store.cr_names   # survivor untouched

    async def test_seen_at_cleared_on_delete_so_agent_can_return(self):
        """
        Delete clears _seen_at cache →
        re-appearing agent gets a fresh CR (not silently skipped).
        Phase 1: appear → create.  Phase 2: vanish → delete.  Phase 3: return → create again.

        A permanent second agent keeps the list non-empty throughout so
        reconciliation always runs (see test_agent_removed_cr_deleted docstring).
        """
        bedrock = _make_agent("bedrock-assistant", last_seen="2026-01-01T00:00:00+00:00")
        anchor = _make_agent("anchor-agent", "local")   # never removed — keeps list non-empty
        cp = FakeControlPlane(agents=[bedrock, anchor])
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            await _wait_for(lambda: "bedrock-assistant" in store.cr_names)   # Phase 1
            cp.agents.remove(bedrock)
            await _wait_for(lambda: len(store.deletes) >= 1)                # Phase 2
            cp.agents.append(bedrock)
            await _wait_for(lambda: len(store.creates) >= 2)                # Phase 3 (re-create)

        assert len(store.creates) == 2
        assert len(store.deletes) == 1


# ── Test: error recovery ──────────────────────────────────────────────────────

class TestErrorRecovery:
    async def test_control_plane_error_then_recovery(self):
        """
        Control plane returns 503 on first poll (watcher logs warning, no crash).
        Returns 200 on subsequent polls → CR created.
        """
        agent = _make_agent()
        cp = FakeControlPlane(agents=[agent], status_code=503)
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            # First poll hits 503 — no CR yet
            await asyncio.sleep(0.1)
            assert len(store.creates) == 0
            # Recover — subsequent polls return 200
            cp.status_code = 200
            await _wait_for(lambda: len(store.creates) >= 1)

        assert len(store.creates) == 1

    async def test_invalid_agent_names_skipped_valid_agent_created(self):
        """
        Control plane returns agents with invalid RFC-1123 names mixed with
        a valid one.  Invalid names are logged and skipped; valid agent gets a CR.
        """
        valid = _make_agent("valid-agent")
        invalid_agents = [
            {**_make_agent(), "agentName": "Agent.With.Dots"},
            {**_make_agent(), "agentName": "UPPERCASE"},
            {**_make_agent(), "agentName": "-leading-hyphen"},
            {**_make_agent(), "agentName": ""},
            valid,
        ]
        cp = FakeControlPlane(agents=invalid_agents)
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            await _wait_for(lambda: "valid-agent" in store.cr_names)
            # Brief pause: no late creates for invalid names
            await asyncio.sleep(0.2)

        assert store.cr_names == {"valid-agent"}
        assert len(store.creates) == 1

    async def test_wrong_api_key_no_cr_created(self):
        """
        Watcher configured with wrong API key → control plane returns 401 every
        poll → no CRs ever created (auth failure handled gracefully, no crash).
        """
        agent = _make_agent()
        cp = FakeControlPlane(agents=[agent], api_key="correct-key")  # key mismatch
        store = FakeK8sStore()
        watcher = _make_watcher()   # uses _ADMIN_KEY, not "correct-key"

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            await asyncio.sleep(_POLL * 2)  # two full cycles with wrong key

        assert len(store.creates) == 0


# ── Test: lifecycle ───────────────────────────────────────────────────────────

class TestLifecycle:
    async def test_start_creates_running_task(self):
        """start() creates an asyncio.Task that is still running."""
        cp = FakeControlPlane(agents=[])
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            assert watcher._task is not None
            assert not watcher._task.done()

    async def test_stop_cleans_up_all_resources(self):
        """stop() cancels the task and nils out all shared client references."""
        cp = FakeControlPlane(agents=[])
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            pass  # start + immediate stop via context manager exit

        assert watcher._task is None
        assert watcher._http_client is None
        assert watcher._api_client is None

    async def test_start_idempotent_second_call_is_noop(self):
        """Calling start() twice does not spawn a second task."""
        cp = FakeControlPlane(agents=[])
        store = FakeK8sStore()
        watcher = _make_watcher()

        async with _running(watcher, cp.make_http_client(), store.make_crd_api()):
            first_task = watcher._task
            await watcher.start()          # second call — must be no-op
            assert watcher._task is first_task

    async def test_stop_before_start_is_safe(self):
        """stop() on a never-started watcher does not raise."""
        watcher = _make_watcher()
        await watcher.stop()              # no task — should be a silent no-op
        assert watcher._task is None
