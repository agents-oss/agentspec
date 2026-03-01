# Phase 6 — `RemoteAgentWatcher` (Operator reads control plane → upserts CRs)

**Status: ✅ DONE**
**Depends on:** Phase 1 (operator), Phase 3 (control plane), Phase 4 (SDK push mode)

---

## Goal

Complete the cross-runtime visibility loop: the Kopf operator gains a second reconciler —
`RemoteAgentWatcher` — that polls the control plane's `GET /api/v1/agents` and upserts
`AgentObservation` CRs in the `agentspec-remote` namespace. Remote agents (Bedrock, Vertex,
Docker, local) appear in k9s `:ao` **without any manual CR creation**.

This is the final phase of Phase 1's MVP promise: **one table, all agents, any runtime**.

---

## Why This Phase

After Phase 3 + 4, the control plane knows about remote agents and they push heartbeats.
But those agents don't yet appear in k9s — there's nothing to create the CRs. This phase
bridges that gap: the operator watches the control plane and keeps `agentspec-remote` CRs
in sync with the control plane's registry.

Phase 6 also adds `spec.source = "control-plane"` handling to the existing daemon:
for CRs created by `RemoteAgentWatcher`, the daemon skips the sidecar HTTP probe and
instead relies on `.status` already set by the control plane heartbeat upsert.

---

## Deliverables

| Deliverable | File(s) | Status |
|-------------|---------|--------|
| `RemoteAgentWatcher` class | `packages/operator/remote_watcher.py` | ✅ |
| Operator startup integration | `packages/operator/operator.py` (update) | ✅ |
| Daemon: skip probe for `source=control-plane` | `packages/operator/operator.py` (update) | ✅ |
| `agentspec-remote` namespace template | `helm/.../templates/namespace.yaml` (update) | ✅ |
| RBAC update (watch remote namespace) | `helm/.../templates/clusterrole.yaml` (update) | ✅ |
| Helm values for control plane URL | `helm/.../values.yaml` (update) | ✅ |
| Unit tests | `packages/operator/tests/test_remote_watcher.py` | ✅ |
| UAT guide update (wow-5) | `packages/operator/uat/wow-5-cross-runtime.md` (update) | ✅ |

---

## Files to Create / Modify

### New files
- `packages/operator/remote_watcher.py` — `RemoteAgentWatcher` class

### Modified files
- `packages/operator/operator.py`
  - `@kopf.on.startup()` — start `RemoteAgentWatcher` as asyncio task
  - `@kopf.on.cleanup()` — stop watcher on shutdown
  - `reconcile_agent_health` daemon — check `spec.get('source') == 'control-plane'` → skip probe
- `packages/operator/helm/agentspec-operator/templates/clusterrole.yaml`
  - Add `agentspec-remote` namespace read/write to ClusterRole
- `packages/operator/helm/agentspec-operator/values.yaml`
  - Add `controlPlane:` section (url, pollInterval, enabled)
- `packages/operator/tests/` — add `test_remote_watcher.py`

---

## Architecture

```
Control plane  (Phase 3)
  GET /api/v1/agents  →  [{ agentId, agentName, runtime, phase, grade, score, lastSeen }]
       ↑  poll every 30s
RemoteAgentWatcher  (background asyncio task in operator pod)
       ↓
For each agent in list:
  If CR exists in agentspec-remote → compare lastSeen, skip if unchanged
  If CR missing → create AgentObservation CR (spec.source = "control-plane")
  If agent disappeared from list → delete CR (optional: keep with phase=Unknown)
       ↓
Kopf operator CR event loop:
  New CR (source=control-plane) → on_agent_observed() → Pending status
  Daemon: spec.source == "control-plane" → SKIP probe loop
    (status is managed entirely by control-plane heartbeat upserts)
       ↓
k9s :ao  →  remote agents appear alongside in-cluster agents
```

### `RemoteAgentWatcher` class

```python
# packages/operator/remote_watcher.py

class RemoteAgentWatcher:
    """
    Background asyncio task that polls the control plane and keeps
    AgentObservation CRs in agentspec-remote namespace in sync.
    """

    def __init__(
        self,
        control_plane_url: str,
        api_key: str,
        poll_interval: int = 30,
        namespace: str = "agentspec-remote",
    ) -> None:
        self._url = control_plane_url
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._interval = poll_interval
        self._namespace = namespace
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the background watcher task."""
        self._task = asyncio.create_task(self._watch_loop())

    async def stop(self) -> None:
        """Cancel and await the background task."""
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _watch_loop(self) -> None:
        while True:
            try:
                await self._sync_once()
            except Exception as exc:
                logger.warning(f"RemoteAgentWatcher: sync failed — {exc}")
            await asyncio.sleep(self._interval)

    async def _sync_once(self) -> None:
        agents = await self._fetch_agents()
        existing = await self._list_existing_crs()
        await self._reconcile(agents, existing)

    async def _fetch_agents(self) -> list[dict]: ...
    async def _list_existing_crs(self) -> set[str]: ...
    async def _upsert_cr(self, agent: dict) -> None: ...
    async def _reconcile(self, agents: list[dict], existing: set[str]) -> None: ...
```

