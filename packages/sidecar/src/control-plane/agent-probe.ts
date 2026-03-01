/**
 * Agent SDK introspection probe.
 *
 * Attempts GET {upstreamUrl}/agentspec/health to discover whether the upstream
 * agent has integrated @agentspec/sdk's AgentSpecReporter. Returns a cached
 * AgentProbeResult:
 *  - sdkAvailable: true  → live HealthReport from the agent
 *  - sdkAvailable: false → graceful fallback; callers use static manifest analysis
 */

import type { HealthReport } from '@agentspec/sdk'

export interface AgentProbeResult {
  /** true if GET /agentspec/health returned a valid HealthReport */
  sdkAvailable: boolean
  /** Live HealthReport from the agent (only when sdkAvailable: true) */
  report?: HealthReport
  /** Wall-clock time of the probe request */
  probeLatencyMs: number
}

/**
 * Attempts GET {upstreamUrl}/agentspec/health with a configurable timeout.
 * Returns { sdkAvailable: false } if the endpoint is absent (404), malformed,
 * times out, or is unreachable.
 */
export async function probeAgent(
  upstreamUrl: string,
  timeoutMs = 5_000,
): Promise<AgentProbeResult> {
  const url = `${upstreamUrl}/agentspec/health`
  const start = Date.now()

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    })

    const probeLatencyMs = Date.now() - start

    if (!res.ok) {
      // 404 = SDK not integrated; other errors = degraded but not fatal
      return { sdkAvailable: false, probeLatencyMs }
    }

    const body = (await res.json()) as unknown

    if (!isHealthReport(body)) {
      return { sdkAvailable: false, probeLatencyMs }
    }

    return { sdkAvailable: true, report: body, probeLatencyMs }
  } catch {
    // Timeout, ECONNREFUSED, parse error — all treated as "not available"
    return { sdkAvailable: false, probeLatencyMs: Date.now() - start }
  }
}

/**
 * Minimal shape guard — validates the response looks like a HealthReport.
 * Does not validate every field; the sidecar treats unrecognised fields as
 * safe to ignore.
 */
function isHealthReport(value: unknown): value is HealthReport {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['agentName'] === 'string' &&
    typeof v['timestamp'] === 'string' &&
    typeof v['status'] === 'string' &&
    Array.isArray(v['checks'])
  )
}
