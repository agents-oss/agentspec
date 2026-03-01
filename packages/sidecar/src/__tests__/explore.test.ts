/**
 * Unit tests for GET /explore mesh snapshot endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import { testManifest } from './fixtures.js'

// Stub fetch so probeAgent doesn't attempt real upstream connections
const originalFetch = global.fetch

beforeEach(() => {
  global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

interface ExploreResponse {
  agent: { name: string; version: string }
  source: string
  model: { provider: string; id: string; configStatus: string }
  tools: Array<{ name: string; type: string; readOnly: boolean; destructive: boolean; status: string }>
  subagents: unknown[]
  dependencies: Array<{ type: string; connection: string; status: string }>
  sidecar: { version: string; uptime: number }
}

describe('GET /explore', () => {
  it('returns 200', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    expect(res.statusCode).toBe(200)
  })

  it('response has agent object with name matching manifest', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(body.agent.name).toBe('gymcoach')
  })

  it('response has agent.version', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(body.agent.version).toBe('1.0.0')
  })

  it('agent object does not expose upstreamUrl', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as Record<string, Record<string, unknown>>
    expect(body['agent']).not.toHaveProperty('upstreamUrl')
  })

  it('response has source field', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(['agent-sdk', 'manifest-static']).toContain(body.source)
  })

  it('source is manifest-static when probe unreachable', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
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
        summary: { passed: 2, failed: 0, warnings: 0, skipped: 0 },
        checks: [
          { id: 'service:redis', category: 'service', status: 'pass', severity: 'info', latencyMs: 3 },
          { id: 'tool:get-workout-history', category: 'tool', status: 'pass', severity: 'info' },
        ],
      }),
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(body.source).toBe('agent-sdk')
  })

  it('response has model object with provider and id', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(body.model.provider).toBe('groq')
    expect(body.model.id).toBe('llama-3.3-70b-versatile')
    expect(body.model.configStatus).toBe('unknown')
  })

  it('response has tools array matching spec.tools', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(body.tools).toHaveLength(2)
    expect(body.tools.map((t) => t.name)).toContain('get-workout-history')
    expect(body.tools.map((t) => t.name)).toContain('log-workout')
  })

  it('tools have readOnly, destructive, and status fields', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    const getHistory = body.tools.find((t) => t.name === 'get-workout-history')!
    expect(getHistory.readOnly).toBe(true)
    expect(getHistory.destructive).toBe(false)
    expect(typeof getHistory.status).toBe('string')
  })

  it('tools get live status from probe when sdkAvailable', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        agentName: 'gymcoach',
        timestamp: new Date().toISOString(),
        status: 'healthy',
        summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
        checks: [
          { id: 'tool:get-workout-history', category: 'tool', status: 'pass', severity: 'info' },
        ],
      }),
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    const tool = body.tools.find((t) => t.name === 'get-workout-history')!
    expect(tool.status).toBe('pass')
  })

  it('response has subagents array', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(Array.isArray(body.subagents)).toBe(true)
  })

  it('response has dependencies array', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(Array.isArray(body.dependencies)).toBe(true)
  })

  it('dependencies include redis and postgres from spec.requires.services', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    const types = body.dependencies.map((d) => d.type)
    expect(types).toContain('redis')
    expect(types).toContain('postgres')
  })

  it('dependencies get live latency from probe when sdkAvailable', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        agentName: 'gymcoach',
        timestamp: new Date().toISOString(),
        status: 'healthy',
        summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
        checks: [
          { id: 'service:redis', category: 'service', status: 'pass', severity: 'info', latencyMs: 5 },
        ],
      }),
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    const redis = body.dependencies.find((d) => d.type === 'redis')!
    expect(redis.status).toBe('pass')
    expect((redis as { latencyMs?: number }).latencyMs).toBe(5)
  })

  it('response has sidecar object with version and uptime', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing(), {
      startedAt: Date.now() - 5000,
    })
    const res = await app.inject({ method: 'GET', url: '/explore' })
    const body = JSON.parse(res.body) as ExploreResponse
    expect(body.sidecar.version).toBeTruthy()
    expect(typeof body.sidecar.uptime).toBe('number')
    expect(body.sidecar.uptime).toBeGreaterThanOrEqual(0)
  })
})
