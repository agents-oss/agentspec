"""
Unit tests for remote_watcher.py — RemoteAgentWatcher.

All tests are async and use mocked httpx + kubernetes_asyncio.
No network calls, no Kubernetes cluster required.

Pattern: follow test_prober.py — unittest.mock.AsyncMock + unittest.mock.patch.

Patch targets:
  remote_watcher.k8s_config_loader  — module-level async config loader
  remote_watcher.CustomObjectsApi   — module-level k8s CRD API class
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from remote_watcher import RemoteAgentWatcher, _is_not_found


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


def _make_http_response(
    payload,
    status_code: int = 200,
) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.is_success = 200 <= status_code < 300
    resp.json.return_value = payload
    return resp


def _make_not_found_exc() -> Exception:
    exc = Exception("404 Not Found")
    exc.status = 404  # type: ignore[attr-defined]
    return exc


def _make_watcher(**kwargs) -> RemoteAgentWatcher:
    return RemoteAgentWatcher(
        control_plane_url="https://cp.example.com",
        api_key="test-admin-key",
        poll_interval=30,
        namespace="agentspec-remote",
        **kwargs,
    )


def _make_crd_api_mock() -> AsyncMock:
    """Return an AsyncMock with all CRD API methods stubbed."""
    api = AsyncMock()
    api.list_namespaced_custom_object = AsyncMock(return_value={"items": []})
    api.get_namespaced_custom_object = AsyncMock()
    api.create_namespaced_custom_object = AsyncMock()
    api.patch_namespaced_custom_object = AsyncMock()
    api.delete_namespaced_custom_object = AsyncMock()
    return api


# ── _fetch_agents ─────────────────────────────────────────────────────────────

def _make_http_client_mock(resp: MagicMock) -> AsyncMock:
    """Return a mock httpx client whose .get() returns resp."""
    client = AsyncMock()
    client.get = AsyncMock(return_value=resp)
    return client


class TestFetchAgents:
    async def test_fetch_agents_success(self):
        """Parses response list correctly and returns agent dicts."""
        watcher = _make_watcher()
        agents = [_make_agent(), _make_agent("vertex-trader", "vertex")]
        watcher._http_client = _make_http_client_mock(_make_http_response(agents))

        result = await watcher._fetch_agents()

        assert len(result) == 2
        assert result[0]["agentName"] == "bedrock-assistant"
        assert result[1]["runtime"] == "vertex"

    async def test_fetch_agents_401(self):
        """401 Unauthorized logs warning with [REDACTED] key and returns empty list."""
        watcher = _make_watcher()
        watcher._http_client = _make_http_client_mock(_make_http_response({}, status_code=401))

        with patch("remote_watcher.logger") as mock_logger:
            result = await watcher._fetch_agents()

        assert result == []
        mock_logger.warning.assert_called_once()
        warning_msg = str(mock_logger.warning.call_args)
        assert "test-admin-key" not in warning_msg
        assert "[REDACTED]" in warning_msg

    async def test_fetch_agents_malformed_json(self):
        """Malformed JSON logs warning and returns empty list (no crash)."""
        watcher = _make_watcher()
        resp = _make_http_response(None)
        resp.is_success = True
        resp.status_code = 200
        resp.json.side_effect = ValueError("Expecting value")
        watcher._http_client = _make_http_client_mock(resp)

        with patch("remote_watcher.logger") as mock_logger:
            result = await watcher._fetch_agents()

        assert result == []
        mock_logger.warning.assert_called()

    async def test_fetch_agents_network_error(self):
        """Network error (RequestError) logs warning and returns empty list."""
        watcher = _make_watcher()
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=httpx.ConnectError("Name or service not known")
        )
        watcher._http_client = mock_client

        with patch("remote_watcher.logger") as mock_logger:
            result = await watcher._fetch_agents()

        assert result == []
        mock_logger.warning.assert_called()


# ── _upsert_cr ────────────────────────────────────────────────────────────────

class TestUpsertCr:
    async def test_upsert_cr_new_agent(self):
        """404 on get → CREATE called with correct CR shape."""
        watcher = _make_watcher()
        agent = _make_agent()

        mock_crd_api = _make_crd_api_mock()
        mock_crd_api.get_namespaced_custom_object = AsyncMock(
            side_effect=_make_not_found_exc()
        )

        with (
            patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
            patch.object(watcher, "_crd_api", return_value=mock_crd_api),
        ):
            await watcher._upsert_cr(agent)

        mock_crd_api.create_namespaced_custom_object.assert_called_once()
        call_kwargs = mock_crd_api.create_namespaced_custom_object.call_args.kwargs
        body = call_kwargs["body"]

        assert body["apiVersion"] == "agentspec.io/v1"
        assert body["kind"] == "AgentObservation"
        assert body["metadata"]["name"] == "bedrock-assistant"
        assert body["metadata"]["namespace"] == "agentspec-remote"
        assert body["spec"]["source"] == "control-plane"
        assert body["spec"]["agentRef"]["name"] == "bedrock-assistant"
        # managed-by must be a LABEL (not just annotation) for label_selector to work
        assert body["metadata"]["labels"]["agentspec.io/managed-by"] == "remote-watcher"
        assert body["metadata"]["annotations"]["agentspec.io/runtime"] == "bedrock"

    async def test_upsert_cr_empty_last_seen_idempotent(self):
        """Empty-string lastSeen is treated as unchanged when already cached."""
        watcher = _make_watcher()
        agent = _make_agent(last_seen="")
        watcher._seen_at["bedrock-assistant"] = ""  # previously cached with ""

        mock_crd_api = _make_crd_api_mock()
        with patch.object(watcher, "_crd_api", return_value=mock_crd_api):
            await watcher._upsert_cr(agent)

        mock_crd_api.get_namespaced_custom_object.assert_not_called()

    async def test_upsert_cr_same_last_seen(self):
        """No k8s API call when lastSeen is unchanged (idempotent)."""
        watcher = _make_watcher()
        last_seen = "2026-01-01T00:00:00+00:00"
        agent = _make_agent(last_seen=last_seen)
        watcher._seen_at["bedrock-assistant"] = last_seen

        mock_crd_api = _make_crd_api_mock()

        with (
            patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
            patch.object(watcher, "_crd_api", return_value=mock_crd_api),
        ):
            await watcher._upsert_cr(agent)

        mock_crd_api.get_namespaced_custom_object.assert_not_called()
        mock_crd_api.create_namespaced_custom_object.assert_not_called()
        mock_crd_api.patch_namespaced_custom_object.assert_not_called()

    async def test_upsert_cr_existing_agent_patches(self):
        """CR exists (no 404) → PATCH called, not CREATE."""
        watcher = _make_watcher()
        agent = _make_agent()

        mock_crd_api = _make_crd_api_mock()
        mock_crd_api.get_namespaced_custom_object = AsyncMock(return_value={"kind": "AgentObservation"})

        with (
            patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
            patch.object(watcher, "_crd_api", return_value=mock_crd_api),
        ):
            await watcher._upsert_cr(agent)

        mock_crd_api.patch_namespaced_custom_object.assert_called_once()
        mock_crd_api.create_namespaced_custom_object.assert_not_called()


# ── _reconcile (deletion) ─────────────────────────────────────────────────────

class TestReconcile:
    async def test_reconcile_deletes_missing_agent(self):
        """Agent in existing CRs but not in control plane list → DELETE called."""
        watcher = _make_watcher()

        agents = [_make_agent("active-agent")]
        existing = {
            "active-agent": "2026-01-01T00:00:00+00:00",
            "stale-agent": "2025-12-01T00:00:00+00:00",
        }

        deleted_names: list[str] = []
        upserted_names: list[str] = []

        async def fake_upsert(agent: dict) -> None:
            upserted_names.append(agent.get("agentName", ""))

        async def fake_delete(name: str) -> None:
            deleted_names.append(name)

        watcher._upsert_cr = fake_upsert  # type: ignore[method-assign]
        watcher._delete_cr = fake_delete  # type: ignore[method-assign]

        await watcher._reconcile(agents, existing)

        assert "stale-agent" in deleted_names
        assert "active-agent" not in deleted_names
        assert "active-agent" in upserted_names


# ── Name validation ───────────────────────────────────────────────────────────

class TestNameValidation:
    async def test_cr_name_dots_rejected(self):
        """Dotted name (e.g. IP or FQDN) → warning logged, CR not created."""
        watcher = _make_watcher()
        agent = _make_agent(name="192.168.1.1")

        mock_crd_api = _make_crd_api_mock()

        with (
            patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
            patch.object(watcher, "_crd_api", return_value=mock_crd_api),
            patch("remote_watcher.logger") as mock_logger,
        ):
            await watcher._upsert_cr(agent)

        mock_crd_api.create_namespaced_custom_object.assert_not_called()
        mock_logger.warning.assert_called()

    async def test_cr_name_uppercase_rejected(self):
        """Uppercase name → warning logged, CR not created."""
        watcher = _make_watcher()
        agent = _make_agent(name="MyAgent")

        mock_crd_api = _make_crd_api_mock()

        with (
            patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
            patch.object(watcher, "_crd_api", return_value=mock_crd_api),
            patch("remote_watcher.logger") as mock_logger,
        ):
            await watcher._upsert_cr(agent)

        mock_crd_api.create_namespaced_custom_object.assert_not_called()
        mock_logger.warning.assert_called()

    async def test_valid_name_with_hyphens_accepted(self):
        """Lowercase with hyphens is valid (bedrock-assistant)."""
        watcher = _make_watcher()
        agent = _make_agent(name="bedrock-assistant")

        mock_crd_api = _make_crd_api_mock()
        mock_crd_api.get_namespaced_custom_object = AsyncMock(
            side_effect=_make_not_found_exc()
        )

        with (
            patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
            patch.object(watcher, "_crd_api", return_value=mock_crd_api),
        ):
            await watcher._upsert_cr(agent)

        mock_crd_api.create_namespaced_custom_object.assert_called_once()


# ── Lifecycle ─────────────────────────────────────────────────────────────────

class TestLifecycle:
    async def test_start_stop_lifecycle(self):
        """Task created on start, cancelled and awaited on stop — no error."""
        watcher = _make_watcher()

        async def fake_watch_loop():
            await asyncio.sleep(9999)

        with (
            patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
            patch("remote_watcher.ApiClient", return_value=MagicMock()),
            patch.object(watcher, "_watch_loop", side_effect=fake_watch_loop),
        ):
            await watcher.start()

            assert watcher._task is not None
            assert not watcher._task.done()

            await watcher.stop()

        assert watcher._task is None

    async def test_start_is_idempotent(self):
        """Calling start() twice does not create a second task."""
        watcher = _make_watcher()

        async def fake_watch_loop():
            await asyncio.sleep(9999)

        with (
            patch("remote_watcher.k8s_config_loader", new=AsyncMock()),
            patch("remote_watcher.ApiClient", return_value=MagicMock()),
            patch.object(watcher, "_watch_loop", side_effect=fake_watch_loop),
        ):
            await watcher.start()
            task1 = watcher._task
            await watcher.start()
            task2 = watcher._task

        assert task1 is task2
        task1.cancel()
        try:
            await task1
        except asyncio.CancelledError:
            pass

    async def test_stop_before_start_is_noop(self):
        """Calling stop() before start() does not raise."""
        watcher = _make_watcher()
        await watcher.stop()  # must not raise
        assert watcher._task is None

    async def test_namespace_validation_rejects_dots(self):
        """__init__ raises ValueError for dotted namespace (invalid DNS label)."""
        with pytest.raises(ValueError, match="not a valid RFC-1123 DNS label"):
            RemoteAgentWatcher(
                control_plane_url="https://cp.example.com",
                api_key="key",
                namespace="my.namespace.com",
            )

    async def test_poll_interval_clamped_below(self):
        """poll_interval < 5 is clamped to 5."""
        watcher = RemoteAgentWatcher(
            control_plane_url="https://cp.example.com",
            api_key="key",
            poll_interval=0,
        )
        assert watcher._poll_interval == 5

    async def test_poll_interval_clamped_above(self):
        """poll_interval > 3600 is clamped to 3600."""
        watcher = RemoteAgentWatcher(
            control_plane_url="https://cp.example.com",
            api_key="key",
            poll_interval=99999,
        )
        assert watcher._poll_interval == 3600


# ── Large agent list ──────────────────────────────────────────────────────────

class TestLargeAgentList:
    async def test_large_agent_list_warns_and_upserts_all(self):
        """501 agents → warning logged, all 501 agents reconciled via upsert."""
        watcher = _make_watcher()
        agents_cp = [_make_agent(f"agent-{i:04d}") for i in range(501)]

        watcher._http_client = _make_http_client_mock(_make_http_response(agents_cp))

        upserted_names: list[str] = []

        async def fake_upsert(agent: dict) -> None:
            upserted_names.append(agent["agentName"])

        watcher._upsert_cr = fake_upsert  # type: ignore[method-assign]
        watcher._delete_cr = AsyncMock()   # type: ignore[method-assign]

        with patch("remote_watcher.logger") as mock_logger:
            fetched = await watcher._fetch_agents()

        assert len(fetched) == 501
        warning_calls = [str(c) for c in mock_logger.warning.call_args_list]
        assert any("501" in msg for msg in warning_calls)

        await watcher._reconcile(agents_cp, {})
        assert len(upserted_names) == 501
        assert upserted_names[0] == "agent-0000"
        assert upserted_names[500] == "agent-0500"


# ── _is_not_found helper ──────────────────────────────────────────────────────

class TestIsNotFound:
    def test_status_404_attribute(self):
        exc = Exception("not found")
        exc.status = 404  # type: ignore[attr-defined]
        assert _is_not_found(exc) is True

    def test_status_not_404(self):
        exc = Exception("server error")
        exc.status = 500  # type: ignore[attr-defined]
        assert _is_not_found(exc) is False

    def test_no_status_attribute(self):
        exc = Exception("connection error")
        assert _is_not_found(exc) is False

    def test_string_404_not_found(self):
        exc = Exception("404 Not Found")
        assert _is_not_found(exc) is True

    def test_404_without_not_found_string(self):
        """'404' alone without 'Not Found' should not match."""
        exc = Exception("Response code: 404")
        assert _is_not_found(exc) is False
