import { describe, it, expect, vi, beforeEach } from 'vitest'
import { audit } from '../tools/audit.js'

vi.mock('../cli-runner.js', () => ({
  spawnCli: vi.fn(),
}))

import { spawnCli } from '../cli-runner.js'
const spawnCliMock = vi.mocked(spawnCli)

const AUDIT_REPORT = JSON.stringify({ score: 82, grade: 'B', violations: [] })

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

describe('audit() — file mode (declarative)', () => {
  beforeEach(() => { spawnCliMock.mockReset(); fetchMock.mockReset() })

  it('calls spawnCli with audit, file, and --json', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    await audit({ file: 'agent.yaml' })
    expect(spawnCliMock).toHaveBeenCalledWith(['audit', 'agent.yaml', '--json'])
  })

  it('appends --pack when pack is provided', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    await audit({ file: 'agent.yaml', pack: 'owasp-llm-top10' })
    expect(spawnCliMock).toHaveBeenCalledWith([
      'audit', 'agent.yaml', '--json', '--pack', 'owasp-llm-top10',
    ])
  })

  it('returns trimmed raw JSON from CLI', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT + '\n')
    const result = await audit({ file: 'agent.yaml' })
    expect(JSON.parse(result)).toMatchObject({ score: 82, grade: 'B' })
  })

  it('propagates errors', async () => {
    spawnCliMock.mockRejectedValue(new Error('agent.yaml not found'))
    await expect(audit({ file: 'missing.yaml' })).rejects.toThrow('agent.yaml not found')
  })
})

describe('audit() — sidecar mode', () => {
  beforeEach(() => { spawnCliMock.mockReset(); fetchMock.mockReset() })

  it('appends --url when sidecarUrl is provided', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    await audit({ file: 'agent.yaml', sidecarUrl: 'http://localhost:4001' })
    expect(spawnCliMock).toHaveBeenCalledWith([
      'audit', 'agent.yaml', '--json', '--url', 'http://localhost:4001',
    ])
  })

  it('appends both --pack and --url when both are provided', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    await audit({ file: 'agent.yaml', pack: 'model-resilience', sidecarUrl: 'http://localhost:4001' })
    expect(spawnCliMock).toHaveBeenCalledWith([
      'audit', 'agent.yaml', '--json', '--pack', 'model-resilience', '--url', 'http://localhost:4001',
    ])
  })

  it('does not call fetch in sidecar mode (CLI handles it)', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    await audit({ file: 'agent.yaml', sidecarUrl: 'http://localhost:4001' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('audit() — operator mode', () => {
  beforeEach(() => { spawnCliMock.mockReset(); fetchMock.mockReset() })

  it('fetches proofs from operator and merges into audit output', async () => {
    const proofRecords = [{ ruleId: 'SEC-LLM-06', verifiedBy: 'audit-team' }]
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    // Operator returns { records: [...], receivedAt: "..." } — not a plain array
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ records: proofRecords, receivedAt: '2025-01-01T00:00:00Z' }),
    })

    const result = await audit({
      file: 'agent.yaml',
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://agentspec.mycompany.com',
    })

    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed.score).toBe(82)
    expect(parsed.proofRecords).toEqual(proofRecords)
    expect(parsed.source).toBe('operator')
  })

  it('fetches proofs with X-Admin-Key when adminKey provided', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] })

    await audit({
      file: 'agent.yaml',
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://cp.example.com',
      adminKey: 'sk-secret',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.example.com/api/v1/agents/budget-assistant/proof',
      { headers: { 'X-Admin-Key': 'sk-secret' } },
    )
  })

  it('URL-encodes agentName in operator proof URL', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] })

    await audit({
      file: 'agent.yaml',
      agentName: 'my agent',
      controlPlaneUrl: 'https://cp.example.com',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.example.com/api/v1/agents/my%20agent/proof',
      { headers: {} },
    )
  })

  it('returns empty proofRecords when operator proof fetch fails', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    fetchMock.mockResolvedValue({ ok: false, status: 404 })

    const result = await audit({
      file: 'agent.yaml',
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://cp.example.com',
    })

    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed.proofRecords).toEqual([])
  })

  it('also appends --pack when pack and operator params provided', async () => {
    spawnCliMock.mockResolvedValue(AUDIT_REPORT)
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] })

    await audit({
      file: 'agent.yaml',
      pack: 'owasp-llm-top10',
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://cp.example.com',
    })

    expect(spawnCliMock).toHaveBeenCalledWith([
      'audit', 'agent.yaml', '--json', '--pack', 'owasp-llm-top10',
    ])
  })
})
