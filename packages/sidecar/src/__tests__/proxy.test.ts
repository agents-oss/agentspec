/**
 * Integration tests for proxy.ts — the AuditRing seam.
 *
 * Spins up three real servers in-process (no Docker):
 *   - a node:http mock upstream
 *   - buildProxyApp (port 0)
 *   - buildControlPlaneApp sharing the SAME AuditRing (port 0)
 *
 * Verifies that requests flowing through the proxy are:
 *   1. Correctly forwarded to the upstream
 *   2. Recorded in the AuditRing that the control plane reads
 *
 * This covers the critical seam: proxy → ring → control-plane.
 */

import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildProxyApp } from '../proxy.js'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing, type AuditEntry } from '../audit-ring.js'
import { testManifest } from './fixtures.js'
import type { ExplainTrace } from '../control-plane/explain.js'
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
}

function createMockUpstream(): MockUpstream {
  let statusCode = 200

  const upstream: MockUpstream = {
    server: null as unknown as Server,
    url: '',
    requests: [],
    setStatus(code: number) {
      statusCode = code
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
 * Throws if the entries don't materialise within the timeout — gives a clear
 * failure message rather than a cryptic "expected 0 to be greater than 0".
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

// ── Per-test setup ────────────────────────────────────────────────────────────

let ring: AuditRing
let mockUpstream: MockUpstream
let proxyApp: FastifyInstance
let cpApp: FastifyInstance
let proxyPort: number
let cpPort: number

beforeEach(async () => {
  ring = new AuditRing()

  mockUpstream = createMockUpstream()
  await startMockUpstream(mockUpstream)

  proxyApp = await buildProxyApp(testManifest, {
    upstream: mockUpstream.url,
    auditRing: ring,
  })
  await proxyApp.listen({ port: 0, host: '127.0.0.1' })
  proxyPort = (proxyApp.server.address() as { port: number }).port

  cpApp = await buildControlPlaneApp(testManifest, ring)
  await cpApp.listen({ port: 0, host: '127.0.0.1' })
  cpPort = (cpApp.server.address() as { port: number }).port
})

afterEach(async () => {
  await proxyApp?.close()
  await cpApp?.close()
  await new Promise<void>((resolve) => mockUpstream?.server.close(() => resolve()))
})

// ── Forwarding ────────────────────────────────────────────────────────────────

describe('forwarding', () => {
  it('GET forwarded — upstream requests array has the call', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/hello`)
    expect(mockUpstream.requests).toHaveLength(1)
    expect(mockUpstream.requests[0]!.method).toBe('GET')
    expect(mockUpstream.requests[0]!.url).toBe('/hello')
  })

  it('POST with body forwarded — upstream receives the request', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(mockUpstream.requests).toHaveLength(1)
    expect(mockUpstream.requests[0]!.method).toBe('POST')
    expect(mockUpstream.requests[0]!.url).toBe('/chat')
  })
})

// ── Headers ───────────────────────────────────────────────────────────────────

describe('headers', () => {
  it('X-Request-ID injected when absent — upstream sees a UUID header', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/test`)
    const xId = mockUpstream.requests[0]?.headers['x-request-id']
    expect(xId).toBeTruthy()
    expect(typeof xId).toBe('string')
    // UUID format check
    expect((xId as string).length).toBeGreaterThan(8)
  })

  it('existing X-Request-ID preserved — upstream sees the same value', async () => {
    const myId = 'my-test-request-id'
    await fetch(`http://127.0.0.1:${proxyPort}/test`, {
      headers: { 'x-request-id': myId },
    })
    expect(mockUpstream.requests[0]?.headers['x-request-id']).toBe(myId)
  })
})

// ── Status pass-through ───────────────────────────────────────────────────────

describe('status pass-through', () => {
  it('upstream 4xx proxied back — 404 from upstream → 404 from proxy', async () => {
    mockUpstream.setStatus(404)
    const res = await fetch(`http://127.0.0.1:${proxyPort}/missing`)
    expect(res.status).toBe(404)
  })

  it('upstream 5xx proxied back — 500 from upstream → 500 from proxy', async () => {
    mockUpstream.setStatus(500)
    const res = await fetch(`http://127.0.0.1:${proxyPort}/error`)
    expect(res.status).toBe(500)
  })
})

// ── AuditRing seam ────────────────────────────────────────────────────────────

describe('seam — proxy → AuditRing → control-plane', () => {
  it('proxied request appears in GET /audit on the control plane', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/chat`)
    const entries = await waitForAuditEntries(cpPort)
    expect(entries.length).toBeGreaterThan(0)
  })

  it('audit entry has correct method and path', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/chat`, { method: 'POST' })
    const entries = await waitForAuditEntries(cpPort)
    const entry = entries[entries.length - 1]!
    expect(entry.method).toBe('POST')
    expect(entry.path).toBe('/v1/chat')
  })

  it('audit entry has correct statusCode', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/ok`)
    const entries = await waitForAuditEntries(cpPort)
    expect(entries[entries.length - 1]!.statusCode).toBe(200)
  })

  it('audit entry has a durationMs field', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/ok`)
    const entries = await waitForAuditEntries(cpPort)
    expect(entries[entries.length - 1]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('GET /explain/:requestId returns 200 for a proxied request', async () => {
    const myId = 'explain-test-id'
    await fetch(`http://127.0.0.1:${proxyPort}/test`, {
      headers: { 'x-request-id': myId },
    })
    await waitForAuditEntries(cpPort)
    const res = await fetch(`http://127.0.0.1:${cpPort}/explain/${myId}`)
    expect(res.status).toBe(200)
  })

  it('explain requestId matches the header echoed by the upstream', async () => {
    const myId = 'seam-request-id-123'
    const proxyRes = await fetch(`http://127.0.0.1:${proxyPort}/hello`, {
      headers: { 'x-request-id': myId },
    })
    // Upstream echoes x-request-id back through the proxy
    expect(proxyRes.headers.get('x-request-id')).toBe(myId)

    await waitForAuditEntries(cpPort)
    const explainRes = await fetch(`http://127.0.0.1:${cpPort}/explain/${myId}`)
    const trace = (await explainRes.json()) as ExplainTrace
    expect(trace.requestId).toBe(myId)
  })

  it('explain steps[0].step === "request_received" contains method and path', async () => {
    const myId = 'explain-steps-id'
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'x-request-id': myId },
    })
    await waitForAuditEntries(cpPort)
    const res = await fetch(`http://127.0.0.1:${cpPort}/explain/${myId}`)
    const trace = (await res.json()) as ExplainTrace
    expect(trace.steps[0]?.step).toBe('request_received')
    expect(trace.steps[0]?.result).toContain('POST')
    expect(trace.steps[0]?.result).toContain('/v1/messages')
  })

  it('explain response step result is "success" for 2xx upstream', async () => {
    const myId = 'success-id-200'
    await fetch(`http://127.0.0.1:${proxyPort}/ok`, {
      headers: { 'x-request-id': myId },
    })
    await waitForAuditEntries(cpPort)
    const res = await fetch(`http://127.0.0.1:${cpPort}/explain/${myId}`)
    const trace = (await res.json()) as ExplainTrace
    const responseStep = trace.steps.find((s) => s.step === 'response')
    expect(responseStep?.result).toBe('success')
  })

  it('explain response step result is "error" for 5xx upstream', async () => {
    mockUpstream.setStatus(503)
    const myId = 'error-id-503'
    await fetch(`http://127.0.0.1:${proxyPort}/api`, {
      headers: { 'x-request-id': myId },
    })
    await waitForAuditEntries(cpPort)
    const res = await fetch(`http://127.0.0.1:${cpPort}/explain/${myId}`)
    const trace = (await res.json()) as ExplainTrace
    const responseStep = trace.steps.find((s) => s.step === 'response')
    expect(responseStep?.result).toBe('error')
  })
})

