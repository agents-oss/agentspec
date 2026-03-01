import type { AgentSpecManifest } from '@agentspec/sdk'

// ── Constants ─────────────────────────────────────────────────────────────────

const SIDECAR_IMAGE = 'ghcr.io/agentspec/sidecar:latest'
const DEFAULT_AGENT_PORT = 8000
const PROXY_PORT = 4000
const CONTROL_PORT = 4001

// ── YAML helpers ───────────────────────────────────────────────────────────────

/** Valid Kubernetes resource name: lowercase alphanumeric and hyphens, 1-63 chars. */
const K8S_NAME_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/

/**
 * Escapes a value for use inside a YAML double-quoted scalar.
 * Only `\` and `"` need escaping in YAML double-quoted strings.
 */
function escapeYamlDoubleQuotedValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates Kubernetes manifests from an AgentSpec manifest.
 *
 * Pure function — no I/O, no LLM, no network.
 * Returns a map of filename → YAML content ready to apply with kubectl.
 *
 * Files returned:
 *   k8s/deployment.yaml      — agent + agentspec-sidecar containers
 *   k8s/service.yaml         — ClusterIP exposing agent and sidecar ports
 *   k8s/configmap.yaml       — non-secret configuration (model provider/id, agent name)
 *   k8s/secret.yaml.example  — template listing all $env: vars; fill and apply separately
 */
export function generateK8sManifests(manifest: AgentSpecManifest): Record<string, string> {
  const name = manifest.metadata.name
  if (!K8S_NAME_RE.test(name)) {
    throw new Error(
      `Invalid agent name "${name}" for Kubernetes — must be a lowercase DNS label (a-z, 0-9, hyphens, 1-63 chars)`,
    )
  }
  const port = manifest.spec.api?.port ?? DEFAULT_AGENT_PORT
  const envRefs = collectEnvRefs(manifest)

  return {
    'k8s/deployment.yaml': generateDeployment(name, port, envRefs),
    'k8s/service.yaml': generateService(name, port),
    'k8s/configmap.yaml': generateConfigMap(name, manifest),
    'k8s/secret.yaml.example': generateSecretExample(name, envRefs),
  }
}

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * Scans every string in the manifest for `$env:VAR_NAME` references and
 * returns a deduplicated, sorted list of variable names.
 */
function collectEnvRefs(manifest: AgentSpecManifest): string[] {
  const raw = JSON.stringify(manifest)
  const matches = [...raw.matchAll(/\$env:([A-Za-z0-9_]+)/g)]
  const names = matches.map((m) => m[1] as string)
  return [...new Set(names)].sort()
}

function generateDeployment(name: string, port: number, envRefs: string[]): string {
  const secretEnvBlock =
    envRefs.length > 0
      ? envRefs
          .map(
            (v) =>
              `            - name: ${v}\n` +
              `              valueFrom:\n` +
              `                secretKeyRef:\n` +
              `                  name: ${name}-secrets\n` +
              `                  key: ${v}`,
          )
          .join('\n')
      : '            []'

  return (
    `apiVersion: apps/v1\n` +
    `kind: Deployment\n` +
    `metadata:\n` +
    `  name: ${name}\n` +
    `  labels:\n` +
    `    app: ${name}\n` +
    `spec:\n` +
    `  replicas: 1\n` +
    `  selector:\n` +
    `    matchLabels:\n` +
    `      app: ${name}\n` +
    `  template:\n` +
    `    metadata:\n` +
    `      labels:\n` +
    `        app: ${name}\n` +
    `    spec:\n` +
    `      containers:\n` +
    `        - name: ${name}\n` +
    `          image: ${name}:latest\n` +
    `          ports:\n` +
    `            - containerPort: ${port}\n` +
    `          envFrom:\n` +
    `            - configMapRef:\n` +
    `                name: ${name}-config\n` +
    `          env:\n` +
    `${secretEnvBlock}\n` +
    `        - name: agentspec-sidecar\n` +
    `          image: ${SIDECAR_IMAGE}\n` +
    `          ports:\n` +
    `            - containerPort: ${PROXY_PORT}\n` +
    `              name: proxy\n` +
    `            - containerPort: ${CONTROL_PORT}\n` +
    `              name: control\n` +
    `          env:\n` +
    `            - name: UPSTREAM_URL\n` +
    `              value: "http://localhost:${port}"\n` +
    `            - name: MANIFEST_PATH\n` +
    `              value: /manifest/agent.yaml\n`
  )
}

function generateService(name: string, port: number): string {
  return (
    `apiVersion: v1\n` +
    `kind: Service\n` +
    `metadata:\n` +
    `  name: ${name}\n` +
    `  labels:\n` +
    `    app: ${name}\n` +
    `spec:\n` +
    `  type: ClusterIP\n` +
    `  selector:\n` +
    `    app: ${name}\n` +
    `  ports:\n` +
    `    - name: http\n` +
    `      port: ${port}\n` +
    `      targetPort: ${port}\n` +
    `    - name: proxy\n` +
    `      port: ${PROXY_PORT}\n` +
    `      targetPort: ${PROXY_PORT}\n` +
    `    - name: control\n` +
    `      port: ${CONTROL_PORT}\n` +
    `      targetPort: ${CONTROL_PORT}\n`
  )
}

function generateConfigMap(name: string, manifest: AgentSpecManifest): string {
  const data = [
    `  AGENT_NAME: "${escapeYamlDoubleQuotedValue(name)}"`,
    `  MODEL_PROVIDER: "${escapeYamlDoubleQuotedValue(manifest.spec.model.provider)}"`,
    `  MODEL_ID: "${escapeYamlDoubleQuotedValue(manifest.spec.model.id)}"`,
  ].join('\n')

  return (
    `apiVersion: v1\n` +
    `kind: ConfigMap\n` +
    `metadata:\n` +
    `  name: ${name}-config\n` +
    `  labels:\n` +
    `    app: ${name}\n` +
    `data:\n` +
    `${data}\n`
  )
}

function generateSecretExample(name: string, envRefs: string[]): string {
  const dataLines =
    envRefs.length > 0
      ? envRefs
          .map((v) => `  ${v}: <base64-encoded-value>  # echo -n "<value>" | base64`)
          .join('\n')
      : '  # No $env: references found in manifest'

  return (
    `# Example Kubernetes Secret — fill in real values and apply with:\n` +
    `#   kubectl apply -f k8s/secret.yaml\n` +
    `# DO NOT commit real values. This file is a template only.\n` +
    `apiVersion: v1\n` +
    `kind: Secret\n` +
    `metadata:\n` +
    `  name: ${name}-secrets\n` +
    `  labels:\n` +
    `    app: ${name}\n` +
    `type: Opaque\n` +
    `data:\n` +
    `${dataLines}\n`
  )
}
