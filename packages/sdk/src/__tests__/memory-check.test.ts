/**
 * Unit tests for memory.check.ts — memory backend reachability checks.
 *
 * node:net is mocked via vi.hoisted (same pattern as service-check.test.ts) so
 * the dynamic `await import('node:net')` inside checkRedis/checkPostgres picks up the mock.
 *
 * Covers the TCP success/failure branches that the existing health.test.ts
 * does not reach (those only test the "skip" paths for unresolved $env: refs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMemoryChecks } from '../health/checks/memory.check.js'

// ── Vitest hoisted mock (same pattern as service-check.test.ts) ───────────────

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

// ── Socket helpers ────────────────────────────────────────────────────────────

function setupConnectSuccess() {
  mockCreateConnection.mockImplementation((_opts: unknown, connectCb?: () => void) => {
    const socket = { destroy: vi.fn(), on: vi.fn() }
    socket.on.mockImplementation((event: string, cb: () => void) => {
      if (event === 'connect') setTimeout(cb, 0)
      return socket
    })
    // Support two calling conventions: createConnection(opts, cb) and createConnection(opts)
    if (connectCb) setTimeout(connectCb, 0)
    return socket
  })
}

function setupConnectError(message = 'ECONNREFUSED') {
  mockCreateConnection.mockImplementation(() => {
    const socket = { destroy: vi.fn(), on: vi.fn() }
    socket.on.mockImplementation((event: string, cb: (err: Error) => void) => {
      if (event === 'error') setTimeout(() => cb(new Error(message)), 0)
      return socket
    })
    return socket
  })
}

beforeEach(() => {
  mockCreateConnection.mockReset()
})

// ── shortTerm: redis (TCP success) ────────────────────────────────────────────

describe('runMemoryChecks — shortTerm redis TCP success', () => {
  it('returns pass when redis TCP connection succeeds', async () => {
    setupConnectSuccess()

    const checks = await runMemoryChecks({
      shortTerm: { backend: 'redis', connection: 'redis://redis.example.com:6379' },
    })

    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('memory.shortTerm:redis')
    expect(checks[0].category).toBe('memory')
    expect(checks[0].status).toBe('pass')
    expect(checks[0].severity).toBe('warning')
    expect(typeof checks[0].latencyMs).toBe('number')
  })

  it('returns fail when redis TCP connection is refused', async () => {
    setupConnectError('ECONNREFUSED')

    const checks = await runMemoryChecks({
      shortTerm: { backend: 'redis', connection: 'redis://redis.example.com:6379' },
    })

    expect(checks[0].id).toBe('memory.shortTerm:redis')
    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('not reachable')
    expect(checks[0].remediation).toBeDefined()
    expect(typeof checks[0].latencyMs).toBe('number')
  })

  it('uses default port 6379 when redis URL has no port', async () => {
    setupConnectSuccess()

    const checks = await runMemoryChecks({
      shortTerm: { backend: 'redis', connection: 'redis://redis.example.com' },
    })

    expect(mockCreateConnection).toHaveBeenCalledOnce()
    const callArgs = mockCreateConnection.mock.calls[0][0]
    expect((callArgs as { port: number }).port).toBe(6379)
  })
})

// ── longTerm: postgres (TCP success) ─────────────────────────────────────────

describe('runMemoryChecks — longTerm postgres TCP success', () => {
  it('returns pass when postgres TCP connection succeeds', async () => {
    setupConnectSuccess()

    const checks = await runMemoryChecks({
      longTerm: { backend: 'postgres', connectionString: 'postgres://db.example.com:5432/mydb' },
    })

    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('memory.longTerm:postgres')
    expect(checks[0].status).toBe('pass')
    expect(checks[0].category).toBe('memory')
    expect(typeof checks[0].latencyMs).toBe('number')
  })

  it('returns fail when postgres TCP connection is refused', async () => {
    setupConnectError('ECONNREFUSED')

    const checks = await runMemoryChecks({
      longTerm: { backend: 'postgres', connectionString: 'postgres://db.example.com:5432/mydb' },
    })

    expect(checks[0].id).toBe('memory.longTerm:postgres')
    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('not reachable')
    expect(checks[0].remediation).toBeDefined()
  })

  it('uses default port 5432 when postgres URL has no port', async () => {
    setupConnectSuccess()

    await runMemoryChecks({
      longTerm: { backend: 'postgres', connectionString: 'postgres://db.example.com/mydb' },
    })

    const callArgs = mockCreateConnection.mock.calls[0][0]
    expect((callArgs as { port: number }).port).toBe(5432)
  })

  it('skips for unsupported longTerm backend (e.g. sqlite)', async () => {
    const checks = await runMemoryChecks({
      longTerm: { backend: 'sqlite' as 'postgres', connectionString: '/app/db.sqlite' },
    })

    expect(checks[0].id).toBe('memory.longTerm:sqlite')
    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('not yet supported')
    expect(mockCreateConnection).not.toHaveBeenCalled()
  })
})

// ── vector: pgvector (TCP check via checkPostgres) ────────────────────────────

describe('runMemoryChecks — vector pgvector', () => {
  it('returns pass for pgvector when TCP connection succeeds', async () => {
    setupConnectSuccess()

    const checks = await runMemoryChecks({
      vector: {
        backend: 'pgvector',
        dimension: 1536,
        connectionString: 'postgres://vectors.example.com:5432/vectordb',
      },
    })

    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('memory.vector:pgvector')
    expect(checks[0].status).toBe('pass')
  })

  it('returns fail for pgvector when TCP connection is refused', async () => {
    setupConnectError('ECONNREFUSED')

    const checks = await runMemoryChecks({
      vector: {
        backend: 'pgvector',
        dimension: 1536,
        connectionString: 'postgres://vectors.example.com:5432/vectordb',
      },
    })

    expect(checks[0].id).toBe('memory.vector:pgvector')
    expect(checks[0].status).toBe('fail')
  })

  it('skips when vector connectionString is an unresolved $env: ref', async () => {
    const checks = await runMemoryChecks({
      vector: { backend: 'pgvector', dimension: 1536, connectionString: '$env:VECTOR_DB_URL' },
    })

    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('not resolved')
    expect(mockCreateConnection).not.toHaveBeenCalled()
  })

  it('skips for unsupported vector backend (e.g. pinecone)', async () => {
    const checks = await runMemoryChecks({
      vector: { backend: 'pinecone' as 'pgvector', dimension: 1536, apiKey: 'pk-literal-key' },
    })

    expect(checks[0].id).toBe('memory.vector:pinecone')
    expect(checks[0].status).toBe('skip')
    expect(checks[0].message).toContain('not yet supported')
  })

  it('skips when both connectionString and apiKey are unresolved $refs', async () => {
    const checks = await runMemoryChecks({
      vector: { backend: 'pgvector', dimension: 1536, apiKey: '$env:VECTOR_API_KEY' },
    })

    expect(checks[0].status).toBe('skip')
    expect(mockCreateConnection).not.toHaveBeenCalled()
  })
})

// ── combined shortTerm + longTerm + vector ────────────────────────────────────

describe('runMemoryChecks — combined sections', () => {
  it('returns one check per configured section', async () => {
    setupConnectSuccess()

    const checks = await runMemoryChecks({
      shortTerm: { backend: 'redis', connection: 'redis://redis.example.com:6379' },
      longTerm: { backend: 'postgres', connectionString: 'postgres://db.example.com/mydb' },
    })

    expect(checks).toHaveLength(2)
    expect(checks.map((c) => c.id)).toContain('memory.shortTerm:redis')
    expect(checks.map((c) => c.id)).toContain('memory.longTerm:postgres')
    expect(checks.every((c) => c.category === 'memory')).toBe(true)
  })

  it('returns zero checks when memory is fully empty object', async () => {
    const checks = await runMemoryChecks({})
    expect(checks).toHaveLength(0)
  })
})
