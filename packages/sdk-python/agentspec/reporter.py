"""
AgentSpecReporter — Python agent-side SDK module.

Runs live health checks and optionally self-reports to the AgentSpec control
plane via startPushMode().  Works in both sync and async environments:

- Sync (no running event loop): uses threading.Timer (daemon) so the process
  can still exit cleanly.
- Async (running event loop detected): uses asyncio.create_task().
"""

from __future__ import annotations

import asyncio
import os
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

import httpx

from .manifest import load_manifest
from .types import HealthCheck, HealthReport


class AgentSpecReporter:
    """Runs health checks and optionally pushes heartbeats to the control plane."""

    def __init__(self, manifest: Dict[str, Any]) -> None:
        self._manifest = manifest
        self._active = False
        self._timer: Optional[threading.Timer] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._control_plane_url = ""
        self._api_key = ""
        self._interval_seconds = 30
        self._on_error: Optional[Callable[[Exception], None]] = None

    @classmethod
    def from_yaml(cls, path: str) -> "AgentSpecReporter":
        """Create a reporter from an agent.yaml file path."""
        return cls(manifest=load_manifest(path))

    # ── Health check ──────────────────────────────────────────────────────────

    def get_report(self) -> HealthReport:
        """
        Run live health checks and return a HealthReport.
        Phase 4: minimal implementation — env var presence only.
        """
        checks: list[HealthCheck] = []
        passed = 0
        failed = 0

        # Check model API key env var
        model = self._manifest.get("spec", {}).get("model", {})
        api_key_ref: str = model.get("apiKey", "")
        if api_key_ref.startswith("$env:"):
            env_var = api_key_ref[5:]
            if os.environ.get(env_var):
                checks.append(
                    HealthCheck(
                        id=f"env:{env_var}",
                        category="env",
                        status="pass",
                        severity="error",
                    )
                )
                passed += 1
            else:
                checks.append(
                    HealthCheck(
                        id=f"env:{env_var}",
                        category="env",
                        status="fail",
                        severity="error",
                        message=f"Environment variable {env_var} is not set",
                    )
                )
                failed += 1

        status: str
        if failed > 0:
            status = "unhealthy"
        else:
            status = "healthy"

        return HealthReport(
            agent_name=self._manifest["metadata"]["name"],
            timestamp=datetime.now(timezone.utc).isoformat(),
            status=status,  # type: ignore[arg-type]
            summary={"passed": passed, "failed": failed, "warnings": 0, "skipped": 0},
            checks=checks,
        )

    # ── Push mode ─────────────────────────────────────────────────────────────

    def start_push_mode(
        self,
        control_plane_url: str,
        api_key: str,
        interval_seconds: int = 30,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        """
        Start sending heartbeats to the control plane.

        Auto-detects runtime:
        - Running event loop → asyncio.create_task()
        - No event loop → threading.Timer(daemon=True)

        Idempotent: calling twice has no effect.
        """
        if self._active:
            return

        self._active = True
        self._control_plane_url = control_plane_url
        self._api_key = api_key
        self._interval_seconds = interval_seconds
        self._on_error = on_error

        try:
            asyncio.get_running_loop()
            # Async mode: schedule with asyncio
            self._task = asyncio.create_task(self._async_push_loop())
        except RuntimeError:
            # Sync mode: fire immediately, then use threading.Timer to repeat
            self._fire_and_reschedule()

    def stop_push_mode(self) -> None:
        """Stop sending heartbeats to the control plane."""
        self._active = False
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._task is not None:
            self._task.cancel()
            self._task = None

    def is_push_mode_active(self) -> bool:
        """Returns True if heartbeats are currently being sent."""
        return self._active

    # ── Internals ─────────────────────────────────────────────────────────────

    def _fire_and_reschedule(self) -> None:
        """Run one push synchronously, then schedule the next via threading.Timer."""
        if not self._active:
            return
        self._push_sync()
        if self._active:
            self._timer = threading.Timer(self._interval_seconds, self._fire_and_reschedule)
            self._timer.daemon = True
            self._timer.start()

    def _push_sync(self) -> None:
        """Send one heartbeat synchronously via httpx."""
        health = self.get_report()
        payload = {"health": health.model_dump(), "gap": {}}
        try:
            resp = httpx.post(
                f"{self._control_plane_url}/api/v1/heartbeat",
                json=payload,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                timeout=10.0,
            )
            if resp.status_code >= 400 and self._on_error:
                self._on_error(
                    Exception(f"Heartbeat failed: HTTP {resp.status_code}")
                )
        except Exception as exc:
            if self._on_error:
                msg = str(exc).replace(self._api_key, "[REDACTED]")
                self._on_error(Exception(msg))

    async def _async_push_loop(self) -> None:
        """Async loop: push, sleep, repeat until stopped."""
        while self._active:
            await self._push_async()
            await asyncio.sleep(self._interval_seconds)

    async def _push_async(self) -> None:
        """Send one heartbeat asynchronously via httpx."""
        health = self.get_report()
        payload = {"health": health.model_dump(), "gap": {}}
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._control_plane_url}/api/v1/heartbeat",
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    timeout=10.0,
                )
                if resp.status_code >= 400 and self._on_error:
                    self._on_error(
                        Exception(f"Heartbeat failed: HTTP {resp.status_code}")
                    )
        except Exception as exc:
            if self._on_error:
                msg = str(exc).replace(self._api_key, "[REDACTED]")
                self._on_error(Exception(msg))
