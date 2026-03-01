/**
 * Unit tests for AgentSpecReporter.startPushMode() / stopPushMode() / isPushModeActive().
 *
 * Uses vi.hoisted() + vi.mock() to intercept runHealthCheck and runAudit,
 * and vi.stubGlobal('fetch') to intercept heartbeat HTTP calls.
 * All timer-dependent tests use vi.useFakeTimers() + vi.advanceTimersByTimeAsync().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import type { HealthReport } from '../health/index.js'
import type { AuditReport, CompliancePack } from '../audit/index.js'

// ── Vitest hoisted mock setup ─────────────────────────────────────────────────

const { mockRunHealthCheck, mockRunAudit } = vi.hoisted(() => ({
  mockRunHealthCheck: vi.fn<() => Promise<HealthReport>>(),
  mockRunAudit: vi.fn<() => AuditReport>(),
}))

vi.mock('../health/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../health/index.js')>()
  return { ...original, runHealthCheck: mockRunHealthCheck }
})

vi.mock('../audit/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../audit/index.js')>()
  return { ...original, runAudit: mockRunAudit }
})

// ── Test fixtures ─────────────────────────────────────────────────────────────

const testManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: { name: 'push-test-agent', version: '1.0.0', description: 'test' },
  spec: {
    model: { provider: 'groq', id: 'llama-3.3-70b-versatile', apiKey: '$env:GROQ_API_KEY' },
    prompts: { system: 'You are a test agent.', hotReload: false },
  },
}

const healthyReport: HealthReport = {
  agentName: 'push-test-agent',
  timestamp: new Date().toISOString(),
  status: 'healthy',
  summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
  checks: [{ id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' }],
}

const auditReport: AuditReport = {
  agentName: 'push-test-agent',
  timestamp: new Date().toISOString(),
  overallScore: 75,
  grade: 'B',
  categoryScores: {},
  violations: [],
  suppressions: [],
  passedRules: 10,
  totalRules: 10,
  packBreakdown: {} as Record<CompliancePack, { passed: number; total: number }>,
}

// ── Push mode tests ───────────────────────────────────────────────────────────

describe('AgentSpecReporter — push mode', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockRunHealthCheck.mockResolvedValue(healthyReport)
    mockRunAudit.mockReturnValue(auditReport)
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('1. startPushMode() fires first fetch immediately (within 500ms)', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    reporter.stopPushMode()
  })

  it('2. fetch called with correct method + URL', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.example.com/api/v1/heartbeat',
      expect.objectContaining({ method: 'POST' }),
    )
    reporter.stopPushMode()
  })

  it('3. Authorization header set correctly', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
    })

    await vi.advanceTimersByTimeAsync(500)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-key-abc')
    reporter.stopPushMode()
  })

  it('4. Content-Type header set to application/json', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
    })

    await vi.advanceTimersByTimeAsync(500)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    reporter.stopPushMode()
  })

  it('5. body contains { health, gap } with correct agentName', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
    })

    await vi.advanceTimersByTimeAsync(500)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { health: HealthReport; gap: AuditReport }
    expect(body.health.agentName).toBe('push-test-agent')
    expect(body.gap.agentName).toBe('push-test-agent')
    reporter.stopPushMode()
  })

  it('6. interval fires fetch every intervalSeconds', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 5,
    })

    await vi.advanceTimersByTimeAsync(100)   // first push completes
    await vi.advanceTimersByTimeAsync(5000)  // second push (one interval)
    await vi.advanceTimersByTimeAsync(5000)  // third push (another interval)

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    reporter.stopPushMode()
  })

  it('7. stopPushMode() cancels the interval — no more fetches after stop', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 5,
    })

    await vi.advanceTimersByTimeAsync(100)
    const countBeforeStop = fetchMock.mock.calls.length

    reporter.stopPushMode()
    await vi.advanceTimersByTimeAsync(15_000) // advance 3 intervals past stop

    expect(fetchMock.mock.calls.length).toBe(countBeforeStop)
  })

  it('8. startPushMode() twice is idempotent — single timer only', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 5,
    })
    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 5,
    })

    await vi.advanceTimersByTimeAsync(100)   // immediate push
    await vi.advanceTimersByTimeAsync(5000)  // one interval

    // Single start: 1 immediate + 1 interval = 2. Double start (not idempotent) = 4.
    // Allow margin of 1 for any async timing edge-case, but ≤3 proves idempotency.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
    reporter.stopPushMode()
  })

  it('9. HTTP 401 → onError called, push mode still active', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 })

    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)
    const errors: Error[] = []

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
      onError: (e) => errors.push(e),
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(errors).toHaveLength(1)
    expect(reporter.isPushModeActive()).toBe(true)
    reporter.stopPushMode()
  })

  it('10. HTTP 500 → onError called, push mode still active', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })

    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)
    const errors: Error[] = []

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
      onError: (e) => errors.push(e),
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(errors).toHaveLength(1)
    expect(reporter.isPushModeActive()).toBe(true)
    reporter.stopPushMode()
  })

  it('11. network error → onError called, API key not in error message', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error('Connection refused (key: test-key-abc was used)'),
    )

    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)
    const errors: Error[] = []

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
      onError: (e) => errors.push(e),
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).not.toContain('test-key-abc')
    expect(errors[0]!.message).toContain('[REDACTED]')
    reporter.stopPushMode()
  })

  it('12. isPushModeActive() lifecycle: false → start → true → stop → false', async () => {
    const { AgentSpecReporter } = await import('../agent/reporter.js')
    const reporter = new AgentSpecReporter(testManifest)

    expect(reporter.isPushModeActive()).toBe(false)

    reporter.startPushMode({
      controlPlaneUrl: 'https://cp.example.com',
      apiKey: 'test-key-abc',
      intervalSeconds: 30,
    })

    expect(reporter.isPushModeActive()).toBe(true)

    reporter.stopPushMode()

    expect(reporter.isPushModeActive()).toBe(false)
  })
})
