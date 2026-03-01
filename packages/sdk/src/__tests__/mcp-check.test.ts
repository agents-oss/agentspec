/**
 * Unit tests for mcp.check.ts — MCP server reachability checks.
 *
 * Covers:
 * - HTTP/SSE transport: fetch mocked globally
 * - stdio transport: child_process.execFileSync mocked via vi.hoisted
 *
 * The existing health.test.ts covers edge cases (no-cmd, unresolved URL, unsafe command).
 * This file covers the "happy path" execution branches that are currently uncovered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runMcpChecks } from '../health/checks/mcp.check.js'

// ── Mock node:child_process ───────────────────────────────────────────────────
// vi.hoisted() is required because vi.mock factory closures are hoisted to the
// top of the module before import statements run.

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn<(cmd: string, args: string[], opts: unknown) => void>(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}))

// ── fetch mock setup ──────────────────────────────────────────────────────────

const originalFetch = global.fetch

beforeEach(() => {
  mockExecFileSync.mockReset()
  global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })
})

afterEach(() => {
  global.fetch = originalFetch
})

// ── stdio transport ───────────────────────────────────────────────────────────

describe('runMcpChecks — stdio transport (command found)', () => {
  it('returns pass when command exists on PATH', async () => {
    mockExecFileSync.mockReturnValue(undefined) // which/where succeeds (no throw)

    const checks = await runMcpChecks([
      { name: 'my-mcp-server', transport: 'stdio', command: 'node' },
    ])

    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('mcp:my-mcp-server')
    expect(checks[0].status).toBe('pass')
    expect(checks[0].category).toBe('mcp')
    expect(checks[0].severity).toBe('warning')
    expect(checks[0].message).toBeUndefined()
  })

  it('calls execFileSync with the correct command name as argument', async () => {
    mockExecFileSync.mockReturnValue(undefined)

    await runMcpChecks([{ name: 'uvx-server', transport: 'stdio', command: 'uvx' }])

    expect(mockExecFileSync).toHaveBeenCalledOnce()
    const [, args] = mockExecFileSync.mock.calls[0]
    expect(args).toEqual(['uvx'])
  })

  it('returns fail when command is not found on PATH', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('command not found: nonexi-stent-cmd')
    })

    const checks = await runMcpChecks([
      { name: 'missing-server', transport: 'stdio', command: 'nonexi-stent-cmd' },
    ])

    expect(checks[0].status).toBe('fail')
    expect(checks[0].category).toBe('mcp')
    expect(checks[0].message).toContain('command not found')
    expect(checks[0].message).toContain('nonexi-stent-cmd')
    expect(checks[0].remediation).toContain('nonexi-stent-cmd')
  })

  it('command with dots and dashes is accepted (safe name regex)', async () => {
    mockExecFileSync.mockReturnValue(undefined)

    const checks = await runMcpChecks([
      { name: 'dotted', transport: 'stdio', command: 'npx.cmd' },
    ])

    // Should reach execFileSync (not rejected for unsafe name)
    expect(mockExecFileSync).toHaveBeenCalledOnce()
    expect(checks[0].status).toBe('pass')
  })

  it('command with underscore is accepted (safe name regex)', async () => {
    mockExecFileSync.mockReturnValue(undefined)

    const checks = await runMcpChecks([
      { name: 'underscored', transport: 'stdio', command: 'my_mcp_server' },
    ])

    expect(checks[0].status).toBe('pass')
  })
})

// ── http transport ────────────────────────────────────────────────────────────

describe('runMcpChecks — http transport (fetch)', () => {
  it('returns pass for HTTP 200 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const checks = await runMcpChecks([
      { name: 'http-mcp', transport: 'http', url: 'http://mcp.example.com/health' },
    ])

    expect(checks).toHaveLength(1)
    expect(checks[0].id).toBe('mcp:http-mcp')
    expect(checks[0].status).toBe('pass')
    expect(checks[0].category).toBe('mcp')
    expect(typeof checks[0].latencyMs).toBe('number')
  })

  it('returns pass for HTTP 404 (server is up, route not found is acceptable)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 404, ok: false })

    const checks = await runMcpChecks([
      { name: 'http-404', transport: 'http', url: 'http://mcp.example.com/' },
    ])

    expect(checks[0].status).toBe('pass')
  })

  it('returns fail for HTTP 500 (server error)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 500, ok: false })

    const checks = await runMcpChecks([
      { name: 'http-500', transport: 'http', url: 'http://mcp.example.com/health' },
    ])

    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('HTTP 500')
    expect(checks[0].severity).toBe('warning')
  })

  it('returns fail for HTTP 503', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 503, ok: false })

    const checks = await runMcpChecks([
      { name: 'http-503', transport: 'http', url: 'http://mcp.example.com' },
    ])

    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('503')
  })

  it('returns fail on network error (ECONNREFUSED)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const checks = await runMcpChecks([
      { name: 'http-down', transport: 'http', url: 'http://mcp.example.com' },
    ])

    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('unreachable')
    expect(checks[0].remediation).toBeDefined()
  })

  it('returns fail with "timed out" on AbortError', async () => {
    const abortErr = new Error('The operation was aborted')
    abortErr.name = 'AbortError'
    global.fetch = vi.fn().mockRejectedValue(abortErr)

    const checks = await runMcpChecks([
      { name: 'http-timeout', transport: 'http', url: 'http://mcp.example.com' },
    ])

    expect(checks[0].status).toBe('fail')
    expect(checks[0].message).toContain('timed out')
  })

  it('includes latencyMs when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network'))

    const checks = await runMcpChecks([
      { name: 'lat-test', transport: 'http', url: 'http://mcp.example.com' },
    ])

    expect(typeof checks[0].latencyMs).toBe('number')
  })
})

// ── sse transport ─────────────────────────────────────────────────────────────

describe('runMcpChecks — sse transport (fetch)', () => {
  it('returns pass for SSE server with HTTP 200 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const checks = await runMcpChecks([
      { name: 'sse-mcp', transport: 'sse', url: 'http://mcp.example.com/sse' },
    ])

    expect(checks[0].id).toBe('mcp:sse-mcp')
    expect(checks[0].status).toBe('pass')
  })

  it('returns pass for SSE server with 404 (endpoint reachable)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 404, ok: false })

    const checks = await runMcpChecks([
      { name: 'sse-404', transport: 'sse', url: 'http://mcp.example.com/sse' },
    ])

    expect(checks[0].status).toBe('pass')
  })

  it('returns fail for SSE server with HTTP 500', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 500, ok: false })

    const checks = await runMcpChecks([
      { name: 'sse-500', transport: 'sse', url: 'http://mcp.example.com/sse' },
    ])

    expect(checks[0].status).toBe('fail')
  })
})

// ── multiple servers ──────────────────────────────────────────────────────────

describe('runMcpChecks — multiple servers', () => {
  it('checks each server independently', async () => {
    mockExecFileSync.mockReturnValue(undefined) // stdio succeeds
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true }) // http succeeds

    const checks = await runMcpChecks([
      { name: 'stdio-srv', transport: 'stdio', command: 'node' },
      { name: 'http-srv', transport: 'http', url: 'http://mcp.example.com' },
    ])

    expect(checks).toHaveLength(2)
    expect(checks.map((c) => c.id)).toContain('mcp:stdio-srv')
    expect(checks.map((c) => c.id)).toContain('mcp:http-srv')
    expect(checks.every((c) => c.category === 'mcp')).toBe(true)
  })
})
