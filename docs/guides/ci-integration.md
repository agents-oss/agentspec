# CI Integration

Run AgentSpec checks in your CI pipeline to catch configuration drift before it reaches production.

## GitHub Actions example

```yaml
name: Agent checks

on: [push, pull_request]

jobs:
  agentspec:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate manifest schema
        run: npx agentspec validate agent.yaml

      - name: Compliance audit
        run: npx agentspec audit agent.yaml --fail-below 75
```

## Fail on score threshold

Use `--fail-below <score>` to fail CI if compliance drops below a threshold:

```bash
# Fail if overall score drops below 80
npx agentspec audit agent.yaml --fail-below 80

# Audit only a specific pack
npx agentspec audit agent.yaml --pack owasp-llm-top10 --fail-below 90
```

## Save audit report as artefact

```yaml
      - name: Compliance audit
        run: npx agentspec audit agent.yaml --json --output audit-report.json

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: audit-report
          path: audit-report.json
```

## Skip health checks in CI

Health checks contact live services (Redis, model APIs). Skip them in CI unless you have test
services available:

```bash
# validate only — no network I/O
npx agentspec validate agent.yaml

# audit only — no network I/O
npx agentspec audit agent.yaml
```

## See also

- [CLI Reference](../reference/cli.md)
- [Compliance Concepts](../concepts/compliance.md)
