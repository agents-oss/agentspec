/**
 * Unit tests for /health/live and /health/ready control plane endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import { testManifest } from './fixtures.js'

// Mock @agentspec/sdk runHealthCheck so tests don't make real HTTP calls
vi.mock('@agentspec/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentspec/sdk')>()
  return {
    ...original,
    runHealthCheck: vi.fn().mockResolvedValue({
      agentName: 'gymcoach',
      timestamp: new Date().toISOString(),
      status: 'healthy',
      summary: { passed: 2, failed: 0, warnings: 0, skipped: 0 },
      checks: [
        { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
        { id: 'env:REDIS_URL', category: 'env', status: 'pass', severity: 'error' },
      ],
    }),
  }
})

// Stub fetch so probeAgent doesn't attempt real upstream connections in tests
const originalFetch = global.fetch

beforeEach(() => {
  global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('/health/live', () => {
  it('returns 200 with { status: "live" }', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ status: 'live' })
  })
})

describe('/health/ready', () => {
  beforeEach(async () => {
    const { runHealthCheck } = await import('@agentspec/sdk')
    vi.mocked(runHealthCheck).mockResolvedValue({
      agentName: 'gymcoach',
      timestamp: new Date().toISOString(),
      status: 'healthy',
      summary: { passed: 2, failed: 0, warnings: 0, skipped: 0 },
      checks: [
        { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
      ],
    })
  })

  it('returns 200 when all checks pass', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
  })

  it('response has status field', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { status: string }
    expect(['ready', 'degraded', 'unavailable']).toContain(body.status)
  })

  it('response has source field (agent-sdk or manifest-static)', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { source: string }
    expect(['agent-sdk', 'manifest-static']).toContain(body.source)
  })

  it('source is manifest-static when probe is unreachable', async () => {
    // fetch is already mocked to reject in beforeEach — no upstream running
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { source: string }
    expect(body.source).toBe('manifest-static')
  })

  it('source is agent-sdk when probe returns valid HealthReport', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        agentName: 'gymcoach',
        timestamp: new Date().toISOString(),
        status: 'healthy',
        summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
        checks: [{ id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' }],
      }),
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { source: string }
    expect(body.source).toBe('agent-sdk')
  })

  it('response has agentName matching manifest', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { agentName: string }
    expect(body.agentName).toBe('gymcoach')
  })

  it('response has checks array', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { checks: unknown[] }
    expect(Array.isArray(body.checks)).toBe(true)
  })

  it('returns status "degraded" when SDK reports degraded', async () => {
    const { runHealthCheck } = await import('@agentspec/sdk')
    vi.mocked(runHealthCheck).mockResolvedValueOnce({
      agentName: 'gymcoach',
      timestamp: new Date().toISOString(),
      status: 'degraded',
      summary: { passed: 1, failed: 1, warnings: 0, skipped: 0 },
      checks: [
        { id: 'env:REDIS_URL', category: 'env', status: 'fail', severity: 'warning' },
      ],
    })

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { status: string }
    expect(body.status).toBe('degraded')
  })

  it('returns 503 when SDK reports unhealthy', async () => {
    const { runHealthCheck } = await import('@agentspec/sdk')
    vi.mocked(runHealthCheck).mockResolvedValueOnce({
      agentName: 'gymcoach',
      timestamp: new Date().toISOString(),
      status: 'unhealthy',
      summary: { passed: 0, failed: 2, warnings: 0, skipped: 0 },
      checks: [
        { id: 'env:GROQ_API_KEY', category: 'env', status: 'fail', severity: 'error' },
      ],
    })

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
  })
})
