/**
 * Unit tests for secret.check.ts — secret backend reachability checks.
 *
 * fetch is mocked globally (override + restore pattern) per-test.
 * AGENTSPEC_SECRET_BACKEND and VAULT_ADDR are set/cleaned per-test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runSecretChecks } from '../health/checks/secret.check.js'

const originalFetch = global.fetch

beforeEach(() => {
  delete process.env['AGENTSPEC_SECRET_BACKEND']
  delete process.env['VAULT_ADDR']
  global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
  delete process.env['AGENTSPEC_SECRET_BACKEND']
  delete process.env['VAULT_ADDR']
})

// ── env backend (default) ─────────────────────────────────────────────────────

describe('runSecretChecks — env backend (default)', () => {
  it('returns pass when AGENTSPEC_SECRET_BACKEND is not set', async () => {
    const checks = await runSecretChecks()
    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('secret:backend')
    expect(checks[0].status).toBe('pass')
    expect(checks[0].category).toBe('env')
    expect(checks[0].severity).toBe('info')
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('returns pass when AGENTSPEC_SECRET_BACKEND=env (explicit)', async () => {
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'env'
    const checks = await runSecretChecks()
    expect(checks[0].status).toBe('pass')
    expect(checks[0].message).toContain('env')
  })
})

// ── vault backend ─────────────────────────────────────────────────────────────

describe('runSecretChecks — vault backend', () => {
  beforeEach(() => {
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'vault'
  })

  it('skips when VAULT_ADDR is not set', async () => {
    const checks = await runSecretChecks()
    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('secret:vault')
    expect(checks[0].status).toBe('skip')
    expect(checks[0].severity).toBe('warning')
    expect(checks[0].message).toContain('VAULT_ADDR')
    expect(checks[0].remediation).toBeDefined()
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('returns pass when VAULT_ADDR is set and endpoint responds (200)', async () => {
    process.env['VAULT_ADDR'] = 'https://vault.example.com'
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const checks = await runSecretChecks()

    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('secret:vault')
    expect(checks[0].status).toBe('pass')
    expect(checks[0].severity).toBe('error')
    expect(typeof checks[0].latencyMs).toBe('number')
    expect(vi.mocked(global.fetch)).toHaveBeenCalledOnce()
  })

  it('returns pass for vault 429 (standby) — any sub-600 response is reachable', async () => {
    process.env['VAULT_ADDR'] = 'https://vault.example.com'
    global.fetch = vi.fn().mockResolvedValue({ status: 429, ok: false })

    const checks = await runSecretChecks()
    expect(checks[0].status).toBe('pass')
  })

  it('strips trailing slash from VAULT_ADDR before appending /v1/sys/health', async () => {
    process.env['VAULT_ADDR'] = 'https://vault.example.com/'
    let calledUrl = ''
    global.fetch = vi.fn().mockImplementation((url: unknown) => {
      calledUrl = url as string
      return Promise.resolve({ status: 200, ok: true })
    })

    await runSecretChecks()

    expect(calledUrl).toBe('https://vault.example.com/v1/sys/health')
    expect(calledUrl).not.toMatch(/\/\/v1/)
  })

  it('returns fail when vault network call throws (unreachable)', async () => {
    process.env['VAULT_ADDR'] = 'https://vault.example.com'
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const checks = await runSecretChecks()

    expect(checks[0].status).toBe('fail')
    expect(checks[0].severity).toBe('error')
    expect(checks[0].message).toContain('vault.example.com')
    expect(checks[0].remediation).toBeDefined()
  })

  it('returns fail with "timed out" message on AbortError', async () => {
    process.env['VAULT_ADDR'] = 'https://vault.example.com'
    const abortErr = new Error('The operation was aborted')
    abortErr.name = 'AbortError'
    global.fetch = vi.fn().mockRejectedValue(abortErr)

    const checks = await runSecretChecks()

    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('timed out')
  })

  it('check has latencyMs when fetch throws', async () => {
    process.env['VAULT_ADDR'] = 'https://vault.example.com'
    global.fetch = vi.fn().mockRejectedValue(new Error('network error'))

    const checks = await runSecretChecks()

    expect(typeof checks[0].latencyMs).toBe('number')
    expect(checks[0].latencyMs).toBeGreaterThanOrEqual(0)
  })
})

// ── aws backend ───────────────────────────────────────────────────────────────

describe('runSecretChecks — aws backend', () => {
  beforeEach(() => {
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'aws'
  })

  it('returns pass when AWS STS endpoint is reachable', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const checks = await runSecretChecks()

    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('secret:aws')
    expect(checks[0].status).toBe('pass')
    expect(checks[0].severity).toBe('info')
    expect(typeof checks[0].latencyMs).toBe('number')
    expect(vi.mocked(global.fetch)).toHaveBeenCalledOnce()
  })

  it('returns pass even for non-200 response (server is up, credentials needed)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 403, ok: false })

    const checks = await runSecretChecks()
    expect(checks[0].status).toBe('pass')
    expect(checks[0].message).toContain('reachable')
  })

  it('returns fail when AWS STS endpoint is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const checks = await runSecretChecks()

    expect(checks[0].status).toBe('fail')
    expect(checks[0].severity).toBe('error')
    expect(checks[0].message).toContain('unreachable')
    expect(checks[0].remediation).toBeDefined()
  })

  it('returns fail with "timed out" message on AbortError for AWS', async () => {
    const abortErr = new Error('The operation was aborted')
    abortErr.name = 'AbortError'
    global.fetch = vi.fn().mockRejectedValue(abortErr)

    const checks = await runSecretChecks()

    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('timed out')
  })

  it('check has latencyMs on failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network'))

    const checks = await runSecretChecks()

    expect(typeof checks[0].latencyMs).toBe('number')
  })
})

// ── gcp / azure (unsupported) backends ───────────────────────────────────────

describe('runSecretChecks — gcp/azure (unsupported) backends', () => {
  it('skips for gcp backend with informational message', async () => {
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'gcp'

    const checks = await runSecretChecks()

    expect(checks).toHaveLength(1)
    expect(checks[0].status).toBe('skip')
    expect(checks[0].severity).toBe('info')
    expect(checks[0].message).toContain('gcp')
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('skips for azure backend with informational message', async () => {
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'azure'

    const checks = await runSecretChecks()

    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('azure')
  })

  it('skips for unknown custom backend', async () => {
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'hashicorp-enterprise'

    const checks = await runSecretChecks()

    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('hashicorp-enterprise')
  })

  it('category is env for all skip cases', async () => {
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'gcp'

    const checks = await runSecretChecks()
    expect(checks[0].category).toBe('env')
  })
})
