"""
POST /api/v1/heartbeat — receive health + gap data from a remote agent.

Security:
  - JWT auth (Bearer token, sub=agent_id)
  - CRITICAL-1: jti hash checked against DB — rejects rotated-away tokens
  - Rate limit: max 1 heartbeat per agent per RATE_LIMIT_SECONDS
  - Payload size limit: MAX_PAYLOAD_BYTES (64 KB)

Side effects on 204:
  1. Store Heartbeat row (prune to last MAX_HEARTBEATS_PER_AGENT per agent)
  2. Update Agent.last_seen / .phase / .grade / .score
  3. Fire-and-forget: upsert AgentObservation CR (errors logged, not re-raised)
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth.keys import hash_jti, verify_token
from db.base import get_session
from db.models import Agent, Heartbeat, MAX_HEARTBEATS_PER_AGENT
from k8s.upsert import build_status_patch, upsert_agent_observation
from schemas import HeartbeatRequest

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_PAYLOAD_BYTES = 64 * 1024  # 64 KB
RATE_LIMIT_SECONDS = 10
MAX_RATE_WINDOW_SIZE = 10_000  # bound memory: prune when exceeded

# Module-level rate-limit tracker: agent_id → last accepted monotonic timestamp.
# Tests clear this via conftest. Pruned when size exceeds MAX_RATE_WINDOW_SIZE.
_rate_window: dict[str, float] = {}

# Strong references to background tasks prevent GC before completion (Python docs warn
# that create_task() results can be garbage-collected if no reference is held).
_background_tasks: set[asyncio.Task] = set()


def _check_rate_limit(agent_id: str) -> None:
    now = time.monotonic()
    last = _rate_window.get(agent_id, 0.0)
    if now - last < RATE_LIMIT_SECONDS:
        logger.warning("Rate limit hit for agent %s", agent_id)
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: max 1 heartbeat per {RATE_LIMIT_SECONDS}s",
        )
    _rate_window[agent_id] = now
    # Prune stale entries to bound memory growth
    if len(_rate_window) > MAX_RATE_WINDOW_SIZE:
        cutoff = now - RATE_LIMIT_SECONDS
        stale = [k for k, v in _rate_window.items() if v < cutoff]
        for k in stale:
            del _rate_window[k]


async def _safe_upsert(agent_name: str, status_patch: dict) -> None:
    """Fire-and-forget k8s upsert wrapper — logs errors instead of swallowing them."""
    try:
        await upsert_agent_observation(agent_name, status_patch)
    except Exception:
        logger.exception("k8s upsert failed for agent '%s'", agent_name)


@router.post("/heartbeat", status_code=204)
async def heartbeat(
    request: Request,
    claims: dict = Depends(verify_token),
    session: AsyncSession = Depends(get_session),
) -> None:
    # 1. Payload size guard — check Content-Length header BEFORE buffering body
    # to prevent DoS via large body reads.
    content_length_header = request.headers.get("content-length")
    if content_length_header:
        try:
            declared_length = int(content_length_header)
        except ValueError:
            declared_length = 0
        if declared_length > MAX_PAYLOAD_BYTES:
            logger.warning(
                "Oversized heartbeat declared in Content-Length (%d bytes) rejected",
                declared_length,
            )
            raise HTTPException(status_code=413, detail="Payload too large: max 64 KB")

    body_bytes = await request.body()
    if len(body_bytes) > MAX_PAYLOAD_BYTES:
        logger.warning("Oversized heartbeat payload (%d bytes) rejected", len(body_bytes))
        raise HTTPException(status_code=413, detail="Payload too large: max 64 KB")

    # 2. Parse + validate
    data = HeartbeatRequest.model_validate_json(body_bytes)

    # 3. Resolve agent by sub claim
    agent_id: str = claims["sub"]
    result = await session.execute(select(Agent).where(Agent.id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=401, detail="Agent not found")

    # 4. CRITICAL-1: Revocation check — jti hash must match stored hash
    presented_jti: str = claims.get("jti", "")
    if hash_jti(presented_jti) != agent.api_key_hash:
        logger.warning("Revoked token presented for agent '%s'", agent.name)
        raise HTTPException(status_code=401, detail="Token has been revoked")

    # 5. Rate limit
    _check_rate_limit(agent_id)

    # 6. Derive phase / grade / score
    status_patch = build_status_patch(data.health, data.gap)
    now = datetime.now(timezone.utc)

    # 7. Persist heartbeat
    hb = Heartbeat(
        agent_id=agent_id,
        received_at=now,
        health=data.health,
        gap=data.gap,
        proof=data.proof,
    )
    session.add(hb)

    # 8. Update agent live stats
    agent.last_seen = now
    agent.phase = status_patch["phase"]
    agent.grade = status_patch["grade"]
    agent.score = status_patch["score"]

    await session.flush()

    # 9. Prune heartbeats > MAX_HEARTBEATS_PER_AGENT
    count_result = await session.execute(
        select(func.count()).where(Heartbeat.agent_id == agent_id)
    )
    total = count_result.scalar_one()
    if total > MAX_HEARTBEATS_PER_AGENT:
        oldest = await session.execute(
            select(Heartbeat.id)
            .where(Heartbeat.agent_id == agent_id)
            .order_by(Heartbeat.received_at.asc())
            .limit(total - MAX_HEARTBEATS_PER_AGENT)
        )
        old_ids = [row[0] for row in oldest.all()]
        await session.execute(delete(Heartbeat).where(Heartbeat.id.in_(old_ids)))

    await session.commit()
    logger.info(
        "Heartbeat accepted for '%s': phase=%s grade=%s score=%d",
        agent.name, status_patch["phase"], status_patch["grade"], status_patch["score"],
    )

    # 10. Fire-and-forget k8s upsert (errors logged, never block the response)
    task = asyncio.create_task(_safe_upsert(agent.name, status_patch))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
