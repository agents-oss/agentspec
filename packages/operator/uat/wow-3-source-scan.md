# UAT Wow-Effect 3 — Source Scan → agent.yaml → k9s

**Phase:** 5 (`agentspec scan`)
**Status:** ⬜ TODO — Phase 5 not yet implemented

---

## Goal

Demonstrate the full source-to-k9s loop: developer points `agentspec scan` at their source
directory, gets an `agent.yaml` generated, deploys it, and the agent appears in the k9s
`:ao` table with the correct compliance grade — all from source code alone.

---

## Architecture

```
agentspec scan -f ./src/
       ↓  (Claude analyzes: imports, env vars, tool calls, model provider, guardrails)
agent.yaml generated (or agent.yaml.new if one exists)
       ↓
Developer reviews + commits agent.yaml
       ↓
agentspec generate --deploy k8s  (or helm)
       ↓
Kubernetes manifests generated (Deployment + Service + AgentObservation CR)
       ↓
kubectl apply -f k8s/
       ↓
Kopf operator probes sidecar → patches .status
       ↓
k9s :ao  →  agent appears with grade from source scan
```

---

## Step-by-Step Demo

```bash
# 1. Have a simple Python agent (no agent.yaml yet)
ls ./src/
#   main.py      (calls openai, uses OPENAI_API_KEY, has no guardrails)

# 2. Scan the source
agentspec scan -f ./src/
# → Claude reads main.py
# → Detects: model=openai/gpt-4o, apiKey=$env:OPENAI_API_KEY, tools=[chat], no guardrails
# → Writes agent.yaml

cat agent.yaml
# metadata:
#   name: my-agent
# spec:
#   model:
#     provider: openai
#     name: gpt-4o
#     apiKey: $env:OPENAI_API_KEY
#   tools:
#     - name: chat
#   guardrails: []   # ← scan detected none

# 3. Generate k8s manifests
agentspec generate agent.yaml --deploy k8s

# 4. Deploy
kubectl apply -f k8s/

# 5. Watch in k9s
k9s
# → :ao → my-agent appears
# → Grade=D (no guardrails, model key missing from cluster secrets)

# 6. Fix: add guardrails to agent.yaml, re-scan to confirm, re-generate, re-deploy
agentspec scan -f ./src/ --update   # updates existing agent.yaml
agentspec generate agent.yaml --deploy k8s
kubectl apply -f k8s/
# → Grade improves from D to B
```

---

## Expected Output

```bash
$ agentspec scan -f ./src/
Scanning ./src/ for agent patterns...
  ✓ Detected model: openai/gpt-4o (via openai import + OPENAI_API_KEY env)
  ✓ Detected tools: chat (function with @tool decorator)
  ⚠ No guardrails found (content filtering, rate limits)
  ⚠ No eval hooks found

Generated: agent.yaml (compliance score estimate: 45/100, grade: F)
Run 'agentspec generate agent.yaml' to scaffold deployment manifests.
```

---

## Troubleshooting

- Scan fails to detect model: ensure API key env var name matches known patterns
- Grade lower than expected: check guardrails section in agent.yaml
- Scan produces generic agent.yaml: review Claude adapter skill `scan.md`

---

## Implementation Notes (Phase 5)

New files:
- `packages/cli/src/commands/scan.ts` — `agentspec scan -f <dir>`
- `packages/adapter-claude/src/skills/scan.md` — Claude skill for source analysis
- Uses same `generateWithClaude()` flow as existing `generate` command
- Creates `agent.yaml` if none exists; creates `agent.yaml.new` if one exists
