# Compliance & Audit

AgentSpec's compliance system scores your agent against security and quality best practices.

## Running an Audit

```bash
# Declaration checks only (no I/O)
npx agentspec audit agent.yaml

# + proof records from a running sidecar (dual score)
npx agentspec audit agent.yaml --url http://localhost:4001
```

Output without `--url`:
```
  AgentSpec Audit — my-agent
  ────────────────────────────────
  Score : B  78/100
  Rules : 18 passed / 4 failed / 22 total

  Category Scores
    owasp-llm-top10          65% ████████████░░░░░░░░
    model-resilience          90% ██████████████████░░
    memory-hygiene            70% ██████████████░░░░░░
    evaluation-coverage       85% █████████████████░░░

  Violations (4)

  [critical] [X] SEC-LLM-06 — Sensitive data disclosure: PII scrub in memory hygiene
    Long-term memory declared without piiScrubFields — PII may be persisted.
    Path: /spec/memory/hygiene/piiScrubFields
    → Add spec.memory.hygiene.piiScrubFields: [ssn, credit_card, bank_account]
    → Prove: Microsoft Presidio
    https://microsoft.github.io/presidio/
```

Output with `--url http://localhost:4001` (dual score):
```
  AgentSpec Audit — research-agent
  ══════════════════════════════════
  Declared score : D  65/100  — what your spec says
  Proved score   : F  35/100  — what has been verified
  Pending proof  : 4 rules — run external tools and POST to http://localhost:4001/proof/rule/:ruleId
  Rules : 18 passed / 4 failed / 22 total
```

## Evidence Tiers

Every audit rule carries an **evidence tier** label that tells you what kind of evidence backs the finding:

| Badge | Tier | Meaning | How to prove |
|-------|------|---------|-------------|
| `[D]` | Declarative | Manifest analysis only — reads the YAML, no I/O | (always available) |
| `[P]` | Probed | Health check verified at infrastructure level | `agentspec health <file>` |
| `[B]` | Behavioral | Runtime events confirmed actual execution | AgentSpec EventPush + sidecar |
| `[X]` | External | Proved by an external CI tool (k6, Presidio, Promptfoo, LiteLLM) | POST to `/proof/rule/:ruleId` |

### Declared vs Proved

The **declared score** reflects what your `agent.yaml` says. It only tells you that you've filled in the fields. The **proved score** tells you what has actually been verified:

```
Declared score:  65  D   ← you said it; we checked the YAML
Proved score:    35  F   ← only this fraction has been independently verified
Pending proof:   4 rules ← these pass declaratively but need external tool verification
```

Use the sidecar proof endpoint to submit verification results:
```bash
# After k6 rate limit test passes
curl -X POST http://localhost:4001/proof/rule/SEC-LLM-04 \
  -H 'Content-Type: application/json' \
  -d '{"verifiedBy":"k6","method":"1200 req/min, 429 at 1000 — 100% enforced"}'
```

See [Proof Integration Guide](../guides/proof-integration.md) for tool-by-tool instructions.

## Rule Classification

All 25 rules are classified by evidence tier:

### Probed — verified by `agentspec health`

| Rule | Description | Severity |
|------|-------------|----------|
| SEC-LLM-03 | System prompt loaded from versioned `$file:` | medium |
| SEC-LLM-05 | Model provider and version pinned | medium |
| SEC-LLM-09 | Evaluation framework + CI gate configured | medium |
| SEC-LLM-10 | API keys use `$secret:` not `$env:` | high |
| MODEL-02 | Model version pinned (not "latest") | medium |
| MEM-02 | TTL set for all memory backends | high |
| MEM-03 | Audit log enabled | medium |
| MEM-04 | Vector store namespace isolated | medium |
| MEM-05 | Short-term memory max tokens bounded | low |
| EVAL-01 | Evaluation dataset declared | medium |
| EVAL-02 | CI gate enabled | medium |
| EVAL-03 | Hallucination threshold configured | medium |
| OBS-01 | Tracing backend declared | medium |

### Behavioral — verified by runtime events

| Rule | Description | Severity | Proof tool |
|------|-------------|----------|-----------|
| SEC-LLM-01 | Input guardrail actually invoked | high | AgentSpec EventPush |
| SEC-LLM-02 | Output guardrail actually invoked | high | AgentSpec EventPush |
| OBS-02 | Log lines contain structured JSON | low | AgentSpec EventPush |

### External — verified by dedicated CI tools

