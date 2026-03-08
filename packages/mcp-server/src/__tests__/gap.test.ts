import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gap } from '../tools/gap.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const GAP_REPORT = JSON.stringify({
  agentName: 'budget-assistant',
  score: 72,
  gaps: [{ field: 'tool:create_expense', severity: 'error', message: 'not registered' }],
})

beforeEach(() => {
  fetchMock.mockReset()
})

describe('gap() — direct sidecar mode (sidecarUrl)', () => {
  it('calls fetch with /gap appended to sidecarUrl', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => GAP_REPORT })
    await gap({ sidecarUrl: 'http://localhost:4001' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/gap')
  })

  it('strips trailing slash from sidecarUrl before appending /gap', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => GAP_REPORT })
    await gap({ sidecarUrl: 'http://localhost:4001/' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/gap')
  })

  it('returns raw JSON string from sidecar', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => GAP_REPORT })
    const result = await gap({ sidecarUrl: 'http://localhost:4001' })
    expect(JSON.parse(result)).toMatchObject({ agentName: 'budget-assistant', score: 72 })
  })

  it('throws when sidecar returns non-200 status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' })
    await expect(gap({ sidecarUrl: 'http://localhost:4001' })).rejects.toThrow('503')
  })

  it('throws when fetch fails (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(gap({ sidecarUrl: 'http://localhost:4001' })).rejects.toThrow('ECONNREFUSED')
  })
})

describe('gap() — named agent via control plane (agentName + controlPlaneUrl)', () => {
  it('calls fetch with control plane gap endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => GAP_REPORT })
    await gap({ agentName: 'budget-assistant', controlPlaneUrl: 'https://cp.company.com' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.company.com/api/v1/agents/budget-assistant/gap',
      { headers: { Accept: 'application/json' } },
    )
  })

  it('includes X-Admin-Key header when adminKey provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => GAP_REPORT })
    await gap({
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://cp.company.com',
      adminKey: 'secret-key',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.company.com/api/v1/agents/budget-assistant/gap',
      { headers: { Accept: 'application/json', 'X-Admin-Key': 'secret-key' } },
    )
  })

  it('strips trailing slash from controlPlaneUrl', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => GAP_REPORT })
    await gap({ agentName: 'budget-assistant', controlPlaneUrl: 'https://cp.company.com/' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.company.com/api/v1/agents/budget-assistant/gap',
      expect.anything(),
    )
  })

  it('URL-encodes agent name with special characters', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => GAP_REPORT })
    await gap({ agentName: 'my agent', controlPlaneUrl: 'https://cp.company.com' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.company.com/api/v1/agents/my%20agent/gap',
      expect.anything(),
    )
  })

  it('throws when control plane returns non-200 status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(
      gap({ agentName: 'unknown-agent', controlPlaneUrl: 'https://cp.company.com' }),
    ).rejects.toThrow('404')
  })

  it('returns raw JSON from control plane', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => GAP_REPORT })
    const result = await gap({ agentName: 'budget-assistant', controlPlaneUrl: 'https://cp.company.com' })
    expect(JSON.parse(result)).toMatchObject({ score: 72 })
  })
})

describe('gap() — missing args', () => {
  it('throws when neither sidecarUrl nor agentName+controlPlaneUrl provided', async () => {
    await expect(gap({})).rejects.toThrow('agentName + controlPlaneUrl')
  })

  it('throws when agentName provided but controlPlaneUrl missing', async () => {
    await expect(gap({ agentName: 'budget-assistant' })).rejects.toThrow('agentName + controlPlaneUrl')
  })

  it('throws when controlPlaneUrl provided but agentName missing', async () => {
    await expect(gap({ controlPlaneUrl: 'https://cp.company.com' })).rejects.toThrow('agentName + controlPlaneUrl')
  })
})
