/**
 * TDD tests for OPA client — queryOPA() and buildOPAInput().
 *
 * Written before the implementation. Tests define expected behaviour for:
 *   1. buildOPAInput(manifest, probe, observed)  — pure input builder
 *   2. queryOPA(opaBaseUrl, agentName, input)     — HTTP client with graceful fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentSpecManifest, HealthReport } from '@agentspec/sdk'
import {
  buildOPAInput,
  queryOPA,
  type OPAInput,
  type OPAResult,
} from '../control-plane/opa-client.js'
import type { AgentProbeResult } from '../control-plane/agent-probe.js'

// ── Test fixtures ──────────────────────────────────────────────────────────────

const manifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: { name: 'gymcoach', version: '1.0.0', description: 'AI fitness coach' },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
      costControls: { maxMonthlyUSD: 200 },
    },
    prompts: { system: 'You are a coach.', hotReload: false },
    tools: [
      {
        name: 'delete-workout',
        type: 'function',
        description: 'Delete workout',
        annotations: { destructiveHint: true },
      },
      {
        name: 'log-workout',
        type: 'function',
        description: 'Log workout',
        annotations: { destructiveHint: false },
      },
    ],
    memory: {
      shortTerm: { backend: 'redis', ttlSeconds: 3600, connection: '$env:REDIS_URL' },
      hygiene: { piiScrubFields: ['name', 'email'], auditLog: true },
    },
    guardrails: {
      input: [
        { type: 'pii-detector', action: 'scrub', fields: ['name'] },
        { type: 'prompt-injection', action: 'reject', sensitivity: 'high' },
      ],
      output: [
        { type: 'toxicity-filter', threshold: 0.7, action: 'reject' },
      ],
    },
  },
}

const probeWithSDK: AgentProbeResult = {
  sdkAvailable: true,
  probeLatencyMs: 50,
  report: {
    agentName: 'gymcoach',
    timestamp: '2026-03-02T00:00:00Z',
    status: 'healthy',
    summary: { passed: 3, failed: 0, warnings: 0, skipped: 0 },
    checks: [
      { id: 'env:GROQ_API_KEY', category: 'env', status: 'pass', severity: 'error' },
      { id: 'tool:log-workout', category: 'tool', status: 'pass', severity: 'info' },
      { id: 'tool:delete-workout', category: 'tool', status: 'pass', severity: 'info' },
    ],
  } as HealthReport,
}

const probeWithoutSDK: AgentProbeResult = {
  sdkAvailable: false,
  probeLatencyMs: 10,
}

const observed = {
  hasHealth: true,
  hasCapabilities: true,
  tools: ['log-workout', 'delete-workout'],
}

// ── buildOPAInput tests ────────────────────────────────────────────────────────

describe('buildOPAInput', () => {
  it('sets agent_name from manifest metadata', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(input.agent_name).toBe('gymcoach')
  })

  it('sets request_type to "llm_call"', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(input.request_type).toBe('llm_call')
  })

  it('sets model_id as provider/id', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(input.model_id).toBe('groq/llama-3.3-70b-versatile')
  })

  it('lists declared input guardrail types in guardrails_declared', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(input.guardrails_declared).toContain('pii-detector')
    expect(input.guardrails_declared).toContain('prompt-injection')
  })

  it('includes sdk_available flag reflecting probe state', () => {
    const withSDK = buildOPAInput(manifest, probeWithSDK, observed)
    const withoutSDK = buildOPAInput(manifest, probeWithoutSDK, observed)
    expect(withSDK.sdk_available).toBe(true)
    expect(withoutSDK.sdk_available).toBe(false)
  })

  it('lists registered tool names from probe when SDK available', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(input.tools_registered).toContain('log-workout')
    expect(input.tools_registered).toContain('delete-workout')
  })

  it('lists tools from observed.tools when SDK not available', () => {
    const input = buildOPAInput(manifest, probeWithoutSDK, observed)
    expect(input.tools_registered).toEqual(['log-workout', 'delete-workout'])
  })

  it('sets has_health_endpoint from observed', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(input.has_health_endpoint).toBe(true)
  })

  it('sets has_capabilities_endpoint from observed', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(input.has_capabilities_endpoint).toBe(true)
  })

  it('includes all_checks_passing when SDK available and all checks pass', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(input.all_checks_passing).toBe(true)
  })

  it('sets all_checks_passing to false when any check fails', () => {
    const failedProbe: AgentProbeResult = {
      ...probeWithSDK,
      report: {
        ...probeWithSDK.report!,
        checks: [
          { id: 'env:GROQ_API_KEY', category: 'env', status: 'fail', severity: 'error' },
        ],
      } as HealthReport,
    }
    const input = buildOPAInput(manifest, failedProbe, observed)
    expect(input.all_checks_passing).toBe(false)
  })

  it('sets all_checks_passing to false when SDK not available', () => {
    const input = buildOPAInput(manifest, probeWithoutSDK, observed)
    expect(input.all_checks_passing).toBe(false)
  })

  it('produces a valid OPAInput object (all required fields present)', () => {
    const input = buildOPAInput(manifest, probeWithSDK, observed)
    expect(typeof input.agent_name).toBe('string')
    expect(typeof input.request_type).toBe('string')
    expect(typeof input.model_id).toBe('string')
    expect(Array.isArray(input.guardrails_declared)).toBe(true)
    expect(Array.isArray(input.tools_registered)).toBe(true)
    expect(typeof input.sdk_available).toBe('boolean')
    expect(typeof input.has_health_endpoint).toBe('boolean')
    expect(typeof input.has_capabilities_endpoint).toBe('boolean')
    expect(typeof input.all_checks_passing).toBe('boolean')
  })
})

// ── queryOPA tests ─────────────────────────────────────────────────────────────

describe('queryOPA', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  const sampleInput: OPAInput = {
    agent_name: 'gymcoach',
    request_type: 'llm_call',
    model_id: 'groq/llama-3.3-70b-versatile',
    guardrails_declared: ['pii-detector'],
    guardrails_invoked: [],
    tools_registered: ['log-workout'],
    sdk_available: true,
    has_health_endpoint: true,
    has_capabilities_endpoint: true,
    all_checks_passing: true,
  }

  it('returns allow:true and empty violations when OPA returns empty deny set', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: [] }),
    }) as typeof global.fetch

    const result = await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    expect(result.allow).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('returns allow:false with violations when OPA returns non-empty deny set', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['pii_detector_not_invoked', 'memory_ttl_mismatch'] }),
    }) as typeof global.fetch

    const result = await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    expect(result.allow).toBe(false)
    expect(result.violations).toContain('pii_detector_not_invoked')
    expect(result.violations).toContain('memory_ttl_mismatch')
  })

  it('returns allow:true with graceful fallback when OPA is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof global.fetch

    const result = await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    expect(result.allow).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.opaUnavailable).toBe(true)
  })

  it('returns allow:true with graceful fallback when OPA returns non-200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as typeof global.fetch

    const result = await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    expect(result.allow).toBe(true)
    expect(result.opaUnavailable).toBe(true)
  })

  it('uses the correct OPA query URL with sanitized agent name', async () => {
    let capturedUrl: string | undefined
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url
      return { ok: true, json: async () => ({ result: [] }) }
    }) as typeof global.fetch

    await queryOPA('http://localhost:8181', 'fitness-tracker', sampleInput)
    // Hyphens in agent name must be replaced with underscores for valid Rego package path
    expect(capturedUrl).toContain('fitness_tracker')
    expect(capturedUrl).not.toContain('fitness-tracker')
  })

  it('sends OPA input as JSON body in POST request', async () => {
    let capturedBody: string | undefined
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string
      return { ok: true, json: async () => ({ result: [] }) }
    }) as typeof global.fetch

    await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    const body = JSON.parse(capturedBody!)
    expect(body.input).toBeDefined()
    expect(body.input.agent_name).toBe('gymcoach')
  })

  it('queries the /deny endpoint (set of violation strings)', async () => {
    let capturedUrl: string | undefined
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url
      return { ok: true, json: async () => ({ result: [] }) }
    }) as typeof global.fetch

    await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    expect(capturedUrl).toContain('/v1/data/agentspec/agent/gymcoach/deny')
  })

  it('sets timeout so slow OPA does not block gap endpoint indefinitely', async () => {
    // AbortSignal.timeout is used internally — verify fetch is called with a signal
    let capturedSignal: AbortSignal | undefined
    global.fetch = vi.fn().mockImplementation(
      async (_url: string, opts: RequestInit) => {
        capturedSignal = opts.signal as AbortSignal | undefined
        return { ok: true, json: async () => ({ result: [] }) }
      },
    ) as typeof global.fetch

    await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    expect(capturedSignal).toBeDefined()
  })

  it('gracefully handles OPA returning null result', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: null }),
    }) as typeof global.fetch

    const result = await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    expect(result.allow).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('gracefully handles OPA returning undefined result', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as typeof global.fetch

    const result = await queryOPA('http://localhost:8181', 'gymcoach', sampleInput)
    expect(result.allow).toBe(true)
    expect(result.violations).toEqual([])
  })
})

// ── OPAResult type guard tests ─────────────────────────────────────────────────

describe('OPAResult type contract', () => {
  it('OPAResult with allow:false has non-empty violations', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['some_violation'] }),
    }) as typeof global.fetch

    const result: OPAResult = await queryOPA('http://localhost:8181', 'gymcoach', {
      agent_name: 'gymcoach',
      request_type: 'llm_call',
      model_id: 'groq/test',
      guardrails_declared: [],
      guardrails_invoked: [],
      tools_registered: [],
      sdk_available: false,
      has_health_endpoint: false,
      has_capabilities_endpoint: false,
      all_checks_passing: false,
    })

    expect(result.allow).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
  })
})
