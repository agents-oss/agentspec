"""
POST /api/v1/register — register a new agent and issue a JWT API key.

Security:
  - Requires X-Admin-Key header (AGENTSPEC_ADMIN_KEY env var)
  - agentName is validated as a k8s-safe name (schema-level)
  - On duplicate name: key rotation (new jti, new token, old jti invalidated)
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth.keys import TOKEN_EXPIRY_DAYS, hash_jti, issue_token, verify_admin_key
from db.base import get_session
from db.models import Agent
from schemas import RegisterRequest, RegisterResponse

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post(
    "/register",
    response_model=RegisterResponse,
    status_code=200,
    dependencies=[Depends(verify_admin_key)],
)
async def register(
    body: RegisterRequest,
    session: AsyncSession = Depends(get_session),
) -> RegisterResponse:
    """
    Register an agent (idempotent by agentName).

    If the agent name already exists, perform key rotation:
    issue a fresh token, store its jti hash, invalidating the previous token.
    """
    now = datetime.now(timezone.utc)

    result = await session.execute(select(Agent).where(Agent.name == body.agentName))
    existing = result.scalar_one_or_none()

    expires_at = now + timedelta(days=TOKEN_EXPIRY_DAYS)

    if existing is not None:
        # Key rotation — new jti hash replaces old, old token is revoked
        new_token, new_jti = issue_token(existing.id)
        existing.api_key_hash = hash_jti(new_jti)
        await session.commit()
        logger.info("Key rotated for agent '%s' (id=%s)", existing.name, existing.id)
        return RegisterResponse(agentId=existing.id, apiKey=new_token, expiresAt=expires_at)

    agent_id = f"agt_{uuid.uuid4().hex}"
    token, jti = issue_token(agent_id)

    agent = Agent(
        id=agent_id,
        name=body.agentName,
        runtime=body.runtime,
        manifest=body.manifest,
        api_key_hash=hash_jti(jti),
        created_at=now,
        phase="Unknown",
        grade="F",
        score=0,
    )
    session.add(agent)
    await session.commit()
    logger.info("Registered new agent '%s' (id=%s, runtime=%s)", body.agentName, agent_id, body.runtime)

    return RegisterResponse(agentId=agent_id, apiKey=token, expiresAt=expires_at)