| Rule | Description | Severity | Proof tool |
|------|-------------|----------|-----------|
| SEC-LLM-04 | Rate limit enforced under load | medium | [k6](https://k6.io) |
| SEC-LLM-06 | PII actually scrubbed from memory | **critical** | [Microsoft Presidio](https://microsoft.github.io/presidio/) |
| SEC-LLM-07 | Tool annotations respected by agent | medium | [Promptfoo](https://promptfoo.dev) |
| SEC-LLM-08 | Destructive tools flagged and constrained | high | [Promptfoo](https://promptfoo.dev) |
| MODEL-01 | Fallback actually invoked on failure | high | [LiteLLM chaos test](https://docs.litellm.ai/docs/proxy/reliability) |
| MODEL-03 | Cost controls enforced by spend tracker | medium | [LiteLLM Spend Tracking](https://docs.litellm.ai/docs/proxy/cost_tracking) |
| MODEL-04 | Retry strategy works correctly | low | [pytest-mockllm](https://pypi.org/project/pytest-mockllm/) |
| MEM-01 | PII scrub fields actually prevent PII storage | **critical** | [Microsoft Presidio](https://microsoft.github.io/presidio/) |
| OBS-03 | Log redaction prevents PII in log aggregators | medium | [Microsoft Presidio](https://microsoft.github.io/presidio/) |

## Compliance Packs

### `owasp-llm-top10`

10 rules aligned to [OWASP LLM Top 10 (2025)](https://owasp.org/www-project-top-10-for-large-language-model-applications/):

| Rule ID | Description | Severity | Tier |
|---------|-------------|----------|------|
| SEC-LLM-01 | Input guardrail required (prompt injection) | high | [B] |
| SEC-LLM-02 | Output guardrail required (insecure output) | high | [B] |
| SEC-LLM-03 | System prompt loaded from versioned file | medium | [P] |
| SEC-LLM-04 | Rate limiting + cost controls (model DoS) | medium | [X] |
| SEC-LLM-05 | Model provider and version pinned | medium | [P] |
| SEC-LLM-06 | PII scrub for long-term memory | **critical** | [X] |
| SEC-LLM-07 | Tool annotations declared | medium | [X] |
| SEC-LLM-08 | destructiveHint on all tools | high | [X] |
| SEC-LLM-09 | Evaluation + CI gate | medium | [P] |
| SEC-LLM-10 | API keys use $secret not $env | high | [P] |

### `model-resilience`

| Rule ID | Description | Severity | Tier |
|---------|-------------|----------|------|
| MODEL-01 | Fallback model declared | high | [X] |
| MODEL-02 | Model version pinned (not "latest") | medium | [P] |
| MODEL-03 | Cost controls declared | medium | [X] |
| MODEL-04 | Fallback retry strategy | low | [X] |

### `memory-hygiene`

| Rule ID | Description | Severity | Tier |
|---------|-------------|----------|------|
| MEM-01 | PII scrub fields for long-term memory | critical | [X] |
| MEM-02 | TTL set for all memory backends | high | [P] |
| MEM-03 | Audit log enabled | medium | [P] |
| MEM-04 | Vector store namespace isolated | medium | [P] |
| MEM-05 | Short-term memory max tokens bounded | low | [P] |

### `evaluation-coverage`

| Rule ID | Description | Severity | Tier |
|---------|-------------|----------|------|
| EVAL-01 | Evaluation dataset declared | medium | [P] |
| EVAL-02 | CI gate enabled | medium | [P] |
| EVAL-03 | Hallucination threshold configured | medium | [P] |

### `observability`

| Rule ID | Description | Severity | Tier |
|---------|-------------|----------|------|
| OBS-01 | Tracing backend declared | medium | [P] |
| OBS-02 | Structured logging enabled | low | [B] |
| OBS-03 | Sensitive fields redacted from logs | medium | [X] |

## Scoring

- Each rule has a weight: critical=4, high=3, medium=2, low=1, info=0
- **Declared score** = (sum of passed weights) / (sum of total weights) × 100
- **Proved score** = (sum of proved weights) / (sum of total weights) × 100
  - Proved = `[P]` rules that pass + `[B]` rules observed + `[X]` rules with proof records
- Grades: A≥90, B≥75, C≥60, D≥45, F<45

## Suppressing Rules

If a rule doesn't apply to your use case:

```yaml
spec:
  compliance:
    suppressions:
      - rule: SEC-LLM-10
        reason: "Development environment only — production uses $secret"
        approvedBy: security-team
        expires: 2026-06-01    # ISO date — suppression auto-expires
```

Suppressed rules are excluded from scoring but logged in the audit report.

## Running in CI

```bash
# Fail CI if declared score drops below 70
npx agentspec audit agent.yaml --fail-below 70

# Run only security rules
npx agentspec audit agent.yaml --pack owasp-llm-top10

# Fetch proof records from sidecar + dual score in JSON
npx agentspec audit agent.yaml --url http://localhost:4001 --json --output audit-report.json

# Output JSON for processing
npx agentspec audit agent.yaml --json --output audit-report.json
```

## Scheduled Audits

```yaml
spec:
  compliance:
    packs:
      - owasp-llm-top10
      - model-resilience
    auditSchedule: weekly    # daily | weekly | monthly | on-change
```

This is declarative — actual scheduling requires a cron job or CI workflow that runs `agentspec audit`.

## See also

- [Proof Integration Guide](../guides/proof-integration.md) — how to wire k6, LiteLLM, Promptfoo, and Presidio
- [Probe Coverage](./probe-coverage.md) — field-by-field evidence tier matrix
- [CLI Reference — agentspec audit](../reference/cli.md#agentspec-audit)
