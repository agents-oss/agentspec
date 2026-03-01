import type { FastifyInstance } from 'fastify'
import type { AuditRing } from '../audit-ring.js'

export async function buildAuditRoutes(
  app: FastifyInstance,
  auditRing: AuditRing,
): Promise<void> {
  // Return last N audit entries as JSON array
  app.get('/audit', async () => {
    return auditRing.getAll()
  })

  // SSE stream — push new entries as they arrive
  // reply.hijack() hands full control to us so Fastify won't attempt to
  // send its own response after the handler returns.
  app.get('/audit/stream', (req, reply) => {
    reply.hijack()

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Flush headers immediately even when the ring is empty —
    // required so Node.js actually sends the HTTP response line to the client.
    reply.raw.flushHeaders()

    // Replay existing entries on connect
    for (const entry of auditRing.getAll()) {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`)
    }

    // Subscribe to future entries
    const unsubscribe = auditRing.subscribe((entry) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`)
      }
    })

    // Clean up and close the underlying socket when the client disconnects
    req.raw.on('close', () => {
      unsubscribe()
      if (!reply.raw.destroyed) {
        reply.raw.end()
      }
    })
  })
}
