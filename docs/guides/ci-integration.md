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

## Detect configuration drift

Use `agentspec diff` to fail CI when `agent.yaml` drifts from a known-good baseline. `diff` is
deterministic — no API key required.

```yaml
      - name: Check for compliance drift
        run: npx agentspec diff agent.yaml.baseline agent.yaml --exit-code
```

Exit code `1` is returned when any change is detected. Use `--json` to capture the report as an
artefact:

```yaml
      - name: Detect drift
        run: |
          npx agentspec diff agent.yaml.baseline agent.yaml \
            --json > drift-report.json || true

      - name: Fail if HIGH severity drift
        run: |
          HIGH=$(jq '[.changes[] | select(.severity=="HIGH")] | length' drift-report.json)
          if [ "$HIGH" -gt 0 ]; then
            echo "HIGH severity compliance drift detected"
            cat drift-report.json | jq '.changes[] | select(.severity=="HIGH")'
            exit 1
          fi

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: drift-report
          path: drift-report.json
```

**Typical workflow:** store a `agent.yaml.baseline` in the repository (tagged at the last reviewed
state). Any PR that changes `agent.yaml` must pass `agentspec diff` review before merging.

```bash
# Update baseline after a review-approved change
cp agent.yaml agent.yaml.baseline
git commit -m "chore: update agent.yaml baseline after guardrail review"
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

## Generate k8s manifests in CI

`--deploy k8s` is deterministic and requires no API key — safe to run on every push:

```yaml
      - name: Generate Kubernetes manifests
        run: npx agentspec generate agent.yaml --framework langgraph --deploy k8s --output ./k8s-out/

      - uses: actions/upload-artifact@v4
        with:
          name: k8s-manifests
          path: k8s-out/k8s/
```

The generated `k8s/secret.yaml.example` lists every `$env:` ref as a placeholder — useful for
auditing required secrets in PRs.

## Skip health checks in CI

Health checks contact live services (Redis, model APIs). Skip them in CI unless you have test
services available:

```bash
# validate only — no network I/O
npx agentspec validate agent.yaml

# audit only — no network I/O
npx agentspec audit agent.yaml
```

## Full pipeline example

```yaml
name: Agent compliance pipeline

on: [push, pull_request]

jobs:
  agentspec:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 1. Schema — fast, no I/O
      - name: Validate schema
        run: npx agentspec validate agent.yaml

      # 2. Compliance audit — no I/O
      - name: Audit compliance
        run: npx agentspec audit agent.yaml --fail-below 75 --json --output audit-report.json

      # 3. Drift detection against baseline — no API key needed
      - name: Detect drift
        run: npx agentspec diff agent.yaml.baseline agent.yaml --exit-code --json > drift-report.json

      # 4. k8s manifests — deterministic, no API key needed
      - name: Generate k8s manifests
        run: npx agentspec generate agent.yaml --framework langgraph --deploy k8s --output ./k8s-out/

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: compliance-reports
          path: |
            audit-report.json
            drift-report.json
            k8s-out/k8s/
```

## See also

- [CLI Reference — agentspec diff](../reference/cli.md#agentspec-diff)
- [CLI Reference — agentspec audit](../reference/cli.md#agentspec-audit)
- [Add push mode](./add-push-mode.md)
