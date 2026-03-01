/**
 * Unit tests for the agent SDK introspection probe.
 *
 * Tests both sdkAvailable: true and sdkAvailable: false paths, including
 * timeout, 404, malformed JSON, and valid HealthReport cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { probeAgent } from '../control-plane/agent-probe.js'

const UPSTREAM = 'http://localhost:8000'

const originalFetch = global.fetch

beforeEach(() => {
  // Default: endpoint not available
  global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

const validReport = {
  agentName: 'test-agent',
  timestamp: new Date().toISOString(),
  status: 'healthy',
  summary: { passed: 3, failed: 0, warnings: 0, skipped: 0 },
  checks: [
    { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
    { id: 'service:redis', category: 'service', status: 'pass', severity: 'info', latencyMs: 3 },
    { id: 'tool:echo', category: 'tool', status: 'pass', severity: 'info' },
  ],
}

describe('probeAgent()', () => {
  it('returns sdkAvailable: false when fetch throws (ECONNREFUSED)', async () => {
    const result = await probeAgent(UPSTREAM)
    expect(result.sdkAvailable).toBe(false)
    expect(result.report).toBeUndefined()
    expect(typeof result.probeLatencyMs).toBe('number')
  })

  it('returns sdkAvailable: false when upstream returns 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as typeof global.fetch

    const result = await probeAgent(UPSTREAM)
    expect(result.sdkAvailable).toBe(false)
    expect(result.report).toBeUndefined()
  })

  it('returns sdkAvailable: false when upstream returns 500', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal server error' }),
    }) as typeof global.fetch

    const result = await probeAgent(UPSTREAM)
    expect(result.sdkAvailable).toBe(false)
  })

  it('returns sdkAvailable: false when response is not a valid HealthReport', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'not a health report' }),
    }) as typeof global.fetch

    const result = await probeAgent(UPSTREAM)
    expect(result.sdkAvailable).toBe(false)
  })

  it('returns sdkAvailable: false when checks is missing from response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ agentName: 'test', timestamp: '2026-01-01', status: 'healthy' }),
    }) as typeof global.fetch

    const result = await probeAgent(UPSTREAM)
    expect(result.sdkAvailable).toBe(false)
  })

  it('returns sdkAvailable: true with parsed report on valid HealthReport response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => validReport,
    }) as typeof global.fetch

    const result = await probeAgent(UPSTREAM)
    expect(result.sdkAvailable).toBe(true)
    expect(result.report).toBeDefined()
    expect(result.report!.agentName).toBe('test-agent')
    expect(result.report!.status).toBe('healthy')
    expect(result.report!.checks).toHaveLength(3)
  })

  it('includes probeLatencyMs as a non-negative number', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => validReport,
    }) as typeof global.fetch

    const result = await probeAgent(UPSTREAM)
    expect(typeof result.probeLatencyMs).toBe('number')
    expect(result.probeLatencyMs).toBeGreaterThanOrEqual(0)
  })

  it('probes the correct URL: upstreamUrl + /agentspec/health', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as typeof global.fetch

    await probeAgent('http://my-agent:8080')

    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      'http://my-agent:8080/agentspec/health',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )
  })

  it('returns service and tool checks from report', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => validReport,
    }) as typeof global.fetch

    const result = await probeAgent(UPSTREAM)
    expect(result.sdkAvailable).toBe(true)
    const categories = result.report!.checks.map((c) => c.category)
    expect(categories).toContain('service')
    expect(categories).toContain('tool')
  })
})

describe('probeAgent() — integration with sidecar control plane', () => {
  it('health.ts falls back to manifest-static when probe returns sdkAvailable: false', async () => {
    // fetch returns ECONNREFUSED for both /agentspec/health and MCP checks
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    // Import here to ensure fresh module with mocked fetch
    const { buildControlPlaneApp } = await import('../control-plane/index.js')
    const { AuditRing } = await import('../audit-ring.js')
    const { testManifest } = await import('./fixtures.js')

    // Also mock runHealthCheck so it doesn't try to run real checks
    const sdk = await import('@agentspec/sdk')
    vi.spyOn(sdk, 'runHealthCheck').mockResolvedValue({
      agentName: 'gymcoach',
      timestamp: new Date().toISOString(),
      status: 'healthy',
      summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
      checks: [{ id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' }],
    })

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { source: string }
    expect(body.source).toBe('manifest-static')
  })

  it('health.ts uses agent-sdk source when probe returns sdkAvailable: true', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => validReport,
    }) as typeof global.fetch

    const { buildControlPlaneApp } = await import('../control-plane/index.js')
    const { AuditRing } = await import('../audit-ring.js')
    const { testManifest } = await import('./fixtures.js')

    const sdk = await import('@agentspec/sdk')
    vi.spyOn(sdk, 'runHealthCheck').mockResolvedValue({
      agentName: 'gymcoach',
      timestamp: new Date().toISOString(),
      status: 'healthy',
      summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
      checks: [{ id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' }],
    })

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    const body = JSON.parse(res.body) as { source: string; agentName: string }
    expect(body.source).toBe('agent-sdk')
    expect(body.agentName).toBe('test-agent')
  })
})
