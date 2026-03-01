/**
 * Unit tests for service.check.ts — TCP connectivity checks.
 *
 * node:net is mocked at module level (vi.hoisted pattern) so the dynamic
 * `await import('node:net')` in tcpCheck picks up the mock reliably.
 * Per-test behavior is set via mockImplementation in beforeEach.
 *
 * All TCP-touching tests use non-loopback hostnames (redis.test, postgres.test)
 * to pass the classifyHost security filter.
 *
 * classifyHost is tested directly via the host security filtering suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runServiceChecks } from '../health/checks/service.check.js'

// ── Vitest hoisted mock setup ─────────────────────────────────────────────────
// Hoisted so the factory can reference the mock fn without temporal dead zone.

const { mockCreateConnection } = vi.hoisted(() => ({
  mockCreateConnection: vi.fn<
    (opts: { host: string; port: number }) => {
      destroy: () => void
      on: (event: string, cb: (...args: unknown[]) => void) => unknown
    }
  >(),
}))

vi.mock('node:net', () => ({
  createConnection: mockCreateConnection,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Make mockCreateConnection fire the 'connect' event on the returned socket. */
function setupConnectSuccess() {
  mockCreateConnection.mockImplementation(() => {
    const socket = { destroy: vi.fn(), on: vi.fn() }
    socket.on.mockImplementation((event: string, cb: () => void) => {
      if (event === 'connect') setTimeout(cb, 0)
      return socket
    })
    return socket
  })
}

/** Make mockCreateConnection fire the 'error' event on the returned socket. */
function setupConnectError(message = 'connect ECONNREFUSED') {
  mockCreateConnection.mockImplementation(() => {
    const socket = { destroy: vi.fn(), on: vi.fn() }
    socket.on.mockImplementation((event: string, cb: (err: Error) => void) => {
      if (event === 'error') setTimeout(() => cb(new Error(message)), 0)
      return socket
    })
    return socket
  })
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Use non-loopback, non-link-local hostnames so classifyHost allows them through.

const redisServiceResolved = { type: 'redis', connection: 'redis://redis.test:6379' }
const redisServiceEnvRef = { type: 'redis', connection: '$env:REDIS_URL' }
const unknownService = { type: 'oracle', connection: 'oracle://db.oracle.test:1521' }

// ── Env var resolution tests ──────────────────────────────────────────────────

describe('runServiceChecks — env var resolution', () => {
  beforeEach(() => {
    delete process.env['REDIS_URL']
    mockCreateConnection.mockReset()
  })

  afterEach(() => {
    delete process.env['REDIS_URL']
  })

  it('skips when connection is an unresolved $env: reference', async () => {
    const checks = await runServiceChecks([redisServiceEnvRef])
    expect(checks).toHaveLength(1)
    expect(checks[0].status).toBe('skip')
    expect(checks[0].id).toBe('service:redis')
    expect(checks[0].category).toBe('service')
    expect(checks[0].message).toContain('not resolved')
  })

  it('resolves $env: reference and attempts TCP when env var is set', async () => {
    process.env['REDIS_URL'] = 'redis://redis.test:19999'
    setupConnectError('ECONNREFUSED')

    const checks = await runServiceChecks([redisServiceEnvRef])
    expect(checks).toHaveLength(1)
    // Status is pass or fail — NOT skip (env var was resolved, TCP was attempted)
    expect(['pass', 'fail']).toContain(checks[0].status)
    expect(checks[0].id).toBe('service:redis')
  })
})

// ── Unsupported type tests ────────────────────────────────────────────────────

describe('runServiceChecks — type filtering', () => {
  it('skips for unknown service type', async () => {
    const checks = await runServiceChecks([unknownService])
    expect(checks).toHaveLength(1)
    expect(checks[0].status).toBe('skip')
    expect(checks[0].id).toBe('service:oracle')
    expect(checks[0].message).toContain('oracle')
  })
})

// ── classifyHost security rejections ─────────────────────────────────────────

describe('runServiceChecks — host security filtering', () => {
  it('skips for IPv4 loopback (127.x.x.x)', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: 'redis://127.0.0.1:6379' },
    ])
    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('loopback')
  })

  it('skips for localhost hostname', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: 'redis://localhost:6379' },
    ])
    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('loopback')
  })

  it('skips for IPv4 link-local (169.254.x.x)', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: 'redis://169.254.169.254:6379' },
    ])
    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('link-local')
  })

  it('skips for unspecified address (0.0.0.0)', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: 'redis://0.0.0.0:6379' },
    ])
    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('0.0.0.0')
  })
})

