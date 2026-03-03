# Harden an Existing Agent

You have a working agent. This tutorial takes it from unknown compliance grade to Grade B+ with a CI gate, using only AgentSpec CLI commands — no manual manifest writing required.

**Time:** ~10 minutes
**Prerequisites:** Node.js 20+, `ANTHROPIC_API_KEY`, an existing agent codebase in `./src/`

---

## 1. Generate a manifest from your source code

```bash
export ANTHROPIC_API_KEY=ant-...
npx agentspec scan --dir ./src/ --dry-run
```

`--dry-run` prints the generated `agent.yaml` to stdout without writing anything. Review it — Claude infers model, tools, guardrails, memory backend, and required env vars from your source files.

When the output looks reasonable:

```bash
npx agentspec scan --dir ./src/ --out agent.yaml
```

If you already have an `agent.yaml`, use `--update` to scan into a new file and diff later:

```bash
npx agentspec scan --dir ./src/ --out agent.yaml.new
```

---

## 2. Read the baseline audit score

```bash
npx agentspec audit agent.yaml
```

For most legacy agents this produces a score of 30–55 (grade D or F). Don't panic — the audit is showing you exactly what's missing. Example output:

```
  AgentSpec Audit — my-agent
  ──────────────────────────
  Score: 42/100   Grade: F

  CRITICAL
    [D] SEC-LLM-01  No input validation guardrail defined
    [D] SEC-LLM-05  No prompt injection blocklist

  HIGH
    [D] MODEL-03    Model version not pinned
    [D] MEM-01      No PII scrub on memory inputs

  MEDIUM
    [D] EVAL-01     No evaluation dataset

  Evidence breakdown:
    Declarative [D]: 5 checks, 0 passed
    Probed [P]:      0 checks
    Behavioral [B]:  0 checks
```

The `[D]` badge means the check is purely declarative — AgentSpec can verify it by reading the manifest alone.

---

## 3. Understand the badge system

| Badge | Meaning |
|-------|---------|
| `[D]` | Declarative — passes if the manifest field exists |
| `[P]` | Probed — AgentSpec actively tests the endpoint or backend |
| `[B]` | Behavioral — checked via OPA policy or runtime ring data |
| `[X]` | External — requires a proof record submitted via sidecar |

Focus on `[D]` violations first — they require only manifest edits and have immediate impact.

---

## 4. Fix the top 3 violations

### Fix 1 — Add guardrails (SEC-LLM-01, SEC-LLM-05)

```yaml
spec:
  guardrails:
    input:
      - type: blocklist
        patterns:
          - "ignore previous instructions"
          - "you are now"
          - "disregard all"
      - type: length
        maxTokens: 2000
    output:
      - type: pii_scrub
        fields: [email, phone, ssn]
```

### Fix 2 — Pin the model version (MODEL-03)

Replace any floating version alias with a pinned snapshot:

```yaml
spec:
  model:
    id: gpt-4o-2024-11-20     # was: gpt-4o
    fallback:
      id: gpt-4o-mini-2024-07-18
```

### Fix 3 — Add an evaluation dataset (EVAL-01)

```yaml
spec:
  evaluation:
    datasets:
      - name: core
        path: $file:evals/core.jsonl
        metrics:
          - string_match
    thresholds:
      pass_rate: 0.80
```

Create a minimal eval file:

```bash
mkdir -p evals
cat > evals/core.jsonl << 'EOF'
{"input": "Hello", "expected": "Hello"}
{"input": "What is 2+2?", "expected": "4"}
EOF
```

---

## 5. Verify the fixes

```bash
npx agentspec validate agent.yaml
npx agentspec health agent.yaml
```

Health checks confirm your model API is reachable and env vars are set. Validation confirms the manifest is schema-valid.

---

## 6. Read the improved score

```bash
npx agentspec audit agent.yaml
```

With the three fixes above, expect a score of 68–78 (grade C+ to B). Check the output for remaining violations — each is a concrete manifest field you can add.

---

## 7. Compare against the scanned baseline

If you used `--out agent.yaml.new` in step 1:

```bash
npx agentspec diff agent.yaml.new agent.yaml
```

This shows a drift score between the auto-generated baseline and your hardened version. A negative drift score means you improved the manifest relative to what the scanner inferred.

```
  AgentSpec Diff
  ──────────────────────────────────
  From: agent.yaml.new   Score: 42
  To:   agent.yaml       Score: 74

  + guardrails.input.blocklist      (+8)
  + guardrails.output.pii_scrub     (+5)
  + model.id (pinned)               (+6)
  + evaluation.datasets[0]          (+8)
  ...

  Net change: +32 points
```

---

## 8. Add a CI gate

Add to your CI pipeline (GitHub Actions example):

```yaml
# .github/workflows/audit.yml
name: AgentSpec Audit

on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npx agentspec audit agent.yaml --fail-below 70
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

`--fail-below 70` exits with code 1 if the score drops below 70, blocking the merge.

To also gate on live endpoint compliance when you have a staging environment:

```bash
npx agentspec audit agent.yaml --url $STAGING_SIDECAR_URL --fail-below 70
```

---

## What you've accomplished

- Generated a manifest from real source code with `agentspec scan`
- Read a baseline compliance grade and understood each violation
- Fixed the top violations: guardrails, model pinning, eval dataset
- Confirmed the improvement with a second audit
- Measured the delta with `agentspec diff`
- Added a CI gate that fails on grade regression

---

## See also

- [Build a Production Agent](./01-build-production-agent) — start from scratch instead
- [Deploy & Monitor](./03-deploy-and-monitor) — move to Kubernetes with live gap analysis
- [CI Integration Guide](../guides/ci-integration) — advanced CI patterns
- [Proof Integration](../guides/proof-integration) — submit external evidence for `[X]` rules
