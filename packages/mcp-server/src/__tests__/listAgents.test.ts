import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { listAgents } from '../tools/listAgents.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const CLUSTER_AGENTS = JSON.stringify([
  { agentName: 'budget-assistant', runtime: 'python', phase: 'running', grade: 'B', score: 82, lastSeen: '2026-03-08T12:00:00Z' },
  { agentName: 'gym-coach', runtime: 'node', phase: 'running', grade: 'A', score: 95, lastSeen: '2026-03-08T12:01:00Z' },
])

describe('listAgents — cluster mode', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('fetches agents from control plane when controlPlaneUrl is provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => CLUSTER_AGENTS })

    const result = JSON.parse(await listAgents({ controlPlaneUrl: 'http://localhost:8080' }))

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/v1/agents')
    expect(result.agents).toHaveLength(2)
    expect(result.agents[0].agentName).toBe('budget-assistant')
    expect(result.agents[0].heartbeat).toBe(true)
    expect(result.source).toBe('cluster')
  })

  it('sends X-Admin-Key header when adminKey is provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => CLUSTER_AGENTS })

    await listAgents({ controlPlaneUrl: 'http://localhost:8080', adminKey: 'sk-secret' })

    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-Admin-Key']).toBe('sk-secret')
  })

  it('omits X-Admin-Key header when adminKey is not provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => CLUSTER_AGENTS })

    await listAgents({ controlPlaneUrl: 'http://localhost:8080' })

    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-Admin-Key']).toBeUndefined()
  })

  it('returns empty agents with helpful message when control plane has no agents', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '[]' })

    const result = JSON.parse(await listAgents({ controlPlaneUrl: 'http://localhost:8080' }))

    expect(result.agents).toEqual([])
    expect(result.source).toBe('cluster')
    expect(result.summary.total).toBe(0)
    expect(result.summary.message).toContain('No agents registered')
    expect(result.summary.message).toContain('POST /api/v1/register')
  })

  it('returns summary with heartbeat counts based on lastSeen', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => CLUSTER_AGENTS })

    const result = JSON.parse(await listAgents({ controlPlaneUrl: 'http://localhost:8080' }))

    // Both agents have lastSeen set → both have heartbeat: true
    expect(result.summary.total).toBe(2)
    expect(result.summary.withHeartbeat).toBe(2)
    expect(result.summary.withoutHeartbeat).toBe(0)
  })

  it('marks agents without lastSeen as no heartbeat', async () => {
    const mixed = JSON.stringify([
      { agentName: 'with-heartbeat', lastSeen: '2026-03-08T12:00:00Z' },
      { agentName: 'no-heartbeat' },
    ])
    fetchMock.mockResolvedValue({ ok: true, text: async () => mixed })

    const result = JSON.parse(await listAgents({ controlPlaneUrl: 'http://localhost:8080' }))

    expect(result.agents[0].heartbeat).toBe(true)
    expect(result.agents[1].heartbeat).toBe(false)
    expect(result.summary.withHeartbeat).toBe(1)
    expect(result.summary.withoutHeartbeat).toBe(1)
  })

  it('strips trailing slash from controlPlaneUrl', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '[]' })

    await listAgents({ controlPlaneUrl: 'http://localhost:8080/' })

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/v1/agents')
  })

  it('gracefully handles control plane fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = JSON.parse(await listAgents({ controlPlaneUrl: 'http://localhost:8080' }))

    expect(result.agents).toEqual([])
    expect(result.source).toBe('cluster')
    expect(result.summary.total).toBe(0)
  })

  it('gracefully handles non-ok response from control plane', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' })

    const result = JSON.parse(await listAgents({ controlPlaneUrl: 'http://localhost:8080' }))

    expect(result.agents).toEqual([])
    expect(result.source).toBe('cluster')
  })
})

describe('listAgents — local mode (no controlPlaneUrl)', () => {
  it('falls back to filesystem scan when no controlPlaneUrl', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'agentspec-test-'))
    const result = JSON.parse(await listAgents({ dir: emptyDir }))

    expect(result.source).toBe('local')
  })
})
