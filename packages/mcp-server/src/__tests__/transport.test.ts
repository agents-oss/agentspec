import { describe, it, expect, afterEach } from 'vitest'
import { spawn, ChildProcess } from 'child_process'
import { resolve } from 'path'
import http from 'http'

const BIN = resolve(__dirname, '../../dist/index.js')

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendJsonRpc(port: number, body: object): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = ''
        res.on('data', (c: Buffer) => { raw += c.toString() })
        res.on('end', () => { resolve({ status: res.statusCode!, body: JSON.parse(raw) }) })
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function httpGet(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let raw = ''
      res.on('data', (c: Buffer) => { raw += c.toString() })
      res.on('end', () => { resolve({ status: res.statusCode!, body: JSON.parse(raw) }) })
    }).on('error', reject)
  })
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.stderr!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) resolve()
    })
  })
}

function stdioRpc(child: ChildProcess, req: object): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line) return
      child.stdout!.removeListener('data', handler)
      resolve(JSON.parse(line))
    }
    child.stdout!.on('data', handler)
    child.stdin!.write(JSON.stringify(req) + '\n')
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('transport selection', () => {
  let child: ChildProcess | null = null

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      child = null
    }
  })

  it('defaults to stdio when no flags are passed', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })

    const res = await stdioRpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize' })

    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'agentspec', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    })
  })

  it('starts HTTP server when --http flag is passed', async () => {
    const port = 14567 + Math.floor(Math.random() * 1000)
    child = spawn('node', [BIN, '--http'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_PORT: String(port) },
    })
    await waitForReady(child)

    const res = await sendJsonRpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'agentspec', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    })
  })
})

describe('stdio transport', () => {
  let child: ChildProcess | null = null

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      child = null
    }
  })

  it('handles initialize request', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
    const res = await stdioRpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize' })

    expect(res).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } })
  })

  it('handles tools/list request', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
    const res = await stdioRpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: unknown[] } }

    expect(res).toMatchObject({ jsonrpc: '2.0', id: 2 })
    expect(res.result.tools).toBeInstanceOf(Array)
    expect(res.result.tools.length).toBeGreaterThan(0)
  })

  it('handles ping request', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
    const res = await stdioRpc(child, { jsonrpc: '2.0', id: 3, method: 'ping' })

    expect(res).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  it('returns parse error for invalid JSON', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })

    const res = await new Promise<unknown>((resolve) => {
      child!.stdout!.once('data', (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString().trim()))
      })
      child!.stdin!.write('not json\n')
    })

    expect(res).toMatchObject({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } })
  })

  it('returns error for unknown method', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
    const res = await stdioRpc(child, { jsonrpc: '2.0', id: 5, method: 'nonexistent/method' })

    expect(res).toMatchObject({ jsonrpc: '2.0', id: 5, error: { code: -32601 } })
  })

  it('handles multiple sequential requests', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })

    const res1 = await stdioRpc(child, { jsonrpc: '2.0', id: 1, method: 'ping' })
    const res2 = await stdioRpc(child, { jsonrpc: '2.0', id: 2, method: 'ping' })

    expect(res1).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect(res2).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
  })

  it('skips empty lines', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })

    // Send empty line then a valid request — should only get one response
    child.stdin!.write('\n')
    const res = await stdioRpc(child, { jsonrpc: '2.0', id: 10, method: 'ping' })

    expect(res).toEqual({ jsonrpc: '2.0', id: 10, result: {} })
  })

  it('exits when stdin closes', async () => {
    child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })

    const exitCode = await new Promise<number | null>((resolve) => {
      child!.on('exit', (code) => resolve(code))
      child!.stdin!.end()
    })

    expect(exitCode).toBe(0)
  })
})

describe('HTTP transport', () => {
  let child: ChildProcess | null = null
  let port: number

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      child = null
    }
  })

  function startHttp(): Promise<void> {
    port = 15000 + Math.floor(Math.random() * 1000)
    child = spawn('node', [BIN, '--http'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_PORT: String(port) },
    })
    return waitForReady(child)
  }

  it('GET /health returns status ok', async () => {
    await startHttp()
    const res = await httpGet(port, '/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', server: 'agentspec-mcp' })
  })

  it('POST /mcp handles initialize', async () => {
    await startHttp()
    const res = await sendJsonRpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } })
  })

  it('POST /mcp handles tools/list', async () => {
    await startHttp()
    const res = await sendJsonRpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' })

    expect(res.status).toBe(200)
    const body = res.body as { result: { tools: unknown[] } }
    expect(body.result.tools).toBeInstanceOf(Array)
    expect(body.result.tools.length).toBeGreaterThan(0)
  })

  it('POST /mcp handles ping', async () => {
    await startHttp()
    const res = await sendJsonRpc(port, { jsonrpc: '2.0', id: 3, method: 'ping' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  it('POST /mcp returns parse error for invalid JSON', async () => {
    await startHttp()

    const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let raw = ''
          res.on('data', (c: Buffer) => { raw += c.toString() })
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }))
        },
      )
      req.on('error', reject)
      req.write('not json')
      req.end()
    })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } })
  })

  it('returns 404 for unknown routes', async () => {
    await startHttp()
    const res = await httpGet(port, '/unknown')

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: expect.stringContaining('Not found') })
  })

  it('returns CORS header on POST /mcp', async () => {
    await startHttp()

    const corsHeader = await new Promise<string | undefined>((resolve, reject) => {
      const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => { resolve(res.headers['access-control-allow-origin']); res.resume() },
      )
      req.on('error', reject)
      req.write(data)
      req.end()
    })

    expect(corsHeader).toBe('*')
  })

  it('responds to MCP_PORT env var', async () => {
    const customPort = 16000 + Math.floor(Math.random() * 1000)
    child = spawn('node', [BIN, '--http'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_PORT: String(customPort) },
    })

    await new Promise<void>((resolve) => {
      child!.stderr!.on('data', (chunk: Buffer) => {
        const msg = chunk.toString()
        if (msg.includes('listening') && msg.includes(String(customPort))) resolve()
      })
    })

    const res = await httpGet(customPort, '/health')
    expect(res.status).toBe(200)
  })
})
