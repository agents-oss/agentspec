# UAT Wow-Effect 4 — Drift Detection with `agentspec diff`

**Phase:** 5 (`agentspec diff`)
**Status:** ⬜ TODO — Phase 5 not yet implemented

---

## Goal

Demonstrate that a developer can detect compliance drift after code changes:
`agentspec scan` produces an updated `agent.yaml.new`, and `agentspec diff` shows
exactly what changed and the compliance impact (score delta, severity of each change).

---

## Architecture

```
Original agent.yaml  (grade A, score 94 — committed to repo)
       ↓  code changes: removed guardrails, added new tool
agentspec scan -f ./src/
       ↓  detects changes, creates agent.yaml.new (does NOT overwrite existing)
agentspec diff agent.yaml agent.yaml.new
       ↓  semantic diff: what changed, compliance impact per change
Developer reviews → decides whether to accept drift or revert code
```

---

## Step-by-Step Demo

```bash
# Starting state: committed agent.yaml with grade A
cat agent.yaml | grep grade
# → estimated score: 94, grade: A

# Developer removes content_filter guardrail from their code
# and adds a new tool that calls external API

# Re-scan
agentspec scan -f ./src/
# → detects changes → writes agent.yaml.new (keeps original agent.yaml)

# Show what changed
agentspec diff agent.yaml agent.yaml.new
```

```
agentspec diff — compliance drift analysis
══════════════════════════════════════════════════════
  Comparing: agent.yaml → agent.yaml.new

  REMOVED  guardrails.content_filter        [-15 score]  HIGH
           Content filtering removed — any user input reaches model unfiltered

  ADDED    tools.fetch_external_prices      [+0 score]   LOW
           New tool: fetch_external_prices (no compliance concerns detected)

  REMOVED  spec.eval.hooks                  [-8 score]   MEDIUM
           Eval hooks removed — regression detection disabled

  Net score change:  -23  (94 → 71, A → C)
  Net grade change:  A → C

  Recommendation: restore guardrails.content_filter before deploying
══════════════════════════════════════════════════════
```

```bash
# Developer decides to revert guardrails
# → edits code, re-scans, diff shows 0 net change
agentspec scan -f ./src/
agentspec diff agent.yaml agent.yaml.new
# → "No compliance drift detected"

# Accept the diff if intentional
cp agent.yaml.new agent.yaml
agentspec generate agent.yaml --deploy k8s
kubectl apply -f k8s/
```

---

## Expected k9s Output After Drift Applied (Without Fix)

```
NAME       PHASE    GRADE  SCORE  MODEL  VIOLATIONS  SOURCE      CHECKED
my-agent   Healthy  C      71     pass   3           agent-sdk   8s
```
*(Grade degraded from A to C — visible immediately in live table)*

---

## Troubleshooting

- `agent.yaml.new` not created: check that original `agent.yaml` exists in working dir
- Diff shows no changes: scan may have not detected the guardrail removal (update `scan.md` skill)
- Score delta incorrect: `agentspec diff` uses static manifest analysis; no LLM needed

---

## Implementation Notes (Phase 5)

New files:
- `packages/cli/src/commands/diff.ts` — `agentspec diff <file1> <file2>`
- Deterministic (no Claude needed): compares two agent.yaml structures
- Outputs semantic changes with per-property compliance impact
- Annotates severity: HIGH (guardrails removed), MEDIUM (eval removed), LOW (new tools)
- Score delta computed from internal scoring table (matches `packages/sidecar/src/control-plane/gap.ts`)
