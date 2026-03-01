"""
Tests for POST /api/v1/register.

Acceptance criteria (original):
  - Returns 200 with agentId + apiKey (valid JWT with exp + jti)
  - agentId has 'agt_' prefix
  - Duplicate registration returns 200 with a NEW key (key rotation)
  - Missing required fields → 422
  - Invalid runtime value → 422

Security acceptance criteria (CRITICAL-2, CRITICAL-3, CRITICAL-4):
  - No admin key → 403
  - Wrong admin key → 403
  - agentName with uppercase / spaces / special chars → 422
  - agentName longer than 63 chars → 422
  - Issued JWT must carry an exp claim
"""
from __future__ import annotations

import pytest
from jose import jwt

from tests.conftest import ADMIN_HEADERS, ADMIN_KEY


# ── Happy path ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_register_returns_agent_id_and_jwt(client):
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "bedrock-assistant", "runtime": "bedrock"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["agentId"].startswith("agt_")

    # Token must carry sub, jti, AND exp (CRITICAL-3)
    claims = jwt.get_unverified_claims(data["apiKey"])
    assert claims["sub"] == data["agentId"]
    assert "jti" in claims
    assert "exp" in claims, "JWT must have an exp claim (CRITICAL-3)"


@pytest.mark.asyncio
async def test_register_with_manifest(client):
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={
            "agentName": "vertex-agent",
            "runtime": "vertex",
            "manifest": {"spec": {"model": {"provider": "google"}}},
        },
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["agentId"].startswith("agt_")


# ── CRITICAL-2: Admin key enforcement ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_register_no_admin_key_returns_403(client):
    """Registration must be rejected when no admin key is provided."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "sneaky-agent", "runtime": "local"},
        # No X-Admin-Key header
    )
    assert resp.status_code == 403, f"Expected 403, got {resp.status_code}: {resp.text}"


@pytest.mark.asyncio
async def test_register_wrong_admin_key_returns_403(client):
    """Wrong admin key must be rejected with 403."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "sneaky-agent", "runtime": "local"},
        headers={"X-Admin-Key": "definitely-wrong"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_register_correct_admin_key_succeeds(client):
    """Correct admin key allows registration."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "valid-agent", "runtime": "local"},
        headers={"X-Admin-Key": ADMIN_KEY},
    )
    assert resp.status_code == 200


# ── CRITICAL-4: agentName must be k8s-safe ────────────────────────────────────

@pytest.mark.asyncio
async def test_register_agentname_uppercase_returns_422(client):
    """Uppercase letters are not valid in k8s resource names."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "MyAgent", "runtime": "bedrock"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_register_agentname_with_spaces_returns_422(client):
    """Spaces are not valid in k8s resource names."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "my agent", "runtime": "bedrock"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_register_agentname_special_chars_returns_422(client):
    """Special characters are not valid in k8s resource names."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "agent@bedrock!", "runtime": "bedrock"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_register_agentname_too_long_returns_422(client):
    """k8s resource names are limited to 63 characters."""
    ac, _ = client
    long_name = "a" * 64
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": long_name, "runtime": "bedrock"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("name", [
    "valid-name",
    "agent123",
    "a",
    "a1b2c3",
    "my-bedrock-agent",
])
async def test_register_valid_agentname_patterns(client, name):
    """Valid k8s names (lowercase alphanumeric + hyphens) must be accepted."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": name, "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200, f"Expected 200 for name '{name}', got {resp.status_code}"


@pytest.mark.asyncio
async def test_register_agentname_starting_with_hyphen_returns_422(client):
    """k8s names must start with alphanumeric."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "-bad-start", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_register_agentname_ending_with_hyphen_returns_422(client):
    """k8s names must end with alphanumeric."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "bad-end-", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 422


# ── CRITICAL-3: JWT expiry ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_register_jwt_has_exp_claim(client):
    """Issued JWT must have an expiration claim."""
    import time
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "exp-test-agent", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200
    token = resp.json()["apiKey"]
    claims = jwt.get_unverified_claims(token)
    assert "exp" in claims
    assert claims["exp"] > time.time() + 86400  # at least 24h validity


# ── H2: agent_id must use full UUID hex (not truncated) ───────────────────────

@pytest.mark.asyncio
async def test_agent_id_is_full_uuid_not_truncated(client):
    """agent_id must be 'agt_' + 32-char UUID hex (128-bit), not a truncated prefix."""
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "uuid-test-agent", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200
    agent_id = resp.json()["agentId"]
    # "agt_" (4) + full UUID hex (32) = 36 characters
    assert len(agent_id) == 36, (
        f"agent_id must be 'agt_' + 32-char UUID hex, got {len(agent_id)} chars: {agent_id!r}"
    )
    hex_part = agent_id[4:]  # strip "agt_" prefix
    assert len(hex_part) == 32 and all(c in "0123456789abcdef" for c in hex_part), (
        f"UUID hex part must be 32 lowercase hex chars, got: {hex_part!r}"
    )


# ── Idempotency / key rotation ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_register_duplicate_returns_new_key(client):
    ac, _ = client
    first = await ac.post(
        "/api/v1/register",
        json={"agentName": "dup-agent", "runtime": "docker"},
        headers=ADMIN_HEADERS,
    )
    second = await ac.post(
        "/api/v1/register",
        json={"agentName": "dup-agent", "runtime": "docker"},
        headers=ADMIN_HEADERS,
    )

    assert first.status_code == 200
    assert second.status_code == 200

    first_data, second_data = first.json(), second.json()
    assert first_data["agentId"] == second_data["agentId"]
    assert first_data["apiKey"] != second_data["apiKey"]


# ── Validation errors ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_register_missing_agent_name(client):
    ac, _ = client
    resp = await ac.post("/api/v1/register", json={"runtime": "bedrock"}, headers=ADMIN_HEADERS)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_register_missing_runtime(client):
    ac, _ = client
    resp = await ac.post("/api/v1/register", json={"agentName": "foo-agent"}, headers=ADMIN_HEADERS)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_register_invalid_runtime(client):
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "foo-agent", "runtime": "sagemaker"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_register_empty_agent_name(client):
    ac, _ = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "", "runtime": "local"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 422
