/**
 * Unit tests for the MCP Streamable HTTP endpoint (GET /mcp, POST /mcp).
 *
 * Covers:
 *  - Discovery (GET /mcp)
 *  - initialize handshake
 *  - tools/list
 *  - tools/call happy path (mocked upstream)
 *  - tools/call unknown tool
 *  - tools/call missing name param
 *  - tools/call upstream failure
 *  - Unknown method → -32601
 *  - Invalid jsonrpc version → 400 + -32600
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import { testManifest } from './fixtures.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function mcpPost(app: Awaited<ReturnType<typeof buildControlPlaneApp>>, body: object) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify(body),
  })
}

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

// ── GET /mcp — discovery ──────────────────────────────────────────────────────

describe('GET /mcp', () => {
  it('returns 200', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/mcp' })
    expect(res.statusCode).toBe(200)
  })

  it('response has name field containing the agent name', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/mcp' })
    const body = JSON.parse(res.body) as { name: string }
    expect(body.name).toContain('gymcoach')
  })

  it('response has protocol field', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/mcp' })
    const body = JSON.parse(res.body) as { protocol: string }
    expect(body.protocol).toBeTruthy()
  })

  it('response has tools array matching spec.tools', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/mcp' })
    const body = JSON.parse(res.body) as { tools: Array<{ name: string }> }
    expect(body.tools).toHaveLength(2)
    expect(body.tools.map((t) => t.name)).toContain('get-workout-history')
    expect(body.tools.map((t) => t.name)).toContain('log-workout')
  })

  it('response has endpoint and transport fields', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/mcp' })
    const body = JSON.parse(res.body) as { endpoint: string; transport: string }
    expect(body.endpoint).toBe('/mcp')
    expect(body.transport).toBe('http')
  })
})

// ── POST /mcp — type validation ───────────────────────────────────────────────

describe('POST /mcp — type validation', () => {
  it('returns -32600 when method is a number instead of a string', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 123 })
    const body = JSON.parse(res.body) as { error: { code: number } }
    expect(body.error.code).toBe(-32600)
  })

  it('returns -32600 when method is null', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: null })
    const body = JSON.parse(res.body) as { error: { code: number } }
    expect(body.error.code).toBe(-32600)
  })

  it('returns -32602 when tools/call params.name is a number instead of a string', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 42, arguments: {} },
    })
    const body = JSON.parse(res.body) as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
  })

  it('returns -32602 when tools/call params.name is an object', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: { nested: 'attack' }, arguments: {} },
    })
    const body = JSON.parse(res.body) as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
  })
})

// ── POST /mcp — invalid jsonrpc ───────────────────────────────────────────────

describe('POST /mcp — invalid request', () => {
  it('returns 400 when jsonrpc is not "2.0"', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '1.0',
      id: 1,
      method: 'initialize',
    })
    expect(res.statusCode).toBe(400)
  })

  it('error code is -32600 for invalid jsonrpc version', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '1.0', id: 1, method: 'initialize' })
    const body = JSON.parse(res.body) as { error: { code: number } }
    expect(body.error.code).toBe(-32600)
  })

  it('returns -32601 for an unknown method', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'nonexistent/method',
    })
    const body = JSON.parse(res.body) as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
  })

  it('error response always has jsonrpc: "2.0"', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '1.0', id: 'x', method: 'init' })
    const body = JSON.parse(res.body) as { jsonrpc: string }
    expect(body.jsonrpc).toBe('2.0')
  })
})

// ── POST /mcp — initialize ────────────────────────────────────────────────────

describe('POST /mcp — initialize', () => {
  it('returns 200', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(res.statusCode).toBe(200)
  })

  it('result.protocolVersion is "2024-11-05"', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'initialize' })
    const body = JSON.parse(res.body) as { result: { protocolVersion: string } }
    expect(body.result.protocolVersion).toBe('2024-11-05')
  })

  it('result.serverInfo.name contains agent name', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'initialize' })
    const body = JSON.parse(res.body) as {
      result: { serverInfo: { name: string } }
    }
    expect(body.result.serverInfo.name).toContain('gymcoach')
  })

  it('echoes the request id', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 42, method: 'initialize' })
    const body = JSON.parse(res.body) as { id: number }
    expect(body.id).toBe(42)
  })
})

// ── POST /mcp — tools/list ────────────────────────────────────────────────────

describe('POST /mcp — tools/list', () => {
  it('returns 200', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(res.statusCode).toBe(200)
  })

  it('result.tools has all spec.tools entries', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const body = JSON.parse(res.body) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(body.result.tools).toHaveLength(2)
    expect(body.result.tools.map((t) => t.name)).toContain('get-workout-history')
    expect(body.result.tools.map((t) => t.name)).toContain('log-workout')
  })

  it('each tool has name, description, and inputSchema', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const body = JSON.parse(res.body) as {
      result: {
        tools: Array<{ name: string; description: string; inputSchema: unknown }>
      }
    }
    for (const tool of body.result.tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeTruthy()
    }
  })
})

// ── POST /mcp — tools/call ────────────────────────────────────────────────────

describe('POST /mcp — tools/call', () => {
  beforeEach(() => {
    // Default: upstream responds successfully
    global.fetch = vi.fn().mockResolvedValue({
      text: async () => 'Your last 3 workouts were...',
    }) as unknown as typeof global.fetch
  })

  it('returns 200 for a known tool with mocked upstream', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get-workout-history',
        arguments: { message: 'show last 3 workouts' },
      },
    })
    expect(res.statusCode).toBe(200)
  })

  it('result.content[0].type is "text" and contains upstream response', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get-workout-history',
        arguments: { message: 'show last 3 workouts' },
      },
    })
    const body = JSON.parse(res.body) as {
      result: { content: Array<{ type: string; text: string }> }
    }
    expect(body.result.content[0]?.type).toBe('text')
    expect(body.result.content[0]?.text).toContain('workouts')
  })

  it('returns error -32602 for an unknown tool name', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nonexistent-tool', arguments: {} },
    })
    const body = JSON.parse(res.body) as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toContain('nonexistent-tool')
  })

  it('returns error -32602 when params.name is missing', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { arguments: { message: 'hello' } }, // name omitted
    })
    const body = JSON.parse(res.body) as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
  })

  it('returns error -32603 when upstream fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof global.fetch

    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await mcpPost(app, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'log-workout',
        arguments: { message: 'bench press 3x8' },
      },
    })
    const body = JSON.parse(res.body) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32603)
    expect(body.error.message).toContain('failed')
  })
})
