/**
 * E2E smoke tests for agentspec-sidecar running in Docker.
 *
 * Prerequisites: docker compose test stack is up (managed by global-setup.ts).
 *
 * PROXY = http://localhost:14000  (proxy port — passes through to mock-agent)
 * CP    = http://localhost:14001  (control plane port)
 */

import { describe, it, expect } from 'vitest'

const PROXY = 'http://localhost:14000'
const CP = 'http://localhost:14001'

/** Poll until `predicate` is satisfied or throw on timeout. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = await fn()
    if (predicate(val)) return val
    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`pollUntil: timed out after ${timeoutMs}ms`)
}

describe('agentspec-sidecar E2E smoke tests', () => {
  it('1. GET /health/live → 200', async () => {
    const res = await fetch(`${CP}/health/live`)
    expect(res.status).toBe(200)
  })

  it('2. GET /capabilities → AgentCard with tools array', async () => {
    const res = await fetch(`${CP}/capabilities`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tools?: unknown[] }
    expect(Array.isArray(body.tools)).toBe(true)
  })

  it('3. GET PROXY/hello → 200 (proxy passthrough)', async () => {
    const res = await fetch(`${PROXY}/hello`)
    expect(res.status).toBe(200)
  })

  it('4. Proxied response has X-Request-ID header (mock-agent echoes it)', async () => {
    const myId = 'e2e-request-id'
    const res = await fetch(`${PROXY}/hello`, {
      headers: { 'x-request-id': myId },
    })
    expect(res.headers.get('x-request-id')).toBe(myId)
  })

  it('5. GET CP/audit contains the proxied request entry', async () => {
    await fetch(`${PROXY}/audit-check`)
    const entries = await pollUntil(
      () => fetch(`${CP}/audit`).then((r) => r.json() as Promise<unknown[]>),
      (list) => list.length > 0,
    )
    expect(entries.length).toBeGreaterThan(0)
  })

  it('6. GET CP/explain/:requestId reconstructs the proxied trace', async () => {
    const myId = 'e2e-explain-id'
    await fetch(`${PROXY}/explain-me`, { headers: { 'x-request-id': myId } })
    const status = await pollUntil(
      () => fetch(`${CP}/explain/${myId}`).then((r) => r.status),
      (s) => s === 200,
    )
    expect(status).toBe(200)
  })

  it('7. GET CP/audit/stream Content-Type is text/event-stream', async () => {
    const controller = new AbortController()
    let contentType: string | null = null
    try {
      const res = await fetch(`${CP}/audit/stream`, { signal: controller.signal })
      contentType = res.headers.get('content-type')
    } catch {
      // AbortError expected
    } finally {
      controller.abort()
    }
    expect(contentType).toMatch(/text\/event-stream/)
  })

  it('8. GET CP/explore returns agent, tools, and sidecar fields', async () => {
    const res = await fetch(`${CP}/explore`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      agent?: unknown
      tools?: unknown
      sidecar?: unknown
    }
    expect(body.agent).toBeDefined()
    expect(body.tools).toBeDefined()
    expect(body.sidecar).toBeDefined()
  })

  it('9. GET CP/mcp returns protocol discovery JSON', async () => {
    const res = await fetch(`${CP}/mcp`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { protocol?: string }
    expect(body.protocol).toBeTruthy()
  })

  it('10. POST CP/eval/run without body → 400', async () => {
    const res = await fetch(`${CP}/eval/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  // ── Agent Runtime Introspection Protocol smoke tests ─────────────────────────

  it('11. mock-agent exposes GET /agentspec/health → 200 with valid HealthReport', async () => {
    // The mock-agent simulates @agentspec/sdk AgentSpecReporter integration
    // We probe it directly (via proxy) to verify the protocol endpoint exists
    const res = await fetch(`${PROXY}/agentspec/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      agentName?: string
      timestamp?: string
      status?: string
      checks?: unknown[]
    }
    expect(typeof body.agentName).toBe('string')
    expect(typeof body.timestamp).toBe('string')
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
    expect(Array.isArray(body.checks)).toBe(true)
  })

  it('12. GET CP/health/ready uses agent-sdk source when mock-agent has reporter', async () => {
    const res = await fetch(`${CP}/health/ready`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source?: string; status?: string }
    // Mock-agent exposes /agentspec/health → sidecar should detect it
    expect(body.source).toBe('agent-sdk')
  })

  it('13. GET CP/explore has source: agent-sdk and live tool status', async () => {
    const res = await fetch(`${CP}/explore`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      source?: string
      tools?: Array<{ name: string; status: string }>
    }
    expect(body.source).toBe('agent-sdk')
    // Tool checks come from the live probe report
    if (body.tools && body.tools.length > 0) {
      const toolStatuses = body.tools.map((t) => t.status)
      // At least some tools should have a status from the probe (not all 'unknown')
      expect(toolStatuses.some((s) => s !== 'unknown')).toBe(true)
    }
  })

  it('14. GET CP/gap has source field', async () => {
    const res = await fetch(`${CP}/gap`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source?: string }
    expect(['agent-sdk', 'manifest-static']).toContain(body.source)
  })
})
