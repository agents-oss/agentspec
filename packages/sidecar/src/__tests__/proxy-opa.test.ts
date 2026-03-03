/**
 * OPA proxy enforcement tests — split from proxy.test.ts for maintainability.
 *
 * Tests HeaderReporting data path:
 *   - Agent sets X-AgentSpec-* response headers
 *   - Sidecar reads them in onSend hook, strips them, optionally evaluates OPA
 *   - enforce mode replaces response with 403, track mode records violations
 */

import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildProxyApp } from '../proxy.js'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing, type AuditEntry } from '../audit-ring.js'
import { testManifest } from './fixtures.js'
import type { AgentSpecManifest } from '@agentspec/sdk'

// ── Mock upstream ─────────────────────────────────────────────────────────────

interface MockUpstream {
  server: Server
  url: string
  requests: Array<{
    method: string
    url: string
    headers: Record<string, string | string[] | undefined>
  }>
  setStatus(code: number): void
  /** Set response headers that the upstream will include on every response. */
  setResponseHeaders(headers: Record<string, string>): void
}

function createMockUpstream(): MockUpstream {
  let statusCode = 200
  let responseHeaders: Record<string, string> = {}

  const upstream: MockUpstream = {
    server: null as unknown as Server,
    url: '',
    requests: [],
    setStatus(code: number) {
      statusCode = code
    },
    setResponseHeaders(headers: Record<string, string>) {
      responseHeaders = { ...headers }
    },
  }

  upstream.server = createServer((req, res) => {
    upstream.requests.push({
      method: req.method!,
      url: req.url!,
      headers: req.headers as Record<string, string | string[] | undefined>,
    })

    // Echo x-request-id back so callers can read it from the proxy response
    const requestId = req.headers['x-request-id']
    if (requestId) {
      res.setHeader(
        'x-request-id',
        Array.isArray(requestId) ? requestId[0] : requestId,
      )
    }

    // Set any configured response headers (used by OPA HeaderReporting tests)
    for (const [key, value] of Object.entries(responseHeaders)) {
      res.setHeader(key, value)
    }

    // Drain the body (required even if we don't use it)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.statusCode = statusCode
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })

  return upstream
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function startMockUpstream(m: MockUpstream): Promise<void> {
  await new Promise<void>((resolve) => m.server.listen(0, '127.0.0.1', resolve))
  const addr = m.server.address() as { port: number }
  m.url = `http://127.0.0.1:${addr.port}`
}

/**
 * Poll /audit on the control plane until at least `expectedCount` entries appear.
 */
async function waitForAuditEntries(
  cpPort: number,
  expectedCount = 1,
  timeoutMs = 2000,
): Promise<AuditEntry[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${cpPort}/audit`)
    const entries = (await res.json()) as AuditEntry[]
    if (entries.length >= expectedCount) return entries
    await new Promise<void>((r) => setTimeout(r, 20))
  }
  throw new Error(
    `waitForAuditEntries: timed out after ${timeoutMs}ms waiting for ${expectedCount} entr${expectedCount === 1 ? 'y' : 'ies'}`,
  )
}

// ── OPA proxy enforcement (HeaderReporting — agent response headers) ──────────
//
// OPA is triggered by X-AgentSpec-* headers on the AGENT'S RESPONSE,
// not by client request headers (old honor system). The mock upstream sets
// these headers on its responses to simulate an sdk-langgraph-instrumented agent.

/**
 * Minimal mock OPA server.
 * Returns a configurable deny set on POST /v1/data/agentspec/agent/<name>/deny.
 */
interface MockOPA {
  server: Server
  url: string
  /** Set violations to return on the next request (empty = allow) */
  setDeny(violations: string[]): void
  /** Number of requests received */
  requests: number
}

function createMockOPA(): MockOPA {
  let denySet: string[] = []
  let requestCount = 0

  const opa: MockOPA = {
    server: null as unknown as Server,
    url: '',
    get requests() {
      return requestCount
    },
    setDeny(violations) {
      denySet = violations
    },
  }

  opa.server = createServer((_req, res) => {
    requestCount++
    let body = ''
    _req.on('data', (chunk: Buffer) => (body += chunk))
    _req.on('end', () => {
      const result = denySet.length > 0 ? denySet : undefined
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result }))
    })
  })

  return opa
}

async function startMockOPA(m: MockOPA): Promise<void> {
  await new Promise<void>((resolve) => m.server.listen(0, '127.0.0.1', resolve))
  const addr = m.server.address() as { port: number }
  m.url = `http://127.0.0.1:${addr.port}`
}

/** Manifest with PII guardrail declared — triggers pii_detector_not_invoked */
const manifestWithGuardrails: AgentSpecManifest = {
  ...testManifest,
  spec: {
    ...testManifest.spec,
    guardrails: {
      input: [{ type: 'pii-detector', action: 'scrub', fields: ['name', 'email'] }],
    },
  },
}

describe('OPA proxy enforcement (HeaderReporting — agent response headers)', () => {
  let mockOPA: MockOPA
  let opaUpstream: MockUpstream
  let opaRing: AuditRing
  let opaProxyApp: FastifyInstance
  let opaProxyPort: number
  let opaCpApp: FastifyInstance
  let opaCpPort: number

  async function buildOPAProxy(
    mode: 'enforce' | 'track' | 'off',
    mfst = manifestWithGuardrails,
  ): Promise<void> {
    opaProxyApp = await buildProxyApp(mfst, {
      upstream: opaUpstream.url,
      auditRing: opaRing,
      opaUrl: mockOPA.url,
      opaProxyMode: mode,
    })
    await opaProxyApp.listen({ port: 0, host: '127.0.0.1' })
    opaProxyPort = (opaProxyApp.server.address() as { port: number }).port

    opaCpApp = await buildControlPlaneApp(mfst, opaRing)
    await opaCpApp.listen({ port: 0, host: '127.0.0.1' })
    opaCpPort = (opaCpApp.server.address() as { port: number }).port
  }

  beforeEach(async () => {
    mockOPA = createMockOPA()
    await startMockOPA(mockOPA)

    opaUpstream = createMockUpstream()
    await startMockUpstream(opaUpstream)

    opaRing = new AuditRing()
  })

  afterEach(async () => {
    await opaProxyApp?.close()
    await opaCpApp?.close()
    await new Promise<void>((r) => opaUpstream.server.close(() => r()))
    await new Promise<void>((r) => mockOPA.server.close(() => r()))
  })

  // ── HeaderReporting — internal header stripping ───────────────────────────────

  describe('internal header stripping', () => {
    it('X-AgentSpec-Guardrails-Invoked set by agent is stripped from client response', async () => {
      // Agent sets the header on its response
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny([]) // allow
      await buildOPAProxy('track')

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      // Client must NOT see the internal header
      expect(res.headers.get('x-agentspec-guardrails-invoked')).toBeNull()
    })

    it('X-AgentSpec-Tools-Called set by agent is stripped from client response', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-tools-called': 'plan-workout' })
      mockOPA.setDeny([]) // allow
      await buildOPAProxy('track')

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(res.headers.get('x-agentspec-tools-called')).toBeNull()
    })

    it('behavioral fields stored in audit ring from agent response headers', async () => {
      opaUpstream.setResponseHeaders({
        'x-agentspec-guardrails-invoked': 'pii-detector',
        'x-agentspec-tools-called': 'plan-workout',
      })
      mockOPA.setDeny([]) // allow
      await buildOPAProxy('track')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      const entries = await waitForAuditEntries(opaCpPort)
      const entry = entries[entries.length - 1]!
      expect(entry.guardrailsInvoked).toContain('pii-detector')
      expect(entry.toolsCalled).toContain('plan-workout')
    })

    it('client request X-AgentSpec-* headers are ignored (no longer honor system)', async () => {
      // Agent does NOT set response headers (no behavioral data)
      // Client sends honor-system headers — must be ignored
      mockOPA.setDeny([])
      await buildOPAProxy('track')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, {
        headers: { 'x-agentspec-guardrails-invoked': 'pii-detector' },
      })

      // OPA should NOT have been called (no agent response headers)
      expect(mockOPA.requests).toBe(0)
    })
  })

  // ── track mode ──────────────────────────────────────────────────────────────

  describe('track mode', () => {
    it('forwards request even when OPA returns violations (agent sets headers)', async () => {
      // Agent reports it ran, OPA still denies (violation)
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('track')

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, {
        method: 'POST',
      })
      // track mode — never blocks
      expect(res.status).toBe(200)
      expect(opaUpstream.requests).toHaveLength(1)
    })

    it('records opaViolations in audit entry', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('track')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, { method: 'POST' })
      const entries = await waitForAuditEntries(opaCpPort)
      const entry = entries[entries.length - 1]!
      expect(entry.opaViolations).toEqual(['pii_detector_not_invoked'])
      expect(entry.opaBlocked).toBeFalsy()
    })

    it('sets X-AgentSpec-OPA-Violations response header', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('track')

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(res.headers.get('x-agentspec-opa-violations')).toBe(
        'pii_detector_not_invoked',
      )
    })

    it('no opaViolations in audit entry when OPA allows', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny([]) // allow
      await buildOPAProxy('track')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      const entries = await waitForAuditEntries(opaCpPort)
      expect(entries[entries.length - 1]!.opaViolations).toBeUndefined()
    })

    it('no OPA call when agent does not set behavioral headers', async () => {
      // Agent sends no X-AgentSpec-* response headers
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('track')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      // OPA should NOT be called — no behavioral data from agent
      expect(mockOPA.requests).toBe(0)
    })
  })

  // ── enforce mode ─────────────────────────────────────────────────────────────

  describe('enforce mode', () => {
    it('returns 403 when OPA denies based on agent response headers', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('enforce')

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, {
        method: 'POST',
      })
      expect(res.status).toBe(403)
    })

    it('upstream always receives the request (enforce evaluates AFTER agent responds)', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('enforce')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, { method: 'POST' })
      // Unlike the old onRequest blocking, the upstream ALWAYS processes the request.
      // The sidecar replaces the response with 403 after the fact.
      expect(opaUpstream.requests).toHaveLength(1)
    })

    it('403 body has error + violations fields', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny(['pii_detector_not_invoked', 'toxicity_threshold_exceeded'])
      await buildOPAProxy('enforce')

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      const body = (await res.json()) as {
        error: string
        blocked: boolean
        violations: string[]
      }
      expect(body.error).toBe('PolicyViolation')
      expect(body.blocked).toBe(true)
      expect(body.violations).toContain('pii_detector_not_invoked')
    })

    it('blocked request appears in audit ring with opaBlocked=true', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('enforce')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      const entries = await waitForAuditEntries(opaCpPort)
      const entry = entries[entries.length - 1]!
      expect(entry.opaBlocked).toBe(true)
      expect(entry.statusCode).toBe(403)
      expect(entry.opaViolations).toContain('pii_detector_not_invoked')
    })

    it('blocked request audit entry includes behavioral fields', async () => {
      opaUpstream.setResponseHeaders({
        'x-agentspec-guardrails-invoked': 'pii-detector',
        'x-agentspec-tools-called': 'plan-workout',
      })
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('enforce')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      const entries = await waitForAuditEntries(opaCpPort)
      const entry = entries[entries.length - 1]!
      expect(entry.guardrailsInvoked).toContain('pii-detector')
      expect(entry.toolsCalled).toContain('plan-workout')
      expect(entry.behavioralCompliant).toBe(false)
    })

    it('forwards response when OPA allows (agent headers present)', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny([]) // allow
      await buildOPAProxy('enforce')

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(res.status).toBe(200)
      expect(opaUpstream.requests).toHaveLength(1)
    })

    it('forwards when agent sends no behavioral headers (OPA not called)', async () => {
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('enforce')

      // Agent doesn't set headers → OPA not called → request passes through
      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(res.status).toBe(200)
      expect(mockOPA.requests).toBe(0)
    })
  })

  // ── off mode ─────────────────────────────────────────────────────────────────

  describe('off mode', () => {
    it('does not call OPA at all, even when agent sets behavioral headers', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('off')

      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(mockOPA.requests).toBe(0)
    })

    it('forwards request normally', async () => {
      await buildOPAProxy('off')
      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(res.status).toBe(200)
    })
  })

  // ── OPA unavailable (fail-open) ───────────────────────────────────────────

  describe('OPA unavailable', () => {
    it('track mode — forwards request when OPA is unreachable', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })

      opaProxyApp = await buildProxyApp(manifestWithGuardrails, {
        upstream: opaUpstream.url,
        auditRing: opaRing,
        opaUrl: 'http://127.0.0.1:19999', // nothing there
        opaProxyMode: 'track',
      })
      await opaProxyApp.listen({ port: 0, host: '127.0.0.1' })
      opaProxyPort = (opaProxyApp.server.address() as { port: number }).port

      opaCpApp = await buildControlPlaneApp(manifestWithGuardrails, opaRing)
      await opaCpApp.listen({ port: 0, host: '127.0.0.1' })
      opaCpPort = (opaCpApp.server.address() as { port: number }).port

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(res.status).toBe(200)
    })

    it('enforce mode — forwards request when OPA is unreachable (fail-open)', async () => {
      opaUpstream.setResponseHeaders({ 'x-agentspec-guardrails-invoked': 'pii-detector' })

      opaProxyApp = await buildProxyApp(manifestWithGuardrails, {
        upstream: opaUpstream.url,
        auditRing: opaRing,
        opaUrl: 'http://127.0.0.1:19999',
        opaProxyMode: 'enforce',
      })
      await opaProxyApp.listen({ port: 0, host: '127.0.0.1' })
      opaProxyPort = (opaProxyApp.server.address() as { port: number }).port

      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      // OPA unavailable → allow=true (queryOPA fail-open behaviour)
      expect(res.status).toBe(200)
    })
  })
})
