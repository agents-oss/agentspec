/**
 * Unit tests for GET /gap LLM-powered gap analysis endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import { testManifest } from './fixtures.js'

// Mock fetch so gap probe doesn't hit real upstream
const originalFetch = global.fetch

beforeEach(() => {
  // Default: all upstream endpoints are unreachable (incl. /agentspec/health)
  global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

interface GapReport {
  score: number
  source: string
  issues: Array<{
    severity: string
    property: string
    description: string
    recommendation: string
  }>
  observed: {
    hasHealthEndpoint: boolean
    hasCapabilitiesEndpoint: boolean
    upstreamTools: string[]
  }
}

describe('GET /gap', () => {
  it('returns 200', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    expect(res.statusCode).toBe(200)
  })

  it('response has numeric score between 0 and 100', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport
    expect(typeof body.score).toBe('number')
    expect(body.score).toBeGreaterThanOrEqual(0)
    expect(body.score).toBeLessThanOrEqual(100)
  })

  it('response has source field', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport
    expect(['agent-sdk', 'manifest-static']).toContain(body.source)
  })

  it('source is manifest-static when probe unreachable', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport
    expect(body.source).toBe('manifest-static')
  })

  it('response has issues array', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport
    expect(Array.isArray(body.issues)).toBe(true)
  })

  it('issues have required fields: severity, property, description, recommendation', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport
    for (const issue of body.issues) {
      expect(issue.severity).toBeTruthy()
      expect(issue.property).toBeTruthy()
      expect(issue.description).toBeTruthy()
      expect(issue.recommendation).toBeTruthy()
    }
  })

  it('response has observed object with hasHealthEndpoint, hasCapabilitiesEndpoint, upstreamTools', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport
    expect(typeof body.observed.hasHealthEndpoint).toBe('boolean')
    expect(typeof body.observed.hasCapabilitiesEndpoint).toBe('boolean')
    expect(Array.isArray(body.observed.upstreamTools)).toBe(true)
  })

  it('score is lower when upstream has no health or capabilities endpoint', async () => {
    // fetch rejects (offline upstream) — should detect missing endpoints
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport
    expect(body.score).toBeLessThan(100)
  })

  it('score is higher when upstream exposes health and capabilities matching spec tools', async () => {
    // Mock fetch by URL so concurrent calls (probeAgent + probeUpstream) work correctly
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/agentspec/health')) {
        // Respond with 404 — agent SDK not integrated
        return { ok: false, status: 404, json: async () => ({}) }
      }
      if ((url as string).includes('/capabilities')) {
        return {
          ok: true,
          json: async () => ({
            tools: [
              { name: 'get-workout-history' },
              { name: 'log-workout' },
            ],
          }),
        }
      }
      if ((url as string).includes('/health')) {
        return { ok: true, json: async () => ({ status: 'healthy' }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as typeof global.fetch

    // minimal manifest: no guardrails → score 90 (only missing-guardrails penalty)
    const minimalManifest = {
      ...testManifest,
      spec: {
        ...testManifest.spec,
        requires: undefined,
        guardrails: undefined,
        evaluation: undefined,
        tools: testManifest.spec.tools,
      },
    }

    const app = await buildControlPlaneApp(minimalManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport

    // All infrastructure issues resolved → only missing-guardrails remains (medium = -10)
    expect(body.score).toBe(90)
    // No health/capabilities issues
    expect(body.issues.every((i) => i.property !== 'healthcheckable')).toBe(true)
    expect(body.issues.every((i) => !(i.property === 'discoverable' && i.description.includes('capabilities')))).toBe(true)
  })

  it('source is agent-sdk when probe returns valid HealthReport', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/agentspec/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agentName: 'gymcoach',
            timestamp: new Date().toISOString(),
            status: 'healthy',
            summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
            checks: [
              { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport
    expect(body.source).toBe('agent-sdk')
  })

  // ── Spec-vs-probe reconciliation tests ───────────────────────────────────────

  it('flags missing env var check when agent SDK did not check the declared apiKey', async () => {
    // Probe has no env:GROQ_API_KEY check — only a tool check
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/agentspec/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agentName: 'gymcoach',
            timestamp: new Date().toISOString(),
            status: 'healthy',
            summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
            checks: [
              // env:GROQ_API_KEY deliberately absent — wrong manifest used
              { id: 'tool:get-workout-history', category: 'tool', status: 'pass', severity: 'info' },
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport

    expect(body.source).toBe('agent-sdk')
    const envIssue = body.issues.find((i) => i.property === 'env:GROQ_API_KEY')
    expect(envIssue).toBeDefined()
    expect(envIssue!.severity).toBe('high')
    expect(envIssue!.description).toContain('GROQ_API_KEY')
  })

  it('flags missing service checks when declared services are absent from probe', async () => {
    // Probe has env check and tool checks but no service checks
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/agentspec/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agentName: 'gymcoach',
            timestamp: new Date().toISOString(),
            status: 'healthy',
            summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
            checks: [
              { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
              // service:redis and service:postgres deliberately absent
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport

    expect(body.source).toBe('agent-sdk')
    const redisIssue = body.issues.find((i) => i.property === 'service:redis')
    const pgIssue = body.issues.find((i) => i.property === 'service:postgres')
    expect(redisIssue).toBeDefined()
    expect(redisIssue!.severity).toBe('high')
    expect(pgIssue).toBeDefined()
    expect(pgIssue!.severity).toBe('high')
  })

  it('flags missing tool checks when declared tools are absent from probe', async () => {
    // Probe has env + service checks but no tool checks at all
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/agentspec/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agentName: 'gymcoach',
            timestamp: new Date().toISOString(),
            status: 'healthy',
            summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
            checks: [
              { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
              { id: 'service:redis', category: 'service', status: 'pass', severity: 'info' },
              { id: 'service:postgres', category: 'service', status: 'pass', severity: 'info' },
              // tool:get-workout-history and tool:log-workout deliberately absent
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport

    expect(body.source).toBe('agent-sdk')
    const workoutIssue = body.issues.find((i) => i.property === 'tool:get-workout-history')
    const logIssue = body.issues.find((i) => i.property === 'tool:log-workout')
    expect(workoutIssue).toBeDefined()
    expect(workoutIssue!.severity).toBe('medium')
    expect(logIssue).toBeDefined()
    expect(logIssue!.severity).toBe('medium')
  })

  it('no reconciliation issues when probe covers all spec declarations', async () => {
    // Probe reports every check the spec declares → no reconciliation gaps
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/agentspec/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agentName: 'gymcoach',
            timestamp: new Date().toISOString(),
            status: 'healthy',
            summary: { passed: 5, failed: 0, warnings: 0, skipped: 0 },
            checks: [
              { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
              { id: 'service:redis', category: 'service', status: 'pass', severity: 'info' },
              { id: 'service:postgres', category: 'service', status: 'pass', severity: 'info' },
              { id: 'tool:get-workout-history', category: 'tool', status: 'pass', severity: 'info' },
              { id: 'tool:log-workout', category: 'tool', status: 'pass', severity: 'info' },
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport

    // None of the reconciliation issue types should appear
    const reconciliationProps = ['env:GROQ_API_KEY', 'service:redis', 'service:postgres',
      'tool:get-workout-history', 'tool:log-workout']
    for (const prop of reconciliationProps) {
      expect(body.issues.find((i) => i.property === prop)).toBeUndefined()
    }
  })

  it('gap surfaces model.apiKey issue when probe model check is skipped', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/agentspec/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agentName: 'gymcoach',
            timestamp: new Date().toISOString(),
            status: 'degraded',
            summary: { passed: 0, failed: 0, warnings: 0, skipped: 1 },
            checks: [
              {
                id: 'model:groq/llama-3.3-70b-versatile',
                category: 'model',
                status: 'skip',
                severity: 'error',
                message: 'Cannot check model endpoint: API key reference not resolved ($env:GROQ_API_KEY)',
              },
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport

    expect(body.source).toBe('agent-sdk')
    const modelIssue = body.issues.find((i) => i.property === 'model.apiKey')
    expect(modelIssue).toBeDefined()
    expect(modelIssue!.severity).toBe('high')
    expect(modelIssue!.description).toContain('not resolved')
  })

  it('gap uses live model check when probe sdkAvailable and model fails', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if ((url as string).includes('/agentspec/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            agentName: 'gymcoach',
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            summary: { passed: 0, failed: 1, warnings: 0, skipped: 0 },
            checks: [
              {
                id: 'model:groq/llama-3.3-70b-versatile',
                category: 'model',
                status: 'fail',
                severity: 'error',
                message: 'GROQ_API_KEY is not set',
                remediation: 'Set GROQ_API_KEY env var',
              },
            ],
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/gap' })
    const body = JSON.parse(res.body) as GapReport

    expect(body.source).toBe('agent-sdk')
    const modelIssue = body.issues.find((i) => i.property === 'model.apiKey')
    expect(modelIssue).toBeDefined()
    expect(modelIssue!.severity).toBe('critical')
    expect(modelIssue!.description).toContain('GROQ_API_KEY is not set')
  })
})
