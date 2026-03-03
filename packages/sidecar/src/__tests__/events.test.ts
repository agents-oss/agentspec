/**
 * Tests for POST /agentspec/events — EventPush behavioral observation endpoint.
 *
 * Uses buildControlPlaneApp (which registers /events) with a shared AuditRing,
 * pre-populated with a test entry to simulate a proxied request.
 */

import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import { testManifest } from './fixtures.js'
import type { AgentSpecManifest } from '@agentspec/sdk'

// ── Mock OPA ─────────────────────────────────────────────────────────────────

interface MockOPA {
  server: Server
  url: string
  setDeny(violations: string[]): void
  requests: number
}

function createMockOPA(): MockOPA {
  let denySet: string[] = []
  let requestCount = 0

  const opa: MockOPA = {
    server: null as unknown as Server,
    url: '',
    get requests() { return requestCount },
    setDeny(v) { denySet = v },
  }

  opa.server = createServer((_req, res) => {
    requestCount++
    let body = ''
    _req.on('data', (c: Buffer) => (body += c))
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

// ── Test fixture ──────────────────────────────────────────────────────────────

const KNOWN_REQUEST_ID = 'test-req-id-abc-123'

const manifestWithGuardrails: AgentSpecManifest = {
  ...testManifest,
  spec: {
    ...testManifest.spec,
    guardrails: {
      input: [{ type: 'pii-detector', action: 'scrub', fields: ['name', 'email'] }],
    },
  },
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /events', () => {
  let ring: AuditRing
  let app: FastifyInstance

  beforeEach(async () => {
    ring = new AuditRing()
    // Pre-populate the ring with an entry as if the proxy had seen this request
    ring.push({
      requestId: KNOWN_REQUEST_ID,
      timestamp: new Date().toISOString(),
      method: 'POST',
      path: '/chat',
      statusCode: 200,
      durationMs: 42,
    })

    app = await buildControlPlaneApp(testManifest, ring)
  })

  afterEach(async () => {
    await app?.close()
  })

  it('returns 400 when requestId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: { agentName: 'gymcoach', events: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when events is not an array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: { requestId: KNOWN_REQUEST_ID, agentName: 'gymcoach', events: 'bad' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 202 when requestId is not in the audit ring', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: { requestId: 'unknown-id', agentName: 'gymcoach', events: [] },
    })
    expect(res.statusCode).toBe(202)
    const body = JSON.parse(res.body) as { found: boolean }
    expect(body.found).toBe(false)
  })

  it('returns 200 with found=true when requestId is in the audit ring', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { found: boolean; requestId: string }
    expect(body.found).toBe(true)
    expect(body.requestId).toBe(KNOWN_REQUEST_ID)
  })

  it('updates guardrailsInvoked on the audit entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [
          { type: 'guardrail', guardrailType: 'pii-detector', invoked: true, blocked: false },
        ],
      },
    })

    const entry = ring.findById(KNOWN_REQUEST_ID)
    expect(entry?.guardrailsInvoked).toEqual(['pii-detector'])
  })

  it('updates toolsCalled on the audit entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [
          { type: 'tool', name: 'plan-workout', success: true, latencyMs: 82 },
        ],
      },
    })

    const entry = ring.findById(KNOWN_REQUEST_ID)
    expect(entry?.toolsCalled).toEqual(['plan-workout'])
  })

  it('updates modelCalls on the audit entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [
          { type: 'model', modelId: 'groq/llama-3.3-70b', tokenCount: 850 },
        ],
      },
    })

    const entry = ring.findById(KNOWN_REQUEST_ID)
    expect(entry?.modelCalls).toEqual([{ modelId: 'groq/llama-3.3-70b', tokenCount: 850 }])
  })

  it('updates multiple event types in a single batch', async () => {
    await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [
          { type: 'guardrail', guardrailType: 'pii-detector', invoked: true, blocked: false },
          { type: 'tool', name: 'plan-workout', success: true, latencyMs: 55 },
          { type: 'model', modelId: 'groq/llama-3.3-70b', tokenCount: 500 },
          { type: 'memory', backend: 'redis', ttlSeconds: 3600, piiScrubbed: true },
        ],
      },
    })

    const entry = ring.findById(KNOWN_REQUEST_ID)
    expect(entry?.guardrailsInvoked).toEqual(['pii-detector'])
    expect(entry?.toolsCalled).toEqual(['plan-workout'])
    expect(entry?.modelCalls).toEqual([{ modelId: 'groq/llama-3.3-70b', tokenCount: 500 }])
  })

  it('updated entry appears in GET /audit', async () => {
    await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [
          { type: 'guardrail', guardrailType: 'pii-detector', invoked: true, blocked: false },
        ],
      },
    })

    const auditRes = await app.inject({ method: 'GET', url: '/audit' })
    const entries = JSON.parse(auditRes.body) as Array<{
      requestId: string
      guardrailsInvoked?: string[]
    }>
    const entry = entries.find((e) => e.requestId === KNOWN_REQUEST_ID)
    expect(entry?.guardrailsInvoked).toEqual(['pii-detector'])
  })

  it('returns empty opaViolations array when OPA is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [
          { type: 'guardrail', guardrailType: 'pii-detector', invoked: true, blocked: false },
        ],
      },
    })
    const body = JSON.parse(res.body) as { opaViolations: string[] }
    expect(body.opaViolations).toEqual([])
  })

  it('skips guardrail events with invoked=false', async () => {
    await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [
          { type: 'guardrail', guardrailType: 'pii-detector', invoked: false, blocked: false },
        ],
      },
    })

    const entry = ring.findById(KNOWN_REQUEST_ID)
    // invoked=false → not recorded in guardrailsInvoked
    expect(entry?.guardrailsInvoked).toBeUndefined()
  })

  it('handles malformed events gracefully (no crash)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [null, undefined, { type: 42 }, 'bad'],
      },
    })
    // Should not crash — still returns 200 (entry found)
    expect(res.statusCode).toBe(200)
  })
})

