/**
 * Unit tests for model.check.ts — model endpoint reachability checks.
 *
 * fetch is mocked globally so no real HTTP calls are made.
 * process.env is manipulated per-test to exercise $env:VAR resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runModelChecks } from '../health/checks/model.check.js'
import type { AgentSpecModel } from '../schema/manifest.schema.js'

// ── fetch mock ────────────────────────────────────────────────────────────────

const originalFetch = global.fetch

beforeEach(() => {
  // Explicitly clear env vars that may be set in the real shell environment
  delete process.env['GROQ_API_KEY']
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['FALLBACK_API_KEY']

  // Default: endpoint is reachable, returns 200
  global.fetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
  })
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
  delete process.env['GROQ_API_KEY']
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['FALLBACK_API_KEY']
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const groqModel: AgentSpecModel = {
  provider: 'groq',
  id: 'llama-3.3-70b-versatile',
  apiKey: '$env:GROQ_API_KEY',
}

const anthropicModel: AgentSpecModel = {
  provider: 'anthropic',
  id: 'claude-haiku-4-5-20251001',
  apiKey: '$env:ANTHROPIC_API_KEY',
}

const literalKeyModel: AgentSpecModel = {
  provider: 'groq',
  id: 'llama-3.3-70b-versatile',
  apiKey: 'gsk_literal_key_value',
}

const unknownProviderModel: AgentSpecModel = {
  provider: 'acme-llm',
  id: 'acme-turbo',
  apiKey: '$env:GROQ_API_KEY',
}

// ── env var resolution ────────────────────────────────────────────────────────

describe('runModelChecks — $env: resolution', () => {
  it('returns skip when $env: var is not set', async () => {
    // GROQ_API_KEY not in process.env
    const checks = await runModelChecks(groqModel)

    expect(checks).toHaveLength(1)
    expect(checks[0].status).toBe('skip')
    expect(checks[0].severity).toBe('error')
    expect(checks[0].message).toContain('not resolved')
    expect(checks[0].message).toContain('$env:GROQ_API_KEY')
    // fetch should not have been called
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('probes endpoint when $env: var is set and returns pass on 200', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_test_key'
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const checks = await runModelChecks(groqModel)

    expect(checks).toHaveLength(1)
    expect(checks[0].status).toBe('pass')
    expect(vi.mocked(global.fetch)).toHaveBeenCalledOnce()
  })

  it('returns pass on 401 — endpoint reachable even with bad key', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_bad_key'
    global.fetch = vi.fn().mockResolvedValue({ status: 401, ok: false })

    const checks = await runModelChecks(groqModel)

    expect(checks[0].status).toBe('pass')
  })

  it('returns fail on HTTP 500 — server error', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_test_key'
    global.fetch = vi.fn().mockResolvedValue({ status: 500, ok: false })

    const checks = await runModelChecks(groqModel)

    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('unreachable')
  })

  it('returns fail on network error / AbortError (timeout)', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_test_key'
    const abortErr = new Error('The operation was aborted')
    abortErr.name = 'AbortError'
    global.fetch = vi.fn().mockRejectedValue(abortErr)

    const checks = await runModelChecks(groqModel)

    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('unreachable')
  })
})

// ── literal API key ───────────────────────────────────────────────────────────

describe('runModelChecks — literal API key', () => {
  it('probes endpoint with literal (non-$env) apiKey', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const checks = await runModelChecks(literalKeyModel)

    expect(checks[0].status).toBe('pass')
    expect(vi.mocked(global.fetch)).toHaveBeenCalledOnce()
  })
})

// ── unknown provider ──────────────────────────────────────────────────────────

describe('runModelChecks — unknown provider', () => {
  it('returns pass without calling fetch for unknown provider', async () => {
    process.env['GROQ_API_KEY'] = 'some_key' // env resolved so check runs

    const checks = await runModelChecks(unknownProviderModel)

    expect(checks[0].status).toBe('pass')
    // fetch is called but `checkModelEndpoint` returns { reachable: true } early
    // (unknown provider → no PROVIDER_ENDPOINTS entry → assume reachable, no fetch)
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })
})

// ── check metadata ────────────────────────────────────────────────────────────

describe('runModelChecks — check metadata', () => {
  it('check id follows model:provider/id format', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_test_key'

    const checks = await runModelChecks(groqModel)

    expect(checks[0].id).toBe('model:groq/llama-3.3-70b-versatile')
  })

  it('severity is error for primary model', async () => {
    const checks = await runModelChecks(groqModel) // skip case

    expect(checks[0].severity).toBe('error')
  })

  it('severity is error for primary model when check runs (resolved key)', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_test_key'

    const checks = await runModelChecks(groqModel)

    expect(checks[0].severity).toBe('error')
  })

  it('latencyMs is a number when endpoint check runs', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_test_key'
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const checks = await runModelChecks(groqModel)

    expect(typeof checks[0].latencyMs).toBe('number')
    expect(checks[0].latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('Anthropic provider uses x-api-key header (not Authorization: Bearer)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key'
    let capturedHeaders: Record<string, string> = {}
    global.fetch = vi.fn().mockImplementation((_url: unknown, opts: unknown) => {
      capturedHeaders = (opts as { headers: Record<string, string> }).headers
      return Promise.resolve({ status: 200, ok: true })
    })

    await runModelChecks(anthropicModel)

    expect(capturedHeaders['x-api-key']).toBe('sk-ant-test-key')
    expect(capturedHeaders['Authorization']).toBeUndefined()
  })
})

// ── fallback model ────────────────────────────────────────────────────────────

describe('runModelChecks — fallback model', () => {
  it('returns only one check when no fallback is declared', async () => {
    const checks = await runModelChecks(groqModel)

    expect(checks).toHaveLength(1)
  })

  it('skips fallback check when fallback $env: var is not set', async () => {
    const modelWithFallback: AgentSpecModel = {
      ...groqModel,
      fallback: {
        provider: 'openai',
        id: 'gpt-4o-mini',
        apiKey: '$env:FALLBACK_API_KEY',
      },
    }

    const checks = await runModelChecks(modelWithFallback)

    const fallbackCheck = checks.find((c) => c.id.startsWith('model-fallback:'))
    expect(fallbackCheck).toBeDefined()
    expect(fallbackCheck!.status).toBe('skip')
    expect(fallbackCheck!.severity).toBe('warning')
  })

  it('probes fallback endpoint when fallback $env: var is set', async () => {
    process.env['FALLBACK_API_KEY'] = 'fallback_key_value'
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const modelWithFallback: AgentSpecModel = {
      ...groqModel,
      fallback: {
        provider: 'openai',
        id: 'gpt-4o-mini',
        apiKey: '$env:FALLBACK_API_KEY',
      },
    }

    const checks = await runModelChecks(modelWithFallback)

    const fallbackCheck = checks.find((c) => c.id.startsWith('model-fallback:'))
    expect(fallbackCheck).toBeDefined()
    expect(fallbackCheck!.status).toBe('pass')
  })

  it('fallback check severity is warning', async () => {
    process.env['FALLBACK_API_KEY'] = 'fallback_key_value'
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const modelWithFallback: AgentSpecModel = {
      ...groqModel,
      fallback: {
        provider: 'openai',
        id: 'gpt-4o-mini',
        apiKey: '$env:FALLBACK_API_KEY',
      },
    }

    const checks = await runModelChecks(modelWithFallback)

    const fallbackCheck = checks.find((c) => c.id.startsWith('model-fallback:'))
    expect(fallbackCheck!.severity).toBe('warning')
  })

  it('returns two checks when fallback is declared', async () => {
    const modelWithFallback: AgentSpecModel = {
      ...groqModel,
      fallback: {
        provider: 'openai',
        id: 'gpt-4o-mini',
        apiKey: '$env:FALLBACK_API_KEY',
      },
    }

    const checks = await runModelChecks(modelWithFallback)

    expect(checks).toHaveLength(2)
    expect(checks[0].id).toBe('model:groq/llama-3.3-70b-versatile')
    expect(checks[1].id).toBe('model-fallback:openai/gpt-4o-mini')
  })
})