// ── TCP connectivity tests (mocked) ──────────────────────────────────────────

describe('runServiceChecks — TCP connectivity', () => {
  beforeEach(() => {
    mockCreateConnection.mockReset()
  })

  it('returns pass when TCP connection succeeds', async () => {
    setupConnectSuccess()

    const checks = await runServiceChecks([redisServiceResolved])
    expect(checks[0].status).toBe('pass')
    expect(checks[0].category).toBe('service')
    expect(typeof checks[0].latencyMs).toBe('number')
  })

  it('returns fail when TCP connection is refused', async () => {
    setupConnectError('connect ECONNREFUSED redis.test:19998')

    const checks = await runServiceChecks([
      { type: 'redis', connection: 'redis://redis.test:19998' },
    ])
    expect(checks[0].status).toBe('fail')
    expect(checks[0].id).toBe('service:redis')
    expect(checks[0].message).toContain('unreachable')
    expect(checks[0].remediation).toBeDefined()
    expect(typeof checks[0].latencyMs).toBe('number')
  })

  it('returns fail with latency on TCP error', async () => {
    setupConnectError('ETIMEDOUT')

    const checks = await runServiceChecks([
      { type: 'postgres', connection: 'postgres://postgres.test:19997/db' },
    ])
    expect(checks[0].status).toBe('fail')
    expect(checks[0].latencyMs).toBeGreaterThanOrEqual(0)
  })
})

// ── Multiple services ─────────────────────────────────────────────────────────

describe('runServiceChecks — multiple services', () => {
  it('returns one check per service', async () => {
    const services = [
      { type: 'redis', connection: '$env:REDIS_URL' },
      { type: 'postgres', connection: '$env:DATABASE_URL' },
    ]
    const checks = await runServiceChecks(services)
    expect(checks).toHaveLength(2)
    expect(checks.map((c) => c.id)).toContain('service:redis')
    expect(checks.map((c) => c.id)).toContain('service:postgres')
  })

  it('returns empty array for empty input', async () => {
    const checks = await runServiceChecks([])
    expect(checks).toHaveLength(0)
  })

  it('each check has category "service"', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: '$env:REDIS_URL' },
      { type: 'oracle', connection: 'oracle://db.oracle.test:1521' },
    ])
    expect(checks.every((c) => c.category === 'service')).toBe(true)
  })
})

// ── URL parsing ───────────────────────────────────────────────────────────────

describe('runServiceChecks — URL parsing', () => {
  beforeEach(() => {
    mockCreateConnection.mockReset()
    setupConnectError('ECONNREFUSED')
  })

  it('handles redis:// URL scheme', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: 'redis://redis.test:19996' },
    ])
    // URL was parsed → TCP attempted → fail (not skip for "unrecognised format")
    expect(['pass', 'fail']).toContain(checks[0].status)
    expect(checks[0].status).not.toBe('skip')
  })

  it('handles postgres:// URL scheme', async () => {
    const checks = await runServiceChecks([
      { type: 'postgres', connection: 'postgres://postgres.test:19995/mydb' },
    ])
    expect(['pass', 'fail']).toContain(checks[0].status)
    expect(checks[0].status).not.toBe('skip')
  })

  it('skips for malformed connection string that cannot be parsed', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: 'not-a-url' },
    ])
    // "not-a-url" has no colon → parseConnectionUrl returns null
    expect(checks[0].status).toBe('skip')
  })
})

// ── Additional type support + edge cases ─────────────────────────────────────