// ── OPA integration tests ─────────────────────────────────────────────────────

describe('POST /events with OPA', () => {
  let ring: AuditRing
  let app: FastifyInstance
  let mockOPA: MockOPA

  beforeEach(async () => {
    mockOPA = createMockOPA()
    await startMockOPA(mockOPA)

    ring = new AuditRing()
    ring.push({
      requestId: KNOWN_REQUEST_ID,
      timestamp: new Date().toISOString(),
      method: 'POST',
      path: '/chat',
      statusCode: 200,
    })
  })

  afterEach(async () => {
    await app?.close()
    await new Promise<void>((r) => mockOPA.server.close(() => r()))
  })

  it('calls OPA and returns violations when OPA denies', async () => {
    mockOPA.setDeny(['pii_detector_not_invoked'])
    // Pass opaUrl directly to avoid env-var module-caching issues
    app = await buildControlPlaneApp(manifestWithGuardrails, ring, { opaUrl: mockOPA.url })

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [{ type: 'tool', name: 'plan-workout', success: true }],
      },
    })

    const body = JSON.parse(res.body) as {
      found: boolean
      opaViolations: string[]
    }
    expect(body.found).toBe(true)
    expect(body.opaViolations).toContain('pii_detector_not_invoked')
    expect(mockOPA.requests).toBeGreaterThan(0)
  })

  it('sets behavioralCompliant=true when OPA allows', async () => {
    mockOPA.setDeny([]) // allow
    app = await buildControlPlaneApp(manifestWithGuardrails, ring, { opaUrl: mockOPA.url })

    await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [
          { type: 'guardrail', guardrailType: 'pii-detector', invoked: true, blocked: false },
        ],
      },
    })

    const entry = ring.findById(KNOWN_REQUEST_ID)
    expect(entry?.behavioralCompliant).toBe(true)
  })

  it('sets behavioralCompliant=false when OPA denies', async () => {
    mockOPA.setDeny(['pii_detector_not_invoked'])
    app = await buildControlPlaneApp(manifestWithGuardrails, ring, { opaUrl: mockOPA.url })

    await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [{ type: 'tool', name: 'plan-workout', success: true }],
      },
    })

    const entry = ring.findById(KNOWN_REQUEST_ID)
    expect(entry?.behavioralCompliant).toBe(false)
  })

  it('still returns 200 when OPA is unavailable (fail-open)', async () => {
    app = await buildControlPlaneApp(manifestWithGuardrails, ring, {
      opaUrl: 'http://127.0.0.1:19999', // nothing there
    })

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        requestId: KNOWN_REQUEST_ID,
        agentName: 'gymcoach',
        events: [{ type: 'tool', name: 'plan-workout', success: true }],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { opaViolations: string[] }
    expect(body.opaViolations).toEqual([])
  })
})
