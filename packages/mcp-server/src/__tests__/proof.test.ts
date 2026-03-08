import { describe, it, expect, vi, beforeEach } from 'vitest'
import { proof } from '../tools/proof.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const PROOF_RECORDS = JSON.stringify([
  {
    ruleId: 'SEC-LLM-06',
    verifiedAt: '2026-03-01T10:00:00Z',
    verifiedBy: 'ci-pipeline',
    method: 'pii-scan',
    expiresAt: '2026-04-08T00:00:00Z',
  },
])

beforeEach(() => {
  fetchMock.mockReset()
})

describe('proof() — direct sidecar mode (sidecarUrl)', () => {
  it('calls fetch with /proof appended to sidecarUrl', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => PROOF_RECORDS })
    await proof({ sidecarUrl: 'http://localhost:4001' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/proof')
  })

  it('strips trailing slash from sidecarUrl before appending /proof', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => PROOF_RECORDS })
    await proof({ sidecarUrl: 'http://localhost:4001/' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/proof')
  })

  it('returns raw JSON string from sidecar', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => PROOF_RECORDS })
    const result = await proof({ sidecarUrl: 'http://localhost:4001' })
    const records = JSON.parse(result)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ ruleId: 'SEC-LLM-06', verifiedBy: 'ci-pipeline' })
  })

  it('throws when sidecar returns non-200 status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' })
    await expect(proof({ sidecarUrl: 'http://localhost:4001' })).rejects.toThrow('503')
  })

  it('throws when fetch fails (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(proof({ sidecarUrl: 'http://localhost:4001' })).rejects.toThrow('ECONNREFUSED')
  })
})

describe('proof() — named agent via control plane (agentName + controlPlaneUrl)', () => {
  it('calls fetch with control plane proof endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => PROOF_RECORDS })
    await proof({ agentName: 'budget-assistant', controlPlaneUrl: 'https://cp.company.com' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.company.com/api/v1/agents/budget-assistant/proof',
      { headers: { Accept: 'application/json' } },
    )
  })

  it('includes X-Admin-Key header when adminKey provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => PROOF_RECORDS })
    await proof({
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://cp.company.com',
      adminKey: 'secret-key',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.company.com/api/v1/agents/budget-assistant/proof',
      { headers: { Accept: 'application/json', 'X-Admin-Key': 'secret-key' } },
    )
  })

  it('strips trailing slash from controlPlaneUrl', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => PROOF_RECORDS })
    await proof({ agentName: 'budget-assistant', controlPlaneUrl: 'https://cp.company.com/' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.company.com/api/v1/agents/budget-assistant/proof',
      expect.anything(),
    )
  })

  it('URL-encodes agent name with special characters', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => PROOF_RECORDS })
    await proof({ agentName: 'my agent', controlPlaneUrl: 'https://cp.company.com' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.company.com/api/v1/agents/my%20agent/proof',
      expect.anything(),
    )
  })

  it('throws when control plane returns non-200 status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(
      proof({ agentName: 'unknown-agent', controlPlaneUrl: 'https://cp.company.com' }),
    ).rejects.toThrow('404')
  })

  it('returns raw JSON from control plane', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => PROOF_RECORDS })
    const result = await proof({ agentName: 'budget-assistant', controlPlaneUrl: 'https://cp.company.com' })
    expect(JSON.parse(result)).toHaveLength(1)
  })
})

describe('proof() — missing args', () => {
  it('throws when neither sidecarUrl nor agentName+controlPlaneUrl provided', async () => {
    await expect(proof({})).rejects.toThrow('agentName + controlPlaneUrl')
  })

  it('throws when agentName provided but controlPlaneUrl missing', async () => {
    await expect(proof({ agentName: 'budget-assistant' })).rejects.toThrow('agentName + controlPlaneUrl')
  })

  it('throws when controlPlaneUrl provided but agentName missing', async () => {
    await expect(proof({ controlPlaneUrl: 'https://cp.company.com' })).rejects.toThrow('agentName + controlPlaneUrl')
  })
})