describe('runServiceChecks — additional supported types', () => {
  beforeEach(() => {
    mockCreateConnection.mockReset()
    setupConnectSuccess()
  })

  it('mysql type is supported — TCP attempted, not skipped as unknown', async () => {
    const checks = await runServiceChecks([
      { type: 'mysql', connection: 'mysql://mysql.test:3306/db' },
    ])
    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('service:mysql')
    // should be pass or fail (TCP attempted), not skipped for unsupported type
    expect(['pass', 'fail']).toContain(checks[0].status)
    expect(checks[0].message ?? '').not.toContain('not implemented')
  })

  it('mongodb type is supported — TCP attempted, not skipped as unknown', async () => {
    const checks = await runServiceChecks([
      { type: 'mongodb', connection: 'mongodb://mongo.test:27017/db' },
    ])
    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('service:mongodb')
    expect(['pass', 'fail']).toContain(checks[0].status)
    expect(checks[0].message ?? '').not.toContain('not implemented')
  })

  it('elasticsearch type is supported — TCP attempted, not skipped as unknown', async () => {
    const checks = await runServiceChecks([
      { type: 'elasticsearch', connection: 'elasticsearch://elastic.test:9200' },
    ])
    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('service:elasticsearch')
    expect(['pass', 'fail']).toContain(checks[0].status)
    expect(checks[0].message ?? '').not.toContain('not implemented')
  })
})

describe('runServiceChecks — IPv6 address filtering', () => {
  it('skips for IPv6 loopback ::1 in bracket notation redis://[::1]:6379', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: 'redis://[::1]:6379' },
    ])
    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('loopback')
  })

  it('skips for IPv6 link-local fe80::1 in bracket notation', async () => {
    const checks = await runServiceChecks([
      { type: 'redis', connection: 'redis://[fe80::1]:6379' },
    ])
    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('link-local')
  })
})

describe('runServiceChecks — host:port format without scheme', () => {
  beforeEach(() => {
    mockCreateConnection.mockReset()
    setupConnectError('ECONNREFUSED')
  })

  it('parses IP:port format (no scheme) and attempts TCP', async () => {
    // "10.0.1.5:6379" — starts with a digit so new URL() throws; fallback host:port parsing runs
    const checks = await runServiceChecks([
      { type: 'redis', connection: '10.0.1.5:6379' },
    ])
    expect(checks).toHaveLength(1)
    // Should attempt TCP (pass or fail), not skip with "unrecognised format"
    expect(['pass', 'fail']).toContain(checks[0].status)
    expect(checks[0].message ?? '').not.toContain('unrecognised connection string format')
  })
})

// ── Integration: runHealthCheck calls runServiceChecks ─────────────────────────

describe('runHealthCheck integrates service checks', () => {
  it('service checks appear in HealthReport when services are declared', async () => {
    const { runHealthCheck } = await import('../health/index.js')
    const manifest = {
      apiVersion: 'agentspec.io/v1' as const,
      kind: 'AgentSpec' as const,
      metadata: { name: 'test-agent', version: '1.0.0', description: 'test' },
      spec: {
        model: { provider: 'groq', id: 'llama', apiKey: '$env:GROQ_API_KEY' },
        prompts: { system: 'test', hotReload: false as const },
        requires: {
          services: [{ type: 'redis' as const, connection: '$env:REDIS_URL' }],
        },
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false,
      checkMcp: false,
      checkMemory: false,
      checkServices: true,
    })

    const serviceCheck = report.checks.find((c) => c.category === 'service')
    expect(serviceCheck).toBeDefined()
    expect(serviceCheck!.id).toBe('service:redis')
  })

  it('service checks are skipped when checkServices: false', async () => {
    const { runHealthCheck } = await import('../health/index.js')
    const manifest = {
      apiVersion: 'agentspec.io/v1' as const,
      kind: 'AgentSpec' as const,
      metadata: { name: 'test-agent', version: '1.0.0', description: 'test' },
      spec: {
        model: { provider: 'groq', id: 'llama', apiKey: '$env:GROQ_API_KEY' },
        prompts: { system: 'test', hotReload: false as const },
        requires: {
          services: [{ type: 'redis' as const, connection: '$env:REDIS_URL' }],
        },
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false,
      checkMcp: false,
      checkMemory: false,
      checkServices: false,
    })

    const serviceChecks = report.checks.filter((c) => c.category === 'service')
    expect(serviceChecks).toHaveLength(0)
  })
})
