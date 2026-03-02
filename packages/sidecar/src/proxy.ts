import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import httpProxy from '@fastify/http-proxy'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { AuditRing } from './audit-ring.js'
import { config } from './config.js'
import { buildProxyOPAInput, queryOPA } from './control-plane/opa-client.js'

// Augment Fastify's request type to carry per-request metadata
declare module 'fastify' {
  interface FastifyRequest {
    _startedAt?: number
    _opaViolations?: string[]
    _opaBlocked?: boolean
  }
}

export interface ProxyAppOptions {
  logger?: boolean
  upstream?: string
  auditRing?: AuditRing
  /**
   * OPA base URL to use for per-request policy evaluation.
   * Defaults to config.opaUrl (from OPA_URL env var).
   * Pass null to disable OPA for this instance.
   */
  opaUrl?: string | null
  /**
   * Proxy OPA enforcement mode:
   *   enforce — block with 403 when OPA denies
   *   track   — record violations in audit ring, forward the request
   *   off     — disable OPA proxy checks entirely
   * Defaults to config.opaProxyMode (from OPA_PROXY_MODE env var, default 'track').
   */
  opaProxyMode?: 'enforce' | 'track' | 'off'
}

export async function buildProxyApp(
  manifest: AgentSpecManifest,
  opts: ProxyAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false })
  const auditRing = opts.auditRing ?? new AuditRing(config.auditRingSize)
  const upstream = opts.upstream ?? config.upstreamUrl
  const opaUrl = opts.opaUrl !== undefined ? opts.opaUrl : config.opaUrl
  const opaMode = opts.opaProxyMode ?? config.opaProxyMode

  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    // ── 1. Request ID injection ────────────────────────────────────────────
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID()
    request.headers['x-request-id'] = requestId
    request._startedAt = Date.now()

    // ── 2. OPA per-request policy evaluation ──────────────────────────────
    if (opaUrl && opaMode !== 'off') {
      const opaInput = buildProxyOPAInput(
        manifest,
        request.headers as Record<string, string | string[] | undefined>,
      )
      const opaResult = await queryOPA(opaUrl, manifest.metadata.name, opaInput)

      if (opaResult.violations.length > 0) {
        request._opaViolations = opaResult.violations
        // Surface violations on the response so callers can observe them
        // (works for both track and enforce — header set before reply.send)
        reply.header('X-AgentSpec-OPA-Violations', opaResult.violations.join(','))
      }

      if (opaMode === 'enforce' && !opaResult.allow) {
        // Record the blocked request in the audit ring before replying
        auditRing.push({
          requestId,
          timestamp: new Date().toISOString(),
          method: request.method,
          path: request.url,
          statusCode: 403,
          durationMs:
            request._startedAt !== undefined
              ? Date.now() - request._startedAt
              : 0,
          opaViolations: opaResult.violations,
          opaBlocked: true,
        })
        request._opaBlocked = true
        reply.code(403).header('Content-Type', 'application/json').send({
          error: 'PolicyViolation',
          blocked: true,
          violations: opaResult.violations,
          message: `Request blocked by OPA policy: ${opaResult.violations.join(', ')}`,
        })
      }
    }
  })

  app.addHook('onResponse', async (request: FastifyRequest, reply) => {
    // Skip — already recorded in the OPA block branch of onRequest
    if (request._opaBlocked) return

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
      opaViolations: request._opaViolations,
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
