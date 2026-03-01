"""
Tests for GET /api/v1/agents and GET /api/v1/agents/{name}/health.
Both endpoints require X-Admin-Key authentication.
"""
from __future__ import annotations

import json

import pytest

from tests.conftest import ADMIN_HEADERS, make_gap, make_health


@pytest.mark.asyncio
async def test_list_agents_empty(client):
    ac, _ = client
    resp = await ac.get("/api/v1/agents", headers=ADMIN_HEADERS)
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_agents_after_registration(client):
    ac, _ = client
    await ac.post(
        "/api/v1/register",
        json={"agentName": "my-agent", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    resp = await ac.get("/api/v1/agents", headers=ADMIN_HEADERS)
    assert resp.status_code == 200
    agents = resp.json()
    assert len(agents) == 1
    a = agents[0]
    assert a["agentName"] == "my-agent"
    assert a["runtime"] == "local"
    assert a["agentId"].startswith("agt_")
    assert a["phase"] == "Unknown"
    assert a["grade"] == "F"
    assert a["score"] == 0


@pytest.mark.asyncio
async def test_list_agents_multiple(client):
    ac, _ = client
    for name, runtime in [("agent-a", "bedrock"), ("agent-b", "vertex")]:
        await ac.post(
            "/api/v1/register",
            json={"agentName": name, "runtime": runtime},
            headers=ADMIN_HEADERS,
        )
    resp = await ac.get("/api/v1/agents", headers=ADMIN_HEADERS)
    names = {a["agentName"] for a in resp.json()}
    assert names == {"agent-a", "agent-b"}


@pytest.mark.asyncio
async def test_get_health_unknown_agent_returns_404(client):
    ac, _ = client
    resp = await ac.get("/api/v1/agents/does-not-exist/health", headers=ADMIN_HEADERS)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_health_no_heartbeat_yet_returns_404(client):
    ac, _ = client
    await ac.post(
        "/api/v1/register",
        json={"agentName": "silent-agent", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    resp = await ac.get("/api/v1/agents/silent-agent/health", headers=ADMIN_HEADERS)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_health_returns_last_health_report(registered):
    ac, mock_upsert, agent_id, api_key = registered
    health_payload = make_health("ready")
    await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": health_payload, "gap": make_gap(80)}),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    resp = await ac.get("/api/v1/agents/test-bedrock/health", headers=ADMIN_HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ready"
    assert data["agentName"] == "test-bedrock"


# ── HIGH: agents endpoints must require authentication ────────────────────────

@pytest.mark.asyncio
async def test_list_agents_requires_auth(client):
    """GET /agents must require authentication — information disclosure risk."""
    ac, _ = client
    resp = await ac.get("/api/v1/agents")
    assert resp.status_code in (401, 403), (
        f"GET /agents must require auth, got {resp.status_code}"
    )


@pytest.mark.asyncio
async def test_get_agent_health_requires_auth(client):
    """GET /agents/{name}/health must require authentication."""
    ac, _ = client
    resp = await ac.get("/api/v1/agents/some-agent/health")
    assert resp.status_code in (401, 403), (
        f"GET /agents/{{name}}/health must require auth, got {resp.status_code}"
    )


@pytest.mark.asyncio
async def test_list_agents_with_admin_key(client):
    """GET /agents succeeds with correct admin key."""
    ac, _ = client
    resp = await ac.get("/api/v1/agents", headers=ADMIN_HEADERS)
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_get_agent_health_invalid_name_returns_422(client):
    """Path param {name} with invalid k8s name characters must return 422."""
    ac, _ = client
    resp = await ac.get("/api/v1/agents/UPPERCASE_AGENT/health", headers=ADMIN_HEADERS)
    assert resp.status_code == 422


# ── MEDIUM: expiresAt must be populated in RegisterResponse ──────────────────

@pytest.mark.asyncio
async def test_register_response_includes_expires_at(client):
    """RegisterResponse.expiresAt must reflect the token's exp claim."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "exp-field-agent", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["expiresAt"] is not None, (
        "expiresAt must be set — tokens carry exp claims (regression from CRITICAL-3 fix)"
    )


# ── H5: health response must be schema-validated (no raw DB dict passthrough) ──

@pytest.mark.asyncio
async def test_get_health_strips_unknown_fields(registered):
    """Health response must be schema-validated — unexpected fields must be stripped."""
    ac, mock_upsert, agent_id, api_key = registered
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    # Include a field not in the HealthReport schema — it must not appear in the response
    health_with_extra = make_health("ready")
    health_with_extra["internal_api_key"] = "sk-sensitive-value"

    await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": health_with_extra, "gap": make_gap(90)}),
        headers=headers,
    )

    resp = await ac.get("/api/v1/agents/test-bedrock/health", headers=ADMIN_HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    # Unknown fields must not leak through the schema validation layer
    assert "internal_api_key" not in data, (
        "Schema validation must strip unknown fields from stored health reports"
    )
    # Known fields must still be present
    assert data["status"] == "ready"
    assert data["agentName"] == "test-bedrock"


@pytest.mark.asyncio
async def test_get_health_returns_most_recent(registered, monkeypatch):
    import api.heartbeat as hb_module
    monkeypatch.setattr(hb_module, "RATE_LIMIT_SECONDS", 0)

    ac, mock_upsert, agent_id, api_key = registered
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": make_health("degraded"), "gap": make_gap(50)}),
        headers=headers,
    )
    await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": make_health("ready"), "gap": make_gap(95)}),
        headers=headers,
    )

    resp = await ac.get("/api/v1/agents/test-bedrock/health", headers=ADMIN_HEADERS)
    assert resp.json()["status"] == "ready"
