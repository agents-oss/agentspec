function requirePort(envVar: string, fallback: number): number {
  const raw = process.env[envVar]
  const port = raw !== undefined ? Number(raw) : fallback
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid ${envVar}: "${raw}" — must be an integer between 1 and 65535`,
    )
  }
  return port
}

/**
 * Validates that the upstream URL is a legal http or https URL.
 * Throws at startup for fast failure rather than at request time.
 * Only http/https are permitted — file://, ftp://, etc. are rejected.
 */
function requireHttpUrl(envVar: string, fallback: string): string {
  const raw = process.env[envVar] ?? fallback
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`must use http: or https: protocol, got "${parsed.protocol}"`)
    }
    // Strip any trailing slash for consistency
    return raw.replace(/\/+$/, '')
  } catch (err) {
    throw new Error(
      `Invalid ${envVar}: "${raw}" — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Reads an env var and validates it is a positive integer (≥ 1).
 * Falls back to `fallback` when the env var is not set.
 * Exported so it can be unit-tested independently.
 */
export function requirePositiveInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar]
  const val = raw !== undefined ? Number(raw) : fallback
  if (!Number.isInteger(val) || val < 1) {
    throw new Error(
      `Invalid ${envVar}: "${raw ?? fallback}" — must be a positive integer (≥ 1)`,
    )
  }
  return val
}

export const config = {
  upstreamUrl: requireHttpUrl('UPSTREAM_URL', 'http://localhost:8000'),
  manifestPath: process.env['MANIFEST_PATH'] ?? '/manifest/agent.yaml',
  proxyPort: requirePort('PROXY_PORT', 4000),
  controlPlanePort: requirePort('CONTROL_PLANE_PORT', 4001),
  anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
  auditRingSize: requirePositiveInt('AUDIT_RING_SIZE', 1000),
  /**
   * Optional OPA sidecar URL. When set, the /gap endpoint queries OPA for
   * policy violations derived from the agent.yaml manifest declarations.
   * Falls back gracefully if OPA is unreachable.
   *
   * Set OPA_URL=http://localhost:8181 in environments that run OPA as a sidecar.
   * Use `agentspec generate-policy agent.yaml --out policies/` to generate the bundle.
   */
  opaUrl: process.env['OPA_URL'] ?? null,
} as const