### Operator startup integration

```python
# packages/operator/operator.py (additions)

_remote_watcher: RemoteAgentWatcher | None = None

@kopf.on.startup()
async def startup(settings: kopf.OperatorSettings, **kwargs):
    global _remote_watcher
    settings.posting.level = logging.WARNING
    settings.persistence.finalizer = "agentspec.io/operator-finalizer"

    cp_url = os.getenv("CONTROL_PLANE_URL")
    cp_key = os.getenv("CONTROL_PLANE_KEY")
    if cp_url and cp_key:
        _remote_watcher = RemoteAgentWatcher(cp_url, cp_key)
        await _remote_watcher.start()
        logger.info(f"RemoteAgentWatcher started → {cp_url}")
    else:
        logger.info("RemoteAgentWatcher disabled (CONTROL_PLANE_URL not set)")

@kopf.on.cleanup()
async def cleanup(**kwargs):
    if _remote_watcher:
        await _remote_watcher.stop()
```

### Daemon: skip probe for `source=control-plane`

```python
# packages/operator/operator.py — reconcile_agent_health daemon (addition)

@kopf.daemon("agentobservations", initial_delay=5.0, cancellation_timeout=5.0)
async def reconcile_agent_health(spec, name, namespace, logger, patch, stopped, **kwargs):
    # NEW: CRs created by RemoteAgentWatcher don't need a sidecar probe
    if spec.get("source") == "control-plane":
        logger.debug(f"[{name}] source=control-plane — skipping probe, status managed by heartbeat")
        await stopped.wait(3600)   # sleep indefinitely, wake on CR delete
        return

    # existing probe logic unchanged...
    try:
        base_url = _sidecar_url(spec, name, namespace)
    except ValueError as exc:
        raise kopf.PermanentError(str(exc)) from exc

    while not stopped:
        interval = int(spec.get("checkInterval", 30))
        timeout = min(interval // 2, 20)
        await _run_probe(name, base_url, timeout, patch, logger)
        await stopped.wait(interval)
```

---

## CRD: `spec.source` field addition

Update `crds/agentobservation.yaml` to add `spec.source`:

```yaml
spec:
  source:
    type: string
    description: "'sidecar' (default, operator probes) or 'control-plane' (heartbeat-driven)"
    default: sidecar
    enum: [sidecar, control-plane]
```

---

## Helm Values Addition

```yaml
# values.yaml additions

controlPlane:
  # Set to enable RemoteAgentWatcher (connects operator to control plane)
  enabled: false
  url: ""            # e.g. https://control-plane.agentspec.io
  apiKey: ""         # or reference a Secret: secretRef: { name: cp-key, key: apiKey }
  pollInterval: 30   # seconds between /api/v1/agents polls
  namespace: agentspec-remote   # namespace for remote agent CRs
```

---

## Acceptance Criteria

- [x] `RemoteAgentWatcher` polls `GET /api/v1/agents` at `pollInterval` interval
- [x] New agent in control plane → CR created in `agentspec-remote` within 35s
- [x] Agent removed from control plane → CR deleted (or phase set to Unknown)
- [x] Daemon skips probe for `spec.source == "control-plane"` CRs
- [x] CRs created by watcher have `spec.source = "control-plane"`
- [x] `CONTROL_PLANE_URL` unset → watcher not started (no error)
- [x] All new tests pass: `pytest tests/test_remote_watcher.py -v` (25 tests)
- [x] All existing 131 tests still pass (no regression) — 155 total
- [x] `helm lint` passes with `controlPlane.enabled: true`
- [x] UAT wow-5 demo reproducible: in-cluster + remote agents in same k9s `:ao` table
- [ ] Integration test: full round-trip (agent registers → heartbeat → watcher creates CR → appears in k9s) — requires live cluster

---

## Security Considerations

- `CONTROL_PLANE_KEY` masked in all operator logs
- Watcher validates control plane response schema before creating CRs
  (prevent control plane compromise from injecting arbitrary k8s resources)
- CR names from control plane: validated as RFC-1123 DNS labels (same check as `_sidecar_url`)
- `namespaceSelector`: watcher only creates CRs in `agentspec-remote` — not arbitrary namespaces
- Rate limit: if control plane returns >500 agents, warn and process in batches (prevent k8s API flood)

---

## Test Plan

### Unit tests (`test_remote_watcher.py`, mocked httpx + mocked k8s)
- `_fetch_agents()` → parses control plane response correctly
- New agent → `_upsert_cr()` called with correct CR shape
- Existing agent, unchanged lastSeen → no upsert (idempotent)
- Agent disappears from list → CR deleted
- Control plane returns 401 → logs warning, does not crash
- Control plane returns malformed JSON → logs warning, does not crash
- CR name with dots/uppercase → rejected (RFC-1123 validation)
- `start()` / `stop()` lifecycle — task created and cancelled cleanly

### Integration tests (requires cluster or `kubernetes-asyncio` mock)
- Full round-trip: agent registers → heartbeat → watcher creates CR → appears in k9s
