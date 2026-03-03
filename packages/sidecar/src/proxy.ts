import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import httpProxy from '@fastify/http-proxy'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { AuditRing } from './audit-ring.js'
import { config } from './config.js'
import {
  buildBehavioralOPAInput,
  parseCommaSeparatedHeader,
  queryOPA,
} from './control-plane/opa-client.js'

// Augment Fastify's request type to carry per-request metadata
declare module 'fastify' {
  interface FastifyRequest {
    _startedAt?: number
    _opaViolations?: string[]
    _opaBlocked?: boolean
    /** Guardrail types that the agent reported it actually ran (HeaderReporting). */
    _agentGuardrailsInvoked?: string[]
    /** Tool names that the agent reported it called (HeaderReporting). */
    _agentToolsCalled?: string[]
    /** Whether OPA evaluated real behavioral data and allowed the request. */
    _behavioralCompliant?: boolean
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
   *   enforce — block with 403 when OPA denies (after agent responds)
   *   track   — record violations in audit ring, forward the request
   *   off     — disable OPA proxy checks entirely
   * Defaults to config.opaProxyMode (from OPA_PROXY_MODE env var, default 'track').
   *
   * NOTE: OPA is triggered by agent RESPONSE headers (HeaderReporting), not by
   * client request headers. The agent sets X-AgentSpec-Guardrails-Invoked etc.
   * on its response; the sidecar reads them in the onSend hook before forwarding.
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

  app.addHook('onRequest', async (request: FastifyRequest) => {
    // ── Request ID injection + timing ─────────────────────────────────────────
    // OPA is no longer evaluated here — it runs in replyOptions.onResponse
    // after the agent has responded and reported what actually happened.
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID()
    request.headers['x-request-id'] = requestId
    request._startedAt = Date.now()
  })

  app.addHook('onResponse', async (request: FastifyRequest, reply) => {
    // Skip — already recorded in the OPA block branch of replyOptions.onResponse
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
      // HeaderReporting behavioral fields — populated when the agent sets response headers
      guardrailsInvoked:
        request._agentGuardrailsInvoked && request._agentGuardrailsInvoked.length > 0
          ? request._agentGuardrailsInvoked
          : undefined,
      toolsCalled:
        request._agentToolsCalled && request._agentToolsCalled.length > 0
          ? request._agentToolsCalled
          : undefined,
      behavioralCompliant: request._behavioralCompliant,
    })
  })

  // onRequestAbort fires when the client disconnects before a response is sent.
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

  /**
   * HeaderReporting data path — fires BEFORE the response body is piped to the client,
   * AFTER @fastify/reply-from has copied upstream headers onto `reply`.
   *
   * We use `onSend` (not replyOptions.onResponse) because:
   *   - onSend is fully async (awaited by Fastify)
   *   - onSend receives headers already on `reply` (not on a raw stream)
   *   - onSend can replace the payload for enforce-mode 403 blocking
   *   - replyOptions.onResponse in @fastify/reply-from v9 is NOT awaited and
   *     receives the raw stream as third arg, not a response with headers
   *
   * Steps:
   *   1. Read X-AgentSpec-* response headers set by the agent's sdk-langgraph middleware.
   *   2. Strip them so clients never see internal headers.
   *   3. If OPA is configured, evaluate the real behavioral data.
   *   4. In enforce mode: replace payload with 403 JSON if OPA denies.
   *   5. In track mode or allow: return payload unchanged.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    // ── 1. Read agent behavioral headers (already set on reply by reply-from) ────
    const rawInvoked = reply.getHeader('x-agentspec-guardrails-invoked')
    const rawTools = reply.getHeader('x-agentspec-tools-called')

    const invoked = parseCommaSeparatedHeader(
      typeof rawInvoked === 'string' ? rawInvoked
        : Array.isArray(rawInvoked) ? (rawInvoked as string[])
        : undefined,
    )
    const toolsCalled = parseCommaSeparatedHeader(
      typeof rawTools === 'string' ? rawTools
        : Array.isArray(rawTools) ? (rawTools as string[])
        : undefined,
    )

    // ── 2. Strip internal headers before forwarding to client ────────────────────
    reply.removeHeader('x-agentspec-guardrails-invoked')
    reply.removeHeader('x-agentspec-tools-called')
    reply.removeHeader('x-agentspec-user-confirmed')

    // ── 3. Store behavioral data on request for onResponse hook ──────────────────
    if (invoked.length > 0) request._agentGuardrailsInvoked = invoked
    if (toolsCalled.length > 0) request._agentToolsCalled = toolsCalled

    // ── 4. OPA evaluation from real agent response data (not client headers) ──────
    const hasBehavioralData = invoked.length > 0 || toolsCalled.length > 0
    if (opaUrl && opaMode !== 'off' && hasBehavioralData) {
      const opaInput = buildBehavioralOPAInput(manifest, invoked, toolsCalled)
      const opaResult = await queryOPA(opaUrl, manifest.metadata.name, opaInput)

      if (opaResult.violations.length > 0) {
        request._opaViolations = opaResult.violations
        reply.header('X-AgentSpec-OPA-Violations', opaResult.violations.join(','))
      }

      // Record whether OPA cleared this request based on real behavioral data
      request._behavioralCompliant = opaResult.allow

      if (opaMode === 'enforce' && !opaResult.allow) {
        // Drain the upstream response stream to avoid connection leaks
        const stream = payload as { resume?: () => void; destroy?: () => void } | null
        if (stream?.resume) stream.resume()
        else stream?.destroy?.()

        const requestId = request.headers['x-request-id'] as string
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
          guardrailsInvoked: invoked.length > 0 ? invoked : undefined,
          toolsCalled: toolsCalled.length > 0 ? toolsCalled : undefined,
          behavioralCompliant: false,
        })
        request._opaBlocked = true

        reply.code(403).header('Content-Type', 'application/json')
        return JSON.stringify({
          error: 'PolicyViolation',
          blocked: true,
          violations: opaResult.violations,
          message: `Request blocked by OPA policy: ${opaResult.violations.join(', ')}`,
        })
      }
    }

    // ── 5. Return payload unchanged — forward the upstream response ───────────────
    return payload
  })

  return app
}
