# AgentSpec → Helm Chart Generation Skill

You are generating a production-ready **Helm chart** from an AgentSpec manifest JSON.
The universal output format, reference syntax, and quality rules are in the guidelines prepended above.

## What You Are Generating

A Helm chart that deploys the agent alongside the `agentspec-sidecar` as a sidecar container.
The chart is framework-agnostic — it wraps whatever container image the agent runs in.

## File Generation Rules

| File | When to generate |
|---|---|
| `Chart.yaml` | Always — chart metadata (name, version, description from manifest) |
| `values.yaml` | Always — defaults for all configurable values |
| `templates/deployment.yaml` | Always — agent + agentspec-sidecar containers |
| `templates/service.yaml` | Always — ClusterIP exposing agent and sidecar ports |
| `templates/configmap.yaml` | Always — non-secret env vars (MODEL_PROVIDER, MODEL_ID, AGENT_NAME) |
| `templates/secret.yaml` | Always — Opaque secret; all `$env:` refs from manifest listed as required keys |
| `templates/serviceaccount.yaml` | Always — dedicated service account with optional IRSA annotations |
| `templates/ingress.yaml` | When `spec.api` is set — optional ingress controlled by `values.ingress.enabled` |
| `templates/_helpers.tpl` | Always — reusable template helpers (name, labels, selectorLabels, fullname) |
| `.helmignore` | Always — standard Helm ignore file |
| `README.md` | Always — installation instructions, required env vars, upgrade guidance |

## AgentSpec → Helm Mapping

| Manifest field | Helm target |
|---|---|
| `metadata.name` | Chart name, resource names, app labels |
| `metadata.version` | `Chart.yaml appVersion` |
| `metadata.description` | `Chart.yaml description` |
| `spec.api.port` | Container port, Service port, `values.service.port` |
| `spec.model.provider` | `values.config.modelProvider` in ConfigMap |
| `spec.model.id` | `values.config.modelId` in ConfigMap |
| `spec.requires.envVars[]` | Keys in Secret template + listed in README as required |
| `spec.requires.services[]` | Listed in README as external dependencies |
| `spec.requires.minimumMemoryMB` | `values.resources.requests.memory` |

## Invariants

- **`agentspec-sidecar` is always included** as a sidecar container in the Deployment, never optional.
  - Image: `ghcr.io/agentspec/sidecar:latest` (controlled by `values.sidecar.image`)
  - Proxy port: 4000, Control plane port: 4001
  - Env: `UPSTREAM_URL: http://localhost:<agent-port>`, `MANIFEST_PATH: /manifest/agent.yaml`
- **No `$env:` or `$secret:` values** must appear in rendered ConfigMap data — only in the Secret.
- **Secret template** must list every `$env:VAR` ref found in the manifest as a key with a base64 placeholder comment.
- **`_helpers.tpl`** must define at minimum: `chart.name`, `chart.fullname`, `chart.labels`, `chart.selectorLabels`.
- **Resource names** must use the `{{ include "chart.fullname" . }}` helper to respect `nameOverride` / `fullnameOverride`.
- **`values.yaml`** must have sensible defaults (replica count 1, ClusterIP service, resources requests/limits).

## Helm Best Practices to Follow

- Use `{{ .Values.xxx | quote }}` for string values in env vars.
- Use `{{- toYaml .Values.resources | nindent 12 }}` for resource blocks.
- Add `NOTES.txt` under `templates/` with post-install instructions (how to reach the agent, sidecar endpoints).
- All resources must carry standard labels from `_helpers.tpl` (app.kubernetes.io/name, app.kubernetes.io/instance, app.kubernetes.io/version, app.kubernetes.io/managed-by).
- Include `helm.sh/chart` annotation.
- ServiceAccount must be conditionally created (`values.serviceAccount.create: true`).

## Output Format

Return a JSON object matching the GeneratedAgent schema:

```json
{
  "files": {
    "Chart.yaml": "...",
    "values.yaml": "...",
    "templates/_helpers.tpl": "...",
    "templates/deployment.yaml": "...",
    "templates/service.yaml": "...",
    "templates/configmap.yaml": "...",
    "templates/secret.yaml": "...",
    "templates/serviceaccount.yaml": "...",
    "templates/NOTES.txt": "...",
    ".helmignore": "...",
    "README.md": "..."
  },
  "installCommands": [
    "helm install <agent-name> . -f values.yaml --set image.tag=latest"
  ],
  "envVars": ["VAR1", "VAR2"]
}
```

`envVars` must list every `$env:VAR` name found in the manifest (for the README and CI checks).
`installCommands` must include the `helm install` and `helm upgrade` commands.

## Example Chart.yaml

```yaml
apiVersion: v2
name: <metadata.name>
description: <metadata.description>
type: application
version: 0.1.0
appVersion: "<metadata.version>"
```

## Example values.yaml (minimal)

```yaml
replicaCount: 1

image:
  repository: <metadata.name>
  tag: latest
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: <spec.api.port or 8000>

sidecar:
  image: ghcr.io/agentspec/sidecar:latest
  proxyPort: 4000
  controlPort: 4001

config:
  agentName: "<metadata.name>"
  modelProvider: "<spec.model.provider>"
  modelId: "<spec.model.id>"

ingress:
  enabled: false
  className: ""
  annotations: {}
  hosts: []
  tls: []

resources:
  requests:
    cpu: 100m
    memory: <spec.requires.minimumMemoryMB or 256>Mi
  limits:
    cpu: 500m
    memory: 512Mi

serviceAccount:
  create: true
  annotations: {}
  name: ""

nameOverride: ""
fullnameOverride: ""
```

Map **every** manifest field. Do not skip sections.
Ensure the Helm chart is installable with `helm install` against a standard Kubernetes cluster.
