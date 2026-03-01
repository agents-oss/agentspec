import type { FastifyInstance } from 'fastify'
import type { AuditRing } from '../audit-ring.js'

export interface ExplainStep {
  step: string
  result?: string
  tool?: string
  args?: Record<string, unknown>
  excerpt?: string
}

export interface ExplainTrace {
  requestId: string
  timestamp: string
  method: string
  path: string
  durationMs?: number
  statusCode?: number
  steps: ExplainStep[]
}

export async function buildExplainRoutes(
  app: FastifyInstance,
  auditRing: AuditRing,
): Promise<void> {
  app.get<{ Params: { requestId: string } }>(
    '/explain/:requestId',
    async (req, reply) => {
      const entry = auditRing.findById(req.params.requestId)
      if (!entry) {
        reply.status(404)
        return { error: `No audit entry found for requestId: ${req.params.requestId}` }
      }

      // Reconstruct trace from audit entry.
      // When the Python SDK is present, it emits structured steps into the excerpt.
      // Without it, we infer basic steps from the request/response metadata.
      const steps: ExplainStep[] = []

      steps.push({ step: 'request_received', result: `${entry.method} ${entry.path}` })

      if (entry.statusCode !== undefined) {
        const isSuccess = entry.statusCode < 400
        steps.push({
          step: 'response',
          result: isSuccess ? 'success' : 'error',
          excerpt: entry.excerpt,
        })
      }

      const trace: ExplainTrace = {
        requestId: entry.requestId,
        timestamp: entry.timestamp,
        method: entry.method,
        path: entry.path,
        durationMs: entry.durationMs,
        statusCode: entry.statusCode,
        steps,
      }

      return trace
    },
  )
}
