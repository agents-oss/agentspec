/**
 * Unit tests for GET /explain/:requestId endpoint.
 *
 * Covers:
 *  - 404 for unknown requestId
 *  - 200 with ExplainTrace shape for known requestId
 *  - Trace fields: requestId, timestamp, method, path, durationMs, statusCode
 *  - Steps: request_received always first
 *  - Steps: response with result: 'success' for 2xx
 *  - Steps: response with result: 'error' for 4xx/5xx
 *  - No response step when statusCode is absent (e.g. aborted request)
 */

import { describe, it, expect } from 'vitest'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import { testManifest } from './fixtures.js'
import type { ExplainTrace } from '../control-plane/explain.js'

// ── helpers ───────────────────────────────────────────────────────────────────

async function getExplain(
  app: Awaited<ReturnType<typeof buildControlPlaneApp>>,
  requestId: string,
) {
  return app.inject({ method: 'GET', url: `/explain/${requestId}` })
}

// ── 404 cases ─────────────────────────────────────────────────────────────────

describe('GET /explain/:requestId — 404', () => {
  it('returns 404 for an unknown requestId', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await getExplain(app, 'does-not-exist')
    expect(res.statusCode).toBe(404)
  })

  it('404 body contains an error message with the unknown requestId', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await getExplain(app, 'ghost-id')
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toContain('ghost-id')
  })
})

// ── 200 — trace shape ─────────────────────────────────────────────────────────

describe('GET /explain/:requestId — 200 trace', () => {
  it('returns 200 for a known requestId', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-001',
      timestamp: '2026-01-01T00:00:00.000Z',
      method: 'POST',
      path: '/v1/chat',
      statusCode: 200,
      durationMs: 42,
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-001')
    expect(res.statusCode).toBe(200)
  })

  it('trace.requestId matches the requested id', async () => {
    const ring = new AuditRing()
    ring.push({ requestId: 'req-abc', timestamp: '', method: 'GET', path: '/' })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-abc')
    const trace = JSON.parse(res.body) as ExplainTrace
    expect(trace.requestId).toBe('req-abc')
  })

  it('trace contains method and path from the audit entry', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-x',
      timestamp: '2026-01-01T00:00:00.000Z',
      method: 'POST',
      path: '/v1/chat',
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-x')
    const trace = JSON.parse(res.body) as ExplainTrace
    expect(trace.method).toBe('POST')
    expect(trace.path).toBe('/v1/chat')
  })

  it('trace contains timestamp from the audit entry', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-y',
      timestamp: '2026-06-15T12:00:00.000Z',
      method: 'GET',
      path: '/',
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-y')
    const trace = JSON.parse(res.body) as ExplainTrace
    expect(trace.timestamp).toBe('2026-06-15T12:00:00.000Z')
  })

  it('trace.durationMs is present when audit entry has it', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-dur',
      timestamp: '',
      method: 'POST',
      path: '/chat',
      durationMs: 123,
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-dur')
    const trace = JSON.parse(res.body) as ExplainTrace
    expect(trace.durationMs).toBe(123)
  })

  it('trace.statusCode mirrors the audit entry', async () => {
    const ring = new AuditRing()
    ring.push({ requestId: 'req-sc', timestamp: '', method: 'GET', path: '/', statusCode: 404 })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-sc')
    const trace = JSON.parse(res.body) as ExplainTrace
    expect(trace.statusCode).toBe(404)
  })

  it('trace has a steps array', async () => {
    const ring = new AuditRing()
    ring.push({ requestId: 'req-s', timestamp: '', method: 'GET', path: '/' })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-s')
    const trace = JSON.parse(res.body) as ExplainTrace
    expect(Array.isArray(trace.steps)).toBe(true)
    expect(trace.steps.length).toBeGreaterThan(0)
  })
})

// ── Steps reconstruction ──────────────────────────────────────────────────────

describe('GET /explain/:requestId — steps', () => {
  it('first step is always request_received', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-step-1',
      timestamp: '',
      method: 'POST',
      path: '/v1/chat',
      statusCode: 200,
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-step-1')
    const trace = JSON.parse(res.body) as ExplainTrace
    expect(trace.steps[0]?.step).toBe('request_received')
  })

  it('request_received result contains method and path', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-step-2',
      timestamp: '',
      method: 'POST',
      path: '/v1/chat',
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-step-2')
    const trace = JSON.parse(res.body) as ExplainTrace
    expect(trace.steps[0]?.result).toContain('POST')
    expect(trace.steps[0]?.result).toContain('/v1/chat')
  })

  it('includes response step with result "success" for 2xx status', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-200',
      timestamp: '',
      method: 'POST',
      path: '/v1/chat',
      statusCode: 200,
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-200')
    const trace = JSON.parse(res.body) as ExplainTrace
    const responseStep = trace.steps.find((s) => s.step === 'response')
    expect(responseStep).toBeDefined()
    expect(responseStep?.result).toBe('success')
  })

  it('includes response step with result "error" for 4xx status', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-422',
      timestamp: '',
      method: 'POST',
      path: '/v1/chat',
      statusCode: 422,
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-422')
    const trace = JSON.parse(res.body) as ExplainTrace
    const responseStep = trace.steps.find((s) => s.step === 'response')
    expect(responseStep?.result).toBe('error')
  })

  it('includes response step with result "error" for 5xx status', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-500',
      timestamp: '',
      method: 'GET',
      path: '/health',
      statusCode: 503,
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-500')
    const trace = JSON.parse(res.body) as ExplainTrace
    const responseStep = trace.steps.find((s) => s.step === 'response')
    expect(responseStep?.result).toBe('error')
  })

  it('does not include a response step when statusCode is absent (aborted)', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-abort',
      timestamp: '',
      method: 'POST',
      path: '/v1/chat',
      // statusCode deliberately omitted — aborted before response
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await getExplain(app, 'req-abort')
    const trace = JSON.parse(res.body) as ExplainTrace
    const responseStep = trace.steps.find((s) => s.step === 'response')
    expect(responseStep).toBeUndefined()
    // Only the request_received step should be present
    expect(trace.steps).toHaveLength(1)
  })
})
