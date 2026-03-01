"""
JWT issuance and verification for the control plane API.

Algorithm:  HS256
Secret:     JWT_SECRET env var (fail-closed if unset)
Expiry:     TOKEN_EXPIRY_DAYS (default 30 days)
Claims:     sub=agent_id, jti=uuid4, iat, exp
Revocation: jti stored as SHA-256 hash in Agent.api_key_hash;
            heartbeat handler checks hash on every request.
Admin auth: AGENTSPEC_ADMIN_KEY env var gates POST /register.
            Fail-closed: raises 503 if env var is not set.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Header, HTTPException
from jose import JWTError, jwt

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"
TOKEN_EXPIRY_DAYS = 30


def _secret() -> str:
    secret = os.environ.get("JWT_SECRET")
    if not secret:
        raise RuntimeError(
            "JWT_SECRET environment variable is not set. "
            "Set it to a long random string before starting the control plane."
        )
    if len(secret) < 32:
        raise RuntimeError(
            f"JWT_SECRET is too short ({len(secret)} chars). "
            "Set JWT_SECRET to a random string of at least 32 characters."
        )
    return secret


def issue_token(agent_id: str) -> tuple[str, str]:
    """
    Issue a JWT scoped to agent_id.

    Returns:
        (token, jti) — store hash_jti(jti) in the DB for revocation.
    """
    jti = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    payload = {
        "sub": agent_id,
        "jti": jti,
        "iat": now,
        "exp": now + timedelta(days=TOKEN_EXPIRY_DAYS),
    }
    token = jwt.encode(payload, _secret(), algorithm=ALGORITHM)
    return token, jti


def hash_jti(jti: str) -> str:
    """SHA-256 hash of the JWT ID — stored in DB for revocation lookup."""
    return hashlib.sha256(jti.encode()).hexdigest()


def verify_token(authorization: str | None = Header(default=None)) -> dict:
    """
    FastAPI dependency. Extracts and validates Bearer JWT.

    Returns decoded claims dict on success.
    Raises HTTP 401 on missing header, bad format, or invalid signature.
    The caller is responsible for checking jti hash against the DB
    (revocation check) after resolving the agent.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401, detail="Missing or invalid Authorization header"
        )
    token = authorization[len("Bearer "):]
    try:
        claims: dict = jwt.decode(token, _secret(), algorithms=[ALGORITHM])
        return claims
    except JWTError as exc:
        logger.warning("JWT verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc


def verify_admin_key(x_admin_key: str | None = Header(default=None, alias="X-Admin-Key")) -> None:
    """
    FastAPI dependency for POST /register, GET /agents, GET /agents/{name}/health.

    Fail-closed: if AGENTSPEC_ADMIN_KEY is not configured, raises HTTP 503 so
    the service does not inadvertently expose admin endpoints. There is no
    development bypass — use the env var in all environments.

    If AGENTSPEC_ADMIN_KEY is set, the X-Admin-Key header must match exactly
    using a constant-time comparison to prevent timing side-channel attacks.
    """
    admin_key = os.environ.get("AGENTSPEC_ADMIN_KEY")
    if admin_key is None:
        logger.error(
            "AGENTSPEC_ADMIN_KEY is not set. "
            "Admin endpoints are disabled. Set this variable to enable them."
        )
        raise HTTPException(
            status_code=503,
            detail="Service not configured: AGENTSPEC_ADMIN_KEY is not set",
        )
    # Constant-time comparison to prevent timing side-channel attacks
    if not x_admin_key or not hmac.compare_digest(x_admin_key, admin_key):
        raise HTTPException(status_code=403, detail="Invalid or missing admin key")