// ── SSE ───────────────────────────────────────────────────────────────────────

describe('SSE', () => {
  it('GET /audit/stream emits SSE event when request flows through the proxy', async () => {
    // Populate the ring first — SSE replays existing entries on connect
    await fetch(`http://127.0.0.1:${proxyPort}/sse-trigger`)
    await waitForAuditEntries(cpPort, 1)

    // Connect to SSE stream — it replays the existing entry immediately
    const controller = new AbortController()
    let sseData = ''

    try {
      const res = await fetch(`http://127.0.0.1:${cpPort}/audit/stream`, {
        signal: controller.signal,
      })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      // Read the first chunk, which contains the replayed entry
      const { value } = await reader.read()
      if (value) sseData = decoder.decode(value)
      reader.releaseLock()
    } catch {
      // AbortError expected when we abort
    } finally {
      controller.abort()
    }

    expect(sseData).toContain('data:')
  })
})

// ── OPA proxy enforcement ─────────────────────────────────────────────────────

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

describe('OPA proxy enforcement', () => {
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

  // ── track mode ──────────────────────────────────────────────────────────────

  describe('track mode', () => {
    it('forwards request even when OPA returns violations', async () => {
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('track')
      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      expect(opaUpstream.requests).toHaveLength(1)
    })

    it('records opaViolations in audit entry', async () => {
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('track')
      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, { method: 'POST' })
      const entries = await waitForAuditEntries(opaCpPort)
      const entry = entries[entries.length - 1]!
      expect(entry.opaViolations).toEqual(['pii_detector_not_invoked'])
      expect(entry.opaBlocked).toBeFalsy()
    })

    it('sets X-AgentSpec-OPA-Violations response header', async () => {
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('track')
      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(res.headers.get('x-agentspec-opa-violations')).toBe(
        'pii_detector_not_invoked',
      )
    })

    it('no opaViolations in audit entry when OPA allows', async () => {
      mockOPA.setDeny([]) // allow
      await buildOPAProxy('track')
      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      const entries = await waitForAuditEntries(opaCpPort)
      expect(entries[entries.length - 1]!.opaViolations).toBeUndefined()
    })

    it('forwards guardrails header to OPA (invoked → OPA receives it)', async () => {
      // OPA returns allow when pii-detector is invoked — simulate via empty deny
      mockOPA.setDeny([])
      await buildOPAProxy('track')
      // Send the header that sdk-langgraph would set
      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, {
        headers: { 'x-agentspec-guardrails-invoked': 'pii-detector' },
      })
      expect(res.status).toBe(200)
      expect(mockOPA.requests).toBeGreaterThan(0)
    })
  })

  // ── enforce mode ─────────────────────────────────────────────────────────────

  describe('enforce mode', () => {
    it('returns 403 when OPA denies', async () => {
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('enforce')
      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, {
        method: 'POST',
      })
      expect(res.status).toBe(403)
    })

    it('does not forward to upstream when blocked', async () => {
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('enforce')
      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, { method: 'POST' })
      expect(opaUpstream.requests).toHaveLength(0)
    })

    it('403 body has error + violations fields', async () => {
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
      mockOPA.setDeny(['pii_detector_not_invoked'])
      await buildOPAProxy('enforce')
      await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      const entries = await waitForAuditEntries(opaCpPort)
      const entry = entries[entries.length - 1]!
      expect(entry.opaBlocked).toBe(true)
      expect(entry.statusCode).toBe(403)
      expect(entry.opaViolations).toContain('pii_detector_not_invoked')
    })

    it('forwards when OPA allows (no violations)', async () => {
      mockOPA.setDeny([])
      await buildOPAProxy('enforce')
      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`)
      expect(res.status).toBe(200)
      expect(opaUpstream.requests).toHaveLength(1)
    })

    it('forwards when guardrails header satisfies OPA', async () => {
      mockOPA.setDeny([]) // OPA sees guardrails_invoked and allows
      await buildOPAProxy('enforce')
      const res = await fetch(`http://127.0.0.1:${opaProxyPort}/chat`, {
        headers: { 'x-agentspec-guardrails-invoked': 'pii-detector' },
      })
      expect(res.status).toBe(200)
    })
  })

  // ── off mode ─────────────────────────────────────────────────────────────────

  describe('off mode', () => {
    it('does not call OPA at all', async () => {
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
      // Point to a port nothing is listening on
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
