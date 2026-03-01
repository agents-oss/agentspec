"""
SQLAlchemy ORM models: Agent + Heartbeat.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.base import Base

MAX_HEARTBEATS_PER_AGENT = 100


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    runtime: Mapped[str] = mapped_column(String, nullable=False)
    manifest: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    api_key_hash: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    phase: Mapped[str] = mapped_column(String, default="Unknown", nullable=False)
    grade: Mapped[str] = mapped_column(String, default="F", nullable=False)
    score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    heartbeats: Mapped[list[Heartbeat]] = relationship(
        back_populates="agent",
        cascade="all, delete-orphan",
        order_by="Heartbeat.received_at",
    )


class Heartbeat(Base):
    __tablename__ = "heartbeats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String, ForeignKey("agents.id"), nullable=False, index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    health: Mapped[dict] = mapped_column(JSON, nullable=False)
    gap: Mapped[dict] = mapped_column(JSON, nullable=False)

    agent: Mapped[Agent] = relationship(back_populates="heartbeats")
