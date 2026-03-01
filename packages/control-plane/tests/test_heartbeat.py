"""
Tests for POST /api/v1/heartbeat.

Acceptance criteria (original):
  - Valid JWT + well-formed body → 204
  - Invalid / missing JWT → 401
  - Payload > 64 KB → 413
  - Rate limit (2 calls in < 10s) → 429
  - On success: k8s upsert is called once with correct agent name
  - Agent phase/grade/score updated in DB

Security acceptance criteria (CRITICAL-1):
  - Old token after key rotation → 401 (token revocation via jti hash check)
"""
from __future__ import annotations

import json

import pytest

from tests.conftest import ADMIN_HEADERS, make_gap, make_health


# ── Happy path ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_heartbeat_valid_jwt_returns_204(registered):
    ac, mock_upsert, agent_id, api_key = registered
    resp = await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": make_health(), "gap": make_gap(90)}),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_heartbeat_calls_k8s_upsert(registered):
    ac, mock_upsert, agent_id, api_key = registered
    await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": make_health(), "gap": make_gap(90)}),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    import asyncio
    await asyncio.sleep(0)
    mock_upsert.assert_called_once()
    assert mock_upsert.call_args.args[0] == "test-bedrock"


@pytest.mark.asyncio
async def test_heartbeat_updates_agent_stats(registered):
    ac, mock_upsert, agent_id, api_key = registered
    await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": make_health("ready"), "gap": make_gap(92)}),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    resp = await ac.get("/api/v1/agents", headers=ADMIN_HEADERS)
    agent = next(a for a in resp.json() if a["agentId"] == agent_id)
    assert agent["phase"] == "Healthy"
    assert agent["grade"] == "A"
    assert agent["score"] == 92


@pytest.mark.asyncio
async def test_heartbeat_degraded_agent(registered):
    ac, mock_upsert, agent_id, api_key = registered
    await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": make_health("degraded"), "gap": make_gap(55)}),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    resp = await ac.get("/api/v1/agents", headers=ADMIN_HEADERS)
    agent = next(a for a in resp.json() if a["agentId"] == agent_id)
    assert agent["phase"] == "Degraded"
    assert agent["grade"] == "D"


# ── CRITICAL-1: Token revocation via jti hash ─────────────────────────────────

@pytest.mark.asyncio
async def test_heartbeat_revoked_token_returns_401(client):
    """
    After key rotation, the OLD token must be rejected with 401.

    Steps:
      1. Register → get token1 (jti1 hash stored in DB)
      2. Re-register same agent → get token2 (jti2 hash replaces jti1 in DB)
      3. Heartbeat with token1 → 401 (jti1 hash no longer in DB)
      4. Heartbeat with token2 → 204
    """
    ac, _ = client

    # Step 1
    r1 = await ac.post(
        "/api/v1/register",
        json={"agentName": "revoke-test", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert r1.status_code == 200
    old_token = r1.json()["apiKey"]

    # Step 2 — key rotation
    r2 = await ac.post(
        "/api/v1/register",
        json={"agentName": "revoke-test", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert r2.status_code == 200
    new_token = r2.json()["apiKey"]

    assert old_token != new_token

    headers_old = {"Authorization": f"Bearer {old_token}", "Content-Type": "application/json"}
    headers_new = {"Authorization": f"Bearer {new_token}", "Content-Type": "application/json"}
    payload = json.dumps({"health": make_health(), "gap": make_gap()})

    # Step 3 — old token must be rejected
    resp_old = await ac.post("/api/v1/heartbeat", content=payload, headers=headers_old)
    assert resp_old.status_code == 401, (
        f"Old token after key rotation must be rejected (CRITICAL-1), got {resp_old.status_code}"
    )

    # Step 4 — new token must work
    resp_new = await ac.post("/api/v1/heartbeat", content=payload, headers=headers_new)
    assert resp_new.status_code == 204


# ── Auth failures ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_heartbeat_missing_auth_returns_401(client):
    ac, _ = client
    resp = await ac.post(
        "/api/v1/heartbeat",
        json={"health": make_health(), "gap": make_gap()},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_heartbeat_invalid_jwt_returns_401(client):
    ac, _ = client
    resp = await ac.post(
        "/api/v1/heartbeat",
        json={"health": make_health(), "gap": make_gap()},
        headers={"Authorization": "Bearer totally.invalid.token"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_heartbeat_tampered_jwt_returns_401(registered):
    ac, _, agent_id, api_key = registered
    parts = api_key.split(".")
    tampered = parts[0] + "." + parts[1] + ".invalidsignature"
    resp = await ac.post(
        "/api/v1/heartbeat",
        json={"health": make_health(), "gap": make_gap()},
        headers={"Authorization": f"Bearer {tampered}"},
    )
    assert resp.status_code == 401


# ── Payload size ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_heartbeat_payload_too_large_returns_413(registered):
    ac, _, agent_id, api_key = registered
    oversized_health = make_health()
    oversized_health["_padding"] = "x" * (65 * 1024)
    payload = json.dumps({"health": oversized_health, "gap": make_gap()})
    assert len(payload.encode()) > 64 * 1024

    resp = await ac.post(
        "/api/v1/heartbeat",
        content=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    assert resp.status_code == 413


# ── H1: Content-Length header must be checked before buffering body ───────────

@pytest.mark.asyncio
async def test_heartbeat_oversized_content_length_header_rejected(registered):
    """Content-Length header must be checked BEFORE buffering the request body.

    Sending a large Content-Length with a small body must return 413,
    proving the header check fires before body.read() is called.
    """
    from api.heartbeat import MAX_PAYLOAD_BYTES
    ac, _, agent_id, api_key = registered
    # Declare oversized Content-Length header but send a tiny body
    resp = await ac.post(
        "/api/v1/heartbeat",
        content=b"{}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Content-Length": str(MAX_PAYLOAD_BYTES + 1),
        },
    )
    # Must reject 413 based on Content-Length header before buffering body
    assert resp.status_code == 413, (
        f"Expected 413 for oversized Content-Length header, got {resp.status_code}"
    )


# ── Rate limiting ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_heartbeat_rate_limit_returns_429(registered, monkeypatch):
    ac, mock_upsert, agent_id, api_key = registered

    import api.heartbeat as hb_module
    monkeypatch.setattr(hb_module, "RATE_LIMIT_SECONDS", 1000)

    payload = json.dumps({"health": make_health(), "gap": make_gap()})
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    first = await ac.post("/api/v1/heartbeat", content=payload, headers=headers)
    assert first.status_code == 204

    second = await ac.post("/api/v1/heartbeat", content=payload, headers=headers)
    assert second.status_code == 429
