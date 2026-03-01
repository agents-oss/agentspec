"""
Shared fixtures for the control-plane test suite.

- In-memory SQLite DB per test (no leakage)
- FastAPI dependency overrides: get_session → in-memory session
- JWT_SECRET + AGENTSPEC_ADMIN_KEY set before any import
- k8s.upsert.upsert_agent_observation mocked (no real cluster)
- ADMIN_KEY constant exported for test headers
- Rate-limit window cleared between tests
"""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Set secrets BEFORE importing app modules (fail-closed guards read these at import time)
os.environ.setdefault("JWT_SECRET", "unit-test-jwt-secret-do-not-use!")
os.environ.setdefault("AGENTSPEC_ADMIN_KEY", "test-admin-key-only")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

# Exported constant — use in every register call
ADMIN_KEY = os.environ["AGENTSPEC_ADMIN_KEY"]
ADMIN_HEADERS = {"X-Admin-Key": ADMIN_KEY}

from db.base import Base, get_session
from main import app

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture
async def db_engine():
    """Fresh in-memory SQLite engine, schema created and torn down per test."""
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_engine):
    """
    AsyncClient wired to the FastAPI app with:
      - in-memory SQLite DB (session rolls back on exception)
      - mocked k8s upsert
      - rate-limit window cleared
    """
    from api.heartbeat import _rate_window
    _rate_window.clear()

    session_factory = async_sessionmaker(db_engine, expire_on_commit=False)

    async def _override_get_session() -> AsyncSession:
        async with session_factory() as session:
            try:
                yield session
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_session] = _override_get_session

    with patch(
        "api.heartbeat.upsert_agent_observation", new_callable=AsyncMock
    ) as mock_upsert:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            yield ac, mock_upsert

    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def registered(client):
    """
    Pre-registers an agent and returns (client, mock_upsert, agent_id, api_key).

    Uses the ADMIN_HEADERS constant — safe to use in all heartbeat/agents tests.
    """
    ac, mock_upsert = client
    resp = await ac.post(
        "/api/v1/register",
        json={"agentName": "test-bedrock", "runtime": "bedrock"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200, f"Registration failed: {resp.text}"
    data = resp.json()
    return ac, mock_upsert, data["agentId"], data["apiKey"]


# ── Shared payload factories ──────────────────────────────────────────────────

def make_health(status: str = "ready") -> dict:
    return {
        "status": status,
        "source": "agent-sdk",
        "agentName": "test-bedrock",
        "timestamp": "2026-03-01T12:00:00Z",
        "summary": {"passed": 3, "failed": 0, "warnings": 0, "skipped": 0},
        "checks": [],
    }


def make_gap(score: int = 90) -> dict:
    return {
        "score": score,
        "issues": [],
        "source": "agent-sdk",
        "observed": {
            "hasHealthEndpoint": True,
            "hasCapabilitiesEndpoint": True,
            "upstreamTools": [],
        },
    }
