/**
 * Unit tests for AgentSpecReporter.
 *
 * Tests: caching, background refresh, graceful shutdown, httpHandler,
 * and tool check injection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import type { HealthReport } from '../health/index.js'

// ── Vitest hoisted mock setup ─────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock so the mock fn is available in the factory.

const { mockRunHealthCheck } = vi.hoisted(() => ({
  mockRunHealthCheck: vi.fn<() => Promise<HealthReport>>(),
}))

vi.mock('../health/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../health/index.js')>()
  return {
    ...original,
    runHealthCheck: mockRunHealthCheck,
  }
})

// ── Test fixtures ─────────────────────────────────────────────────────────────

const testManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: { name: 'test-reporter-agent', version: '1.0.0', description: 'test' },
  spec: {
    model: { provider: 'groq', id: 'llama-3.3-70b-versatile', apiKey: '$env:GROQ_API_KEY' },
    prompts: { system: 'You are a test agent.', hotReload: false },
    tools: [
      { name: 'tool-a', type: 'function', description: 'Tool A' },
      { name: 'tool-b', type: 'function', description: 'Tool B' },
    ],
    requires: {
      services: [{ type: 'redis', connection: '$env:REDIS_URL' }],
    },
  },
}

const healthyReport: HealthReport = {
  agentName: 'test-reporter-agent',
  timestamp: new Date().toISOString(),
  status: 'healthy',
  summary: { passed: 2, failed: 0, warnings: 0, skipped: 1 },
  checks: [
    { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
    { id: 'service:redis', category: 'service', status: 'pass', severity: 'info', latencyMs: 2 },
    { id: 'model:groq/llama-3.3-70b-versatile', category: 'model', status: 'skip', severity: 'error' },
  ],
}

// ── AgentSpecReporter tests ────────────────────────────────────────────────────

describe('AgentSpecReporter', () => {
  beforeEach(() => {
    mockRunHealthCheck.mockResolvedValue(healthyReport)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('getReport() runs synchronously on first call', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    const report = await reporter.getReport()
    expect(report.agentName).toBe('test-reporter-agent')
  })

  it('getReport() returns a valid HealthReport', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    const report = await reporter.getReport()
    expect(typeof report.agentName).toBe('string')
    expect(typeof report.timestamp).toBe('string')
    expect(['healthy', 'degraded', 'unhealthy']).toContain(report.status)
    expect(Array.isArray(report.checks)).toBe(true)
    expect(typeof report.summary.passed).toBe('number')
  })

  it('getReport() adds tool checks — unregistered tools report fail', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    const report = await reporter.getReport()
    const toolChecks = report.checks.filter((c) => c.category === 'tool')
    expect(toolChecks).toHaveLength(2)
    expect(toolChecks.map((c) => c.id)).toContain('tool:tool-a')
    expect(toolChecks.map((c) => c.id)).toContain('tool:tool-b')
    // Not registered → fail with a remediation message
    expect(toolChecks.every((c) => c.status === 'fail')).toBe(true)
    expect(toolChecks.every((c) => typeof c.message === 'string')).toBe(true)
  })

  it('registerTool() — registered tools report pass, unregistered report fail', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)
    reporter.registerTool('tool-a') // only register one of two

    const report = await reporter.getReport()
    const toolChecks = report.checks.filter((c) => c.category === 'tool')
    expect(toolChecks).toHaveLength(2)

    const toolA = toolChecks.find((c) => c.id === 'tool:tool-a')!
    const toolB = toolChecks.find((c) => c.id === 'tool:tool-b')!
    expect(toolA.status).toBe('pass')
    expect(toolA.message).toBeUndefined()
    expect(toolB.status).toBe('fail')
    expect(typeof toolB.message).toBe('string')
  })

  it('registerTool() — all registered tools report pass', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)
    reporter.registerTool('tool-a')
    reporter.registerTool('tool-b')

    const report = await reporter.getReport()
    const toolChecks = report.checks.filter((c) => c.category === 'tool')
    expect(toolChecks.every((c) => c.status === 'pass')).toBe(true)
  })

  it('registerTool() accepts a handler argument (ignored) for convenience', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)
    const fakeHandler = () => 'result'
    reporter.registerTool('tool-a', fakeHandler) // should not throw

    const report = await reporter.getReport()
    const toolA = report.checks.find((c) => c.id === 'tool:tool-a')!
    expect(toolA.status).toBe('pass')
  })

  it('getReport() returns cached result on second call within staleAfterMs', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest, {
      staleAfterMs: 60_000, // long enough that cache stays fresh
    })

    await reporter.getReport()
    await reporter.getReport()

    // runHealthCheck should be called only once (second call uses cache)
    expect(mockRunHealthCheck).toHaveBeenCalledTimes(1)
  })

  it('getReport() re-runs checks when cache is stale', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest, {
      staleAfterMs: 0, // immediately stale
    })

    await reporter.getReport()
    await reporter.getReport()

    // Both calls should trigger runHealthCheck
    expect(mockRunHealthCheck).toHaveBeenCalledTimes(2)
  })

  it('start() sets up background refresh', async () => {
    vi.useFakeTimers()
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest, { refreshIntervalMs: 1_000 })

    reporter.start()

    // Fast-forward 2 seconds — background refresh should fire twice
    await vi.advanceTimersByTimeAsync(2_100)

    // At least 2 calls: initial kick-off + 2 interval ticks
    expect(mockRunHealthCheck.mock.calls.length).toBeGreaterThanOrEqual(2)

    reporter.stop()
    vi.useRealTimers()
  })

  it('stop() clears background refresh', async () => {
    vi.useFakeTimers()
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest, { refreshIntervalMs: 1_000 })

    reporter.start()
    reporter.stop()

    const callsAfterStop = mockRunHealthCheck.mock.calls.length

    // Advance time — no more calls after stop()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mockRunHealthCheck.mock.calls.length).toBe(callsAfterStop)

    vi.useRealTimers()
  })

  it('start() is idempotent — calling twice does not double-schedule', async () => {
    vi.useFakeTimers()
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest, { refreshIntervalMs: 1_000 })

    reporter.start()
    reporter.start() // second call should be a no-op

    await vi.advanceTimersByTimeAsync(2_100)

    // Should be as if start() was only called once (≤ 4 calls: init + 2 ticks, with some margin)
    expect(mockRunHealthCheck.mock.calls.length).toBeLessThanOrEqual(4)

    reporter.stop()
    vi.useRealTimers()
  })

  it('preserves cached report on runHealthCheck error after initial success', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest, { staleAfterMs: 0 })

    // First call succeeds
    await reporter.getReport()

    // Second call fails
    mockRunHealthCheck.mockRejectedValueOnce(new Error('provider down'))
    const report = await reporter.getReport()

    // Should still return the cached report from the first call
    expect(report).toBeDefined()
    expect(report.agentName).toBe('test-reporter-agent')
  })

  it('returns an error report when first call fails with no cache', async () => {
    mockRunHealthCheck.mockRejectedValue(new Error('startup failure'))

    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)
    const report = await reporter.getReport()

    expect(report.status).toBe('unhealthy')
    expect(report.agentName).toBe('test-reporter-agent')
  })

  it('getReport() after stop() returns cached report without triggering new check', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest, { staleAfterMs: 0 }) // immediately stale

    await reporter.getReport() // populates cache
    reporter.stop()
    await reporter.getReport() // stopped — should use cache, not re-run
    await reporter.getReport()

    // Only the initial call should have triggered a health check
    expect(mockRunHealthCheck).toHaveBeenCalledTimes(1)
  })

  it('getReport() after stop() returns the last cached report content', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest, { staleAfterMs: 0 })

    const firstReport = await reporter.getReport()
    reporter.stop()

    // Even with staleAfterMs: 0, stop() guards the cache
    const secondReport = await reporter.getReport()
    expect(secondReport.agentName).toBe(firstReport.agentName)
    expect(secondReport.timestamp).toBe(firstReport.timestamp)
  })

  it('getReport() with empty spec.tools — zero tool checks added, summary not inflated', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const emptyToolsManifest = {
      ...testManifest,
      spec: { ...testManifest.spec, tools: [] as typeof testManifest.spec.tools },
    }
    const reporter = new AgentSpecReporter(emptyToolsManifest)

    const report = await reporter.getReport()
    const toolChecks = report.checks.filter((c) => c.category === 'tool')
    expect(toolChecks).toHaveLength(0)
    // summary.passed should equal what runHealthCheck returned (no tool inflation)
    expect(report.summary.passed).toBe(healthyReport.summary.passed)
  })

  it('getReport() with undefined spec.tools — no crash, no tool checks added', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const noToolsManifest = {
      ...testManifest,
      spec: { ...testManifest.spec, tools: undefined },
    }
    const reporter = new AgentSpecReporter(
      noToolsManifest as Parameters<typeof AgentSpecReporter>[0],
    )

    const report = await reporter.getReport()
    const toolChecks = report.checks.filter((c) => c.category === 'tool')
    expect(toolChecks).toHaveLength(0)
    expect(report.agentName).toBe('test-reporter-agent')
  })
})

describe('AgentSpecReporter.httpHandler()', () => {
  beforeEach(() => {
    mockRunHealthCheck.mockResolvedValue(healthyReport)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 200 with the HealthReport', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)
    const handler = reporter.httpHandler()

    const jsonCalls: unknown[] = []
    let statusCode = 0
    const mockRes = {
      status: (code: number) => {
        statusCode = code
        return { json: (body: unknown) => { jsonCalls.push(body) } }
      },
      json: (body: unknown) => { jsonCalls.push(body) },
    }

    await handler({}, mockRes)

    expect(statusCode).toBe(200)
    expect(jsonCalls).toHaveLength(1)
    const body = jsonCalls[0] as { agentName: string }
    expect(body.agentName).toBe('test-reporter-agent')
  })
})

describe('agentSpecFastifyPlugin', () => {
  beforeEach(() => {
    mockRunHealthCheck.mockResolvedValue(healthyReport)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers GET /agentspec/health route', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const { agentSpecFastifyPlugin } = await import('../agent/adapters/fastify.js')

    const reporter = new AgentSpecReporter(testManifest)
    const plugin = agentSpecFastifyPlugin(reporter)

    const routes: Array<{ path: string }> = []
    const mockApp = {
      get: (path: string) => { routes.push({ path }) },
    }

    await plugin(mockApp as Parameters<typeof plugin>[0])
    expect(routes.map((r) => r.path)).toContain('/agentspec/health')
  })

  it('registered handler calls reporter.getReport() and sends 200 with report', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const { agentSpecFastifyPlugin } = await import('../agent/adapters/fastify.js')

    const reporter = new AgentSpecReporter(testManifest)
    const plugin = agentSpecFastifyPlugin(reporter)

    // Capture the handler that was registered
    let capturedHandler: ((_req: unknown, reply: unknown) => Promise<void>) | undefined
    const mockApp = {
      get: (_path: string, handler: typeof capturedHandler) => {
        capturedHandler = handler
      },
    }
    await plugin(mockApp as Parameters<typeof plugin>[0])

    // Build a minimal mock reply
    const sentBodies: unknown[] = []
    let statusCode = 0
    const mockReply = {
      status: (code: number) => {
        statusCode = code
        return { send: (body: unknown) => { sentBodies.push(body) } }
      },
    }

    await capturedHandler!(undefined, mockReply)

    expect(statusCode).toBe(200)
    expect(sentBodies).toHaveLength(1)
    expect((sentBodies[0] as { agentName: string }).agentName).toBe('test-reporter-agent')
  })

  it('registered handler sends 500 when reporter.getReport() throws', async () => {
    const { agentSpecFastifyPlugin } = await import('../agent/adapters/fastify.js')

    // Use a fake reporter that always throws
    const throwingReporter = {
      getReport: vi.fn().mockRejectedValue(new Error('fastify reporter boom')),
    } as unknown as import('../agent/reporter.js').AgentSpecReporter

    const plugin = agentSpecFastifyPlugin(throwingReporter)

    let capturedHandler: ((_req: unknown, reply: unknown) => Promise<void>) | undefined
    const mockApp = {
      get: (_path: string, handler: typeof capturedHandler) => {
        capturedHandler = handler
      },
    }
    await plugin(mockApp as Parameters<typeof plugin>[0])

    const sentBodies: unknown[] = []
    let statusCode = 0
    const mockReply = {
      status: (code: number) => {
        statusCode = code
        return { send: (body: unknown) => { sentBodies.push(body) } }
      },
    }

    await capturedHandler!(undefined, mockReply)

    expect(statusCode).toBe(500)
    expect(sentBodies[0]).toMatchObject({ error: expect.stringContaining('fastify reporter boom') })
  })
})

describe('agentSpecExpressRouter', () => {
  beforeEach(() => {
    mockRunHealthCheck.mockResolvedValue(healthyReport)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a router with GET /health route', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const { agentSpecExpressRouter } = await import('../agent/adapters/express.js')

    const reporter = new AgentSpecReporter(testManifest)
    const router = agentSpecExpressRouter(reporter)

    // The router exposes _routes for testing
    const routes = (router as { _routes?: Array<{ path: string }> })._routes ?? []
    expect(routes.map((r) => r.path)).toContain('/health')
  })

  it('GET /health → calls reporter.getReport() and responds with 200', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const { agentSpecExpressRouter } = await import('../agent/adapters/express.js')

    const reporter = new AgentSpecReporter(testManifest)
    const middleware = agentSpecExpressRouter(reporter)

    const jsonBodies: unknown[] = []
    let statusCode = 0
    const mockRes = {
      status: (code: number) => {
        statusCode = code
        return { json: (body: unknown) => { jsonBodies.push(body) } }
      },
    }
    const mockNext = vi.fn()

    await middleware({ method: 'GET', path: '/health' }, mockRes as Parameters<typeof middleware>[1], mockNext)

    expect(statusCode).toBe(200)
    expect(jsonBodies).toHaveLength(1)
    expect((jsonBodies[0] as { agentName: string }).agentName).toBe('test-reporter-agent')
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('non-GET request → calls next() without handling', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const { agentSpecExpressRouter } = await import('../agent/adapters/express.js')

    const reporter = new AgentSpecReporter(testManifest)
    const middleware = agentSpecExpressRouter(reporter)

    const mockRes = { status: vi.fn() }
    const mockNext = vi.fn()

    await middleware({ method: 'POST', path: '/health' }, mockRes as unknown as Parameters<typeof middleware>[1], mockNext)

    expect(mockNext).toHaveBeenCalledOnce()
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('GET /other-path → calls next() without handling', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const { agentSpecExpressRouter } = await import('../agent/adapters/express.js')

    const reporter = new AgentSpecReporter(testManifest)
    const middleware = agentSpecExpressRouter(reporter)

    const mockRes = { status: vi.fn() }
    const mockNext = vi.fn()

    await middleware({ method: 'GET', path: '/other' }, mockRes as unknown as Parameters<typeof middleware>[1], mockNext)

    expect(mockNext).toHaveBeenCalledOnce()
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('falls back to req.url when req.path is undefined', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const { agentSpecExpressRouter } = await import('../agent/adapters/express.js')

    const reporter = new AgentSpecReporter(testManifest)
    const middleware = agentSpecExpressRouter(reporter)

    const jsonBodies: unknown[] = []
    let statusCode = 0
    const mockRes = {
      status: (code: number) => {
        statusCode = code
        return { json: (body: unknown) => { jsonBodies.push(body) } }
      },
    }
    const mockNext = vi.fn()

    // Use url instead of path
    await middleware({ method: 'GET', url: '/health' }, mockRes as Parameters<typeof middleware>[1], mockNext)

    expect(statusCode).toBe(200)
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('GET /health returns 500 when reporter.getReport() throws', async () => {
    const { agentSpecExpressRouter } = await import('../agent/adapters/express.js')

    // Use a fake reporter that always throws from getReport()
    const throwingReporter = {
      getReport: vi.fn().mockRejectedValue(new Error('reporter boom')),
    } as unknown as import('../agent/reporter.js').AgentSpecReporter

    const middleware = agentSpecExpressRouter(throwingReporter)

    const jsonBodies: unknown[] = []
    let statusCode = 0
    const mockRes = {
      status: (code: number) => {
        statusCode = code
        return { json: (body: unknown) => { jsonBodies.push(body) } }
      },
    }
    const mockNext = vi.fn()

    await middleware({ method: 'GET', path: '/health' }, mockRes as Parameters<typeof middleware>[1], mockNext)

    expect(statusCode).toBe(500)
    expect(jsonBodies[0]).toMatchObject({ error: expect.stringContaining('reporter boom') })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('calls next(err) when both getReport() and res.status(500) throw', async () => {
    const { agentSpecExpressRouter } = await import('../agent/adapters/express.js')

    const throwingReporter = {
      getReport: vi.fn().mockRejectedValue(new Error('inner boom')),
    } as unknown as import('../agent/reporter.js').AgentSpecReporter

    const middleware = agentSpecExpressRouter(throwingReporter)

    // A res that also throws from status()
    const throwingRes = {
      status: vi.fn().mockImplementation(() => {
        throw new Error('res.status exploded')
      }),
    }
    const mockNext = vi.fn()

    await middleware(
      { method: 'GET', path: '/health' },
      throwingRes as unknown as Parameters<typeof middleware>[1],
      mockNext,
    )

    // next() should be called with the original error when res.status() also throws
    expect(mockNext).toHaveBeenCalledOnce()
  })
})
