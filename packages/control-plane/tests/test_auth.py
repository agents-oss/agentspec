"""
Unit tests for auth/keys.py — RED phase for CRITICAL-1, CRITICAL-3, HIGH-3.

These tests define the DESIRED interface BEFORE implementation is changed.
They will FAIL until the implementation is updated.

Desired interface:
  issue_token(agent_id) -> tuple[str, str]   # (token, jti)
  hash_jti(jti: str) -> str                  # SHA-256 of jti only
  verify_admin_key(...)                       # FastAPI dependency
"""
from __future__ import annotations

import hashlib
import os

import pytest
from jose import jwt


# ── CRITICAL-3: JWT must have exp + iat claims ─────────────────────────────────

def test_issue_token_returns_tuple(monkeypatch):
    """issue_token must return (token, jti) tuple — not just a string."""
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import issue_token

    result = issue_token("agt_abc123")
    assert isinstance(result, tuple), "issue_token must return (token, jti)"
    assert len(result) == 2
    token, jti = result
    assert isinstance(token, str)
    assert isinstance(jti, str)


def test_issue_token_has_exp_claim(monkeypatch):
    """JWT must carry an exp claim — non-expiring tokens are a security risk."""
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import issue_token

    token, _ = issue_token("agt_abc123")
    claims = jwt.get_unverified_claims(token)
    assert "exp" in claims, "JWT must have an exp claim"


def test_issue_token_has_iat_claim(monkeypatch):
    """JWT must carry an iat (issued-at) claim."""
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import issue_token

    token, _ = issue_token("agt_abc123")
    claims = jwt.get_unverified_claims(token)
    assert "iat" in claims, "JWT must have an iat claim"


def test_issue_token_exp_is_in_the_future(monkeypatch):
    """exp must be at least 24h from now."""
    import time
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import issue_token

    token, _ = issue_token("agt_abc123")
    claims = jwt.get_unverified_claims(token)
    assert claims["exp"] > time.time() + 86400, "exp must be > 24h from now"


def test_issue_token_jti_matches_returned_jti(monkeypatch):
    """The jti in the JWT payload must match the second element of the tuple."""
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import issue_token

    token, jti = issue_token("agt_abc123")
    claims = jwt.get_unverified_claims(token)
    assert claims["jti"] == jti


# ── HIGH-3: hash_jti must hash the JTI claim, not the full token ──────────────

def test_hash_jti_exists(monkeypatch):
    """hash_jti function must exist in auth.keys."""
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth import keys
    assert hasattr(keys, "hash_jti"), "auth.keys must export hash_jti()"


def test_hash_jti_is_deterministic(monkeypatch):
    """Same jti must always produce same hash."""
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import hash_jti

    jti = "550e8400-e29b-41d4-a716-446655440000"
    assert hash_jti(jti) == hash_jti(jti)


def test_hash_jti_is_sha256_of_jti(monkeypatch):
    """hash_jti must be SHA-256 of the jti string."""
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import hash_jti

    jti = "my-jti-value"
    expected = hashlib.sha256(jti.encode()).hexdigest()
    assert hash_jti(jti) == expected


def test_hash_jti_differs_from_full_token_hash(monkeypatch):
    """hash_jti(jti) must NOT equal sha256(full_token)."""
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import hash_jti, issue_token

    token, jti = issue_token("agt_abc123")
    full_token_hash = hashlib.sha256(token.encode()).hexdigest()
    jti_hash = hash_jti(jti)
    assert jti_hash != full_token_hash, (
        "hash_jti must hash the jti claim only, not the entire JWT string"
    )


# ── CRITICAL-2: verify_admin_key dependency must exist ────────────────────────

def test_verify_admin_key_exists(monkeypatch):
    """verify_admin_key FastAPI dependency must exist in auth.keys."""
    from auth import keys
    assert hasattr(keys, "verify_admin_key"), "auth.keys must export verify_admin_key"


def test_verify_admin_key_raises_403_when_key_wrong(monkeypatch):
    """verify_admin_key must raise HTTP 403 when the header doesn't match."""
    monkeypatch.setenv("AGENTSPEC_ADMIN_KEY", "correct-key")
    from fastapi import HTTPException
    from auth.keys import verify_admin_key
    import importlib
    import auth.keys as keys_mod
    importlib.reload(keys_mod)
    from auth.keys import verify_admin_key

    with pytest.raises(HTTPException) as exc_info:
        verify_admin_key(x_admin_key="wrong-key")
    assert exc_info.value.status_code == 403


def test_verify_admin_key_passes_with_correct_key(monkeypatch):
    """verify_admin_key must NOT raise when the header matches."""
    monkeypatch.setenv("AGENTSPEC_ADMIN_KEY", "correct-key")
    from auth.keys import verify_admin_key

    # Should not raise
    verify_admin_key(x_admin_key="correct-key")


def test_verify_admin_key_raises_403_when_missing(monkeypatch):
    """verify_admin_key must raise 403 when header absent and key is configured."""
    monkeypatch.setenv("AGENTSPEC_ADMIN_KEY", "secret")
    from fastapi import HTTPException
    from auth.keys import verify_admin_key

    with pytest.raises(HTTPException) as exc_info:
        verify_admin_key(x_admin_key=None)
    assert exc_info.value.status_code == 403


# ── HIGH (new): timing-safe admin key comparison ──────────────────────────────

