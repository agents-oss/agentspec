"""
AgentSpec Control Plane — FastAPI application entry point.

Endpoints:
  POST /api/v1/register
  POST /api/v1/heartbeat
  GET  /api/v1/agents
  GET  /api/v1/agents/{name}/health
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from api import agents, heartbeat, register
from db.base import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="AgentSpec Control Plane",
    version="0.1.0",
    description=(
        "Receiver for remote agents (Bedrock, Vertex, Docker, local) "
        "that cannot host an in-cluster sidecar."
    ),
    lifespan=lifespan,
)

app.include_router(register.router, prefix="/api/v1")
app.include_router(heartbeat.router, prefix="/api/v1")
app.include_router(agents.router, prefix="/api/v1")
