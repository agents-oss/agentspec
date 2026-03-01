"""
SQLAlchemy async engine + session factory.

DATABASE_URL env var selects backend:
  sqlite+aiosqlite:///:memory:         (test)
  postgresql+asyncpg://user:pass@host/db  (production)

DATABASE_URL is required — there is no SQLite default in production to prevent
accidentally persisting agent state to a local file in a stateless container.
"""
from __future__ import annotations

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL: str = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL environment variable is not set. "
        "Set it to a PostgreSQL connection string "
        "(e.g., postgresql+asyncpg://user:pass@host/db) or "
        "sqlite+aiosqlite:///:memory: for testing."
    )

# Engine is module-level so the connection pool is shared.
# Tests replace this by overriding the get_session dependency.
engine = create_async_engine(DATABASE_URL, echo=False)
_session_factory = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def init_db() -> None:
    """Create all tables. Called once at app startup."""
    # Import here to ensure models are registered with Base.metadata
    from db.models import Agent, Heartbeat  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency: yields an async DB session."""
    async with _session_factory() as session:
        yield session
