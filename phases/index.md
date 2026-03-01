# AgentBoot — Phase Tracker

## Overview

Each phase is self-contained: read `phases/phase-N/spec.md` for goal, deliverables, and acceptance criteria.

**Before starting each phase:**
1. Create `phases/phase-N/spec.md` (copy structure from phase-1)
2. Write tests first (`/everything-claude-code:tdd`)
3. Code-review all CRITICAL + HIGH findings before advancing (`/everything-claude-code:code-review`)
4. Update docs for that phase
5. Mark phase complete below
6. Clear context and start the next phase

**Before closing each phase:**
1. Run `/everything-claude-code:code-review` — fix all CRITICAL + HIGH findings
2. Confirm all acceptance criteria in `spec.md` are checked
3. Confirm test count in phase notes is accurate
4. Update `phases/index.md` phase row status to ✅ DONE

---

## Phase Status

| Phase | Title | Status | Spec | Notes |
|-------|-------|--------|------|-------|
| 1 | k8s Operator (Kopf + CRD + k9s + 76 tests) | ✅ DONE | [spec](phase-1/spec.md) | All 76 tests passing |
| 2 | MutatingWebhook auto-inject | ✅ DONE | [spec](phase-2/spec.md) | 121 tests passing. UAT: `uat/webhook_testing.md` + `uat/verify-webhook.sh` |
| 3 | Control plane service (register + heartbeat) | ✅ DONE | [spec](phase-3/spec.md) | 85 tests passing. FastAPI + JWT (revocation) + SQLAlchemy async + docker-compose + UAT guide |
| 4 | SDK `startPushMode()` (TypeScript + Python) | ⬜ TODO | [spec](phase-4/spec.md) | Adds push to `packages/sdk/`; new `packages/sdk-python/` |
| 5 | `agentspec scan` + `agentspec diff` | ✅ DONE | [spec](phase-5/spec.md) | 234 CLI tests (47 new). scan: Claude-powered code→yaml. diff: deterministic drift scoring |
| 6 | `RemoteAgentWatcher` (operator reads control plane) | ⬜ TODO | [spec](phase-6/spec.md) | Cross-runtime in k9s `:ao` table; closes the loop |

---

## Next Phase

**Phase 2: MutatingWebhook Auto-Inject**

`MutatingWebhookConfiguration` intercepts Pod creation. Pods with annotation
`agentspec.io/inject: "true"` get the sidecar container appended automatically,
and an `AgentObservation` CR is created. This makes the operator fully zero-touch.

Key challenge: TLS certificate setup for the webhook server (cert-manager or self-signed).

See `phases/phase-2/spec.md` for full details (to be written before implementation).
