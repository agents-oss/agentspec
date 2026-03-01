import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import httpProxy from '@fastify/http-proxy'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { AuditRing } from './audit-ring.js'
import { config } from './config.js'

// Augment Fastify's request type to carry per-request timing metadata
declare module 'fastify' {
  interface FastifyRequest {
    _startedAt?: number
  }
}

export interface ProxyAppOptions {
  logger?: boolean
  upstream?: string
  auditRing?: AuditRing
}

export async function buildProxyApp(
  _manifest: AgentSpecManifest,
  opts: ProxyAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false })
  const auditRing = opts.auditRing ?? new AuditRing(config.auditRingSize)
  const upstream = opts.upstream ?? config.upstreamUrl

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID()
    request.headers['x-request-id'] = requestId
    // Store start time on the request object — avoids a separate Map
    // and ensures it is always cleaned up with the request lifecycle.
    request._startedAt = Date.now()
  })

  app.addHook('onResponse', async (request: FastifyRequest, reply) => {
    const requestId = request.headers['x-request-id'] as string
    auditRing.push({
      requestId,
      timestamp: new Date().toISOString(),
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      durationMs:
        request._startedAt !== undefined
          ? Date.now() - request._startedAt
          : undefined,
    })
  })

  // onRequestAbort fires when the client disconnects before a response is sent.
  // Without this, aborted requests would leave dangling start-time entries.
  // Since we now store timing on the request object itself, no extra cleanup is
  // needed — but we still push a partial audit entry so the request is visible.
  app.addHook('onRequestAbort', async (request: FastifyRequest) => {
    const requestId = request.headers['x-request-id'] as string
    if (!requestId) return
    auditRing.push({
      requestId,
      timestamp: new Date().toISOString(),
      method: request.method,
      path: request.url,
      statusCode: undefined, // aborted — no response status
      durationMs:
        request._startedAt !== undefined
          ? Date.now() - request._startedAt
          : undefined,
      excerpt: 'aborted',
    })
  })

  await app.register(httpProxy, {
    upstream,
    disableRequestLogging: true,
  })

  return app
}
