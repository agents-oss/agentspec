# Compliance & Audit

AgentSpec's compliance system scores your agent against security and quality best practices.

## Running an Audit

```bash
npx agentspec audit agent.yaml
```

Output:
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

  [critical] SEC-LLM-06 — Sensitive data disclosure: PII scrub in memory hygiene
    Long-term memory declared without piiScrubFields — PII may be persisted.
    Path: /spec/memory/hygiene/piiScrubFields
    → Add spec.memory.hygiene.piiScrubFields: [ssn, credit_card, bank_account]
    https://owasp.org/www-project-top-10-for-large-language-model-applications/
```

## Compliance Packs

### `owasp-llm-top10`

10 rules aligned to [OWASP LLM Top 10 (2025)](https://owasp.org/www-project-top-10-for-large-language-model-applications/):

| Rule ID | Description | Severity |
|---------|-------------|----------|
| SEC-LLM-01 | Input guardrail required (prompt injection) | high |
| SEC-LLM-02 | Output guardrail required (insecure output) | high |
| SEC-LLM-04 | Rate limiting + cost controls (model DoS) | medium |
| SEC-LLM-05 | Model provider and version pinned | medium |
| SEC-LLM-06 | PII scrub for long-term memory | **critical** |
| SEC-LLM-07 | Tool annotations declared | medium |
| SEC-LLM-08 | destructiveHint on all tools | high |
| SEC-LLM-09 | Evaluation + CI gate | medium |
| SEC-LLM-10 | API keys use $secret not $env | high |

### `model-resilience`

| Rule ID | Description | Severity |
|---------|-------------|----------|
| MODEL-01 | Fallback model declared | high |
| MODEL-02 | Model version pinned (not "latest") | medium |
| MODEL-03 | Cost controls declared | medium |
| MODEL-04 | Fallback retry strategy | low |

### `memory-hygiene`

| Rule ID | Description | Severity |
|---------|-------------|----------|
| MEM-01 | PII scrub fields for long-term memory | critical |
| MEM-02 | TTL set for all memory backends | high |
| MEM-03 | Audit log enabled | medium |
| MEM-04 | Vector store namespace isolated | medium |
| MEM-05 | Short-term memory max tokens bounded | low |

### `evaluation-coverage`

| Rule ID | Description | Severity |
|---------|-------------|----------|
| EVAL-01 | Evaluation dataset declared | medium |
| EVAL-02 | CI gate enabled | medium |
| EVAL-03 | Hallucination threshold configured | medium |

## Scoring

- Each rule has a weight: critical=4, high=3, medium=2, low=1, info=0
- Score = (sum of passed weights) / (sum of total weights) × 100
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
# Fail CI if score drops below 70
npx agentspec audit agent.yaml --fail-below 70

# Run only security rules
npx agentspec audit agent.yaml --pack owasp-llm-top10

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
