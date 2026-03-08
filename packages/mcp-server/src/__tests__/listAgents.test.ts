import { describe, it, expect, vi, beforeEach } from 'vitest'
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

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })

    await expect(
      listAgents({ controlPlaneUrl: 'http://localhost:8080' }),
    ).rejects.toThrow('401')
  })

  it('strips trailing slash from controlPlaneUrl', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '[]' })

    await listAgents({ controlPlaneUrl: 'http://localhost:8080/' })

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/v1/agents')
  })

  it('returns empty agents array when cluster has none', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '[]' })

    const result = JSON.parse(await listAgents({ controlPlaneUrl: 'http://localhost:8080' }))

    expect(result.agents).toEqual([])
    expect(result.source).toBe('cluster')
  })
})

describe('listAgents — local mode (no controlPlaneUrl)', () => {
  it('falls back to filesystem scan when no controlPlaneUrl', async () => {
    // Pass a dir that certainly has no agent.yaml
    const result = JSON.parse(await listAgents({ dir: '/tmp' }))

    expect(result.source).toBe('local')
  })
})