def test_verify_admin_key_uses_constant_time_comparison(monkeypatch):
    """
    verify_admin_key must use hmac.compare_digest — not plain string equality.

    We can't directly measure timing, so we verify the implementation uses
    hmac.compare_digest by inspecting the source or asserting the import is present.
    """
    import inspect
    import hmac
    monkeypatch.setenv("AGENTSPEC_ADMIN_KEY", "secret")
    from auth import keys
    import importlib
    importlib.reload(keys)

    source = inspect.getsource(keys.verify_admin_key)
    assert "compare_digest" in source, (
        "verify_admin_key must use hmac.compare_digest() for timing-safe comparison"
    )


# ── MEDIUM (regression): expiresAt must be populated ─────────────────────────

def test_issue_token_expiry_matches_token_exp_claim(monkeypatch):
    """
    The exp claim in the token must match TOKEN_EXPIRY_DAYS.
    This indirectly tests that RegisterResponse.expiresAt can be correctly derived.
    """
    import time
    monkeypatch.setenv("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
    from auth.keys import TOKEN_EXPIRY_DAYS, issue_token

    token, _ = issue_token("agt_abc")
    claims = jwt.get_unverified_claims(token)
    expected_exp = time.time() + TOKEN_EXPIRY_DAYS * 86400
    # Allow ±5 seconds for test execution time
    assert abs(claims["exp"] - expected_exp) < 5


# ── CRITICAL-2 (NEW): verify_admin_key must fail closed when env var is unset ─

def test_verify_admin_key_raises_when_env_var_not_set(monkeypatch):
    """
    CRITICAL-2: When AGENTSPEC_ADMIN_KEY is not configured at all,
    verify_admin_key must NOT silently pass. It must raise an exception
    (either HTTPException or RuntimeError) to prevent open access.
    """
    monkeypatch.delenv("AGENTSPEC_ADMIN_KEY", raising=False)
    import importlib
    import auth.keys as keys_mod
    importlib.reload(keys_mod)
    from auth.keys import verify_admin_key

    with pytest.raises(Exception):  # HTTPException(503) or RuntimeError
        verify_admin_key(x_admin_key=None)


def test_verify_admin_key_raises_when_env_var_not_set_even_with_key_provided(monkeypatch):
    """
    CRITICAL-2: Even if a key is provided in the header, if AGENTSPEC_ADMIN_KEY
    is not configured, the request must be rejected (no way to validate it).
    """
    monkeypatch.delenv("AGENTSPEC_ADMIN_KEY", raising=False)
    import importlib
    import auth.keys as keys_mod
    importlib.reload(keys_mod)
    from auth.keys import verify_admin_key

    with pytest.raises(Exception):
        verify_admin_key(x_admin_key="some-key")


# ── CRITICAL-3 (NEW): JWT error must not leak exception details ───────────────

@pytest.mark.asyncio
async def test_invalid_jwt_error_does_not_leak_exception_details(client):
    """
    CRITICAL-3: When an invalid JWT is sent, the 401 response body must NOT
    contain the raw JWTError exception text (e.g., 'Signature verification failed').
    The detail must be a generic message only.
    """
    import json
    from tests.conftest import make_gap, make_health
    ac, _ = client

    resp = await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": make_health(), "gap": make_gap()}),
        headers={
            "Authorization": "Bearer totally.invalid.token",
            "Content-Type": "application/json",
        },
    )
    assert resp.status_code == 401
    detail = resp.json().get("detail", "")
    # Must not expose the raw exception message (e.g., "Signature verification failed")
    assert "JWTError" not in detail
    assert "Signature" not in detail
    assert "verification" not in detail
    assert "Exception" not in detail
    # Must be a short, generic message
    assert len(detail) < 100, f"Error detail too long — may be leaking info: {detail!r}"


# ── C3 (NEW): JWT_SECRET must be at least 32 characters ──────────────────────

def test_jwt_secret_too_short_raises_runtime_error(monkeypatch):
    """JWT_SECRET shorter than 32 chars must raise RuntimeError at use time."""
    monkeypatch.setenv("JWT_SECRET", "a" * 31)
    import importlib
    import auth.keys as keys_mod
    importlib.reload(keys_mod)
    from auth.keys import issue_token
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        issue_token("agt_test")


def test_jwt_secret_exactly_32_chars_accepted(monkeypatch):
    """JWT_SECRET of exactly 32 characters must be accepted (boundary)."""
    monkeypatch.setenv("JWT_SECRET", "a" * 32)
    import importlib
    import auth.keys as keys_mod
    importlib.reload(keys_mod)
    from auth.keys import issue_token
    token, jti = issue_token("agt_test")
    assert isinstance(token, str)
    assert isinstance(jti, str)


# ── LOW: expired JWT must be rejected ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_heartbeat_expired_jwt_returns_401(client):
    """An expired JWT must be rejected with 401 — python-jose enforces exp claim."""
    import os
    from datetime import datetime, timedelta, timezone
    from jose import jwt as jose_jwt

    ac, _ = client
    secret = os.environ["JWT_SECRET"]
    payload = {
        "sub": "agt_fake123",
        "jti": "fake-jti-expired",
        "iat": datetime.now(timezone.utc) - timedelta(days=60),
        "exp": datetime.now(timezone.utc) - timedelta(days=30),
    }
    expired_token = jose_jwt.encode(payload, secret, algorithm="HS256")

    import json
    from tests.conftest import make_gap, make_health
    resp = await ac.post(
        "/api/v1/heartbeat",
        content=json.dumps({"health": make_health(), "gap": make_gap()}),
        headers={
            "Authorization": f"Bearer {expired_token}",
            "Content-Type": "application/json",
        },
    )
    assert resp.status_code == 401, f"Expired JWT must be rejected, got {resp.status_code}"
