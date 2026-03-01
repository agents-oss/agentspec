import type { FastifyInstance } from 'fastify'
import { runHealthCheck, type AgentSpecManifest } from '@agentspec/sdk'
import { config } from '../config.js'
import { probeAgent } from './agent-probe.js'

export async function buildHealthRoutes(
  app: FastifyInstance,
  manifest: AgentSpecManifest,
): Promise<void> {
  // Liveness — always 200 while the process is running
  app.get('/health/live', async () => {
    return { status: 'live' }
  })

  // Readiness — probes spec.requires.* dependencies via SDK runHealthCheck,
  // enriched with live agent data when @agentspec/sdk reporter is integrated.
  app.get('/health/ready', async (_req, reply) => {
    try {
      // Static manifest analysis (always available)
      const staticReport = await runHealthCheck(manifest, {
        checkModel: false, // skip model API calls — too slow/costly from sidecar
        checkMcp: true,
        checkMemory: true,
      })

      // Attempt live probe — graceful degradation if agent SDK not integrated
      const probe = await probeAgent(config.upstreamUrl)

      // Prefer live data from the agent when available
      const checks = probe.sdkAvailable ? probe.report!.checks : staticReport.checks
      const source: 'agent-sdk' | 'manifest-static' = probe.sdkAvailable
        ? 'agent-sdk'
        : 'manifest-static'

      // Recompute status from the resolved check set
      const failed = checks.filter((c) => c.status === 'fail')
      const warnings = checks.filter((c) => c.status === 'warn')
      const hasErrors = failed.some((c) => c.severity === 'error')
      const hasWarnings = failed.some((c) => c.severity === 'warning') || warnings.length > 0

      const reportStatus = hasErrors ? 'unhealthy' : hasWarnings ? 'degraded' : 'healthy'

      const status =
        reportStatus === 'healthy'
          ? 'ready'
          : reportStatus === 'degraded'
            ? 'degraded'
            : 'unavailable'

      const httpStatus = status === 'unavailable' ? 503 : 200
      reply.status(httpStatus)

      return {
        status,
        source,
        agentName: probe.sdkAvailable ? probe.report!.agentName : staticReport.agentName,
        timestamp: probe.sdkAvailable ? probe.report!.timestamp : staticReport.timestamp,
        summary: probe.sdkAvailable ? probe.report!.summary : staticReport.summary,
        checks,
      }
    } catch (err) {
      reply.status(503)
      return { status: 'unavailable', source: 'manifest-static', checks: [], error: String(err) }
    }
  })
}
