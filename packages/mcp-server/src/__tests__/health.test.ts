import { describe, it, expect, vi, beforeEach } from 'vitest'
import { health } from '../tools/health.js'

vi.mock('../cli-runner.js', () => ({
  spawnCli: vi.fn(),
}))

import { spawnCli } from '../cli-runner.js'
const spawnCliMock = vi.mocked(spawnCli)

const HEALTH_REPORT = JSON.stringify({
  status: 'healthy',
  checks: [
    { category: 'env', name: 'OPENAI_API_KEY', status: 'pass' },
    { category: 'model', name: 'openai/gpt-4o', status: 'pass' },
  ],
})

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

// ── File mode ─────────────────────────────────────────────────────────────────

describe('health() — file mode', () => {
  beforeEach(() => { spawnCliMock.mockReset(); fetchMock.mockReset() })

  it('calls spawnCli with health, file, and --json flags', async () => {
    spawnCliMock.mockResolvedValue(HEALTH_REPORT)
    await health({ file: 'agent.yaml' })
    expect(spawnCliMock).toHaveBeenCalledWith(['health', 'agent.yaml', '--json'])
  })

  it('returns raw JSON string from CLI', async () => {
    spawnCliMock.mockResolvedValue(HEALTH_REPORT + '\n')
    const result = await health({ file: 'agent.yaml' })
    expect(JSON.parse(result)).toMatchObject({ status: 'healthy' })
  })

  it('propagates errors from spawnCli', async () => {
    spawnCliMock.mockRejectedValue(new Error('Model API unreachable'))
    await expect(health({ file: 'agent.yaml' })).rejects.toThrow('Model API unreachable')
  })

  it('trims trailing whitespace from output', async () => {
    spawnCliMock.mockResolvedValue('{"status":"healthy"}\n\n')
    const result = await health({ file: 'agent.yaml' })
    expect(result).toBe('{"status":"healthy"}')
  })

  it('throws when no args provided', async () => {
    await expect(health({})).rejects.toThrow('One of file, sidecarUrl, or agentName+controlPlaneUrl is required')
  })
})

// ── Sidecar mode ──────────────────────────────────────────────────────────────

describe('health() — sidecar mode', () => {
  beforeEach(() => { spawnCliMock.mockReset(); fetchMock.mockReset() })

  it('fetches from GET <sidecarUrl>/health/ready', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'healthy' }) })
    const result = await health({ sidecarUrl: 'http://localhost:4001' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/health/ready')
    expect(JSON.parse(result)).toMatchObject({ status: 'healthy' })
  })

  it('strips trailing slash from sidecarUrl', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    await health({ sidecarUrl: 'http://localhost:4001/' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4001/health/ready')
  })

  it('throws when sidecar returns non-200', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' })
    await expect(health({ sidecarUrl: 'http://localhost:4001' })).rejects.toThrow('503')
  })

  it('does not call spawnCli in sidecar mode', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    await health({ sidecarUrl: 'http://localhost:4001' })
    expect(spawnCliMock).not.toHaveBeenCalled()
  })
})

// ── Operator mode ─────────────────────────────────────────────────────────────

describe('health() — operator mode', () => {
  beforeEach(() => { spawnCliMock.mockReset(); fetchMock.mockReset() })

  it('fetches from GET <controlPlaneUrl>/api/v1/agents/:name/health', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'healthy' }) })
    const result = await health({
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://agentspec.mycompany.com',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://agentspec.mycompany.com/api/v1/agents/budget-assistant/health',
      { headers: {} },
    )
    expect(JSON.parse(result)).toMatchObject({ status: 'healthy' })
  })

  it('sends X-Admin-Key header when adminKey provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    await health({
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://cp.example.com',
      adminKey: 'sk-secret',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.example.com/api/v1/agents/budget-assistant/health',
      { headers: { 'X-Admin-Key': 'sk-secret' } },
    )
  })

  it('URL-encodes agentName', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    await health({ agentName: 'my agent', controlPlaneUrl: 'https://cp.example.com' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.example.com/api/v1/agents/my%20agent/health',
      { headers: {} },
    )
  })

  it('throws when operator returns non-200', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(health({
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://cp.example.com',
    })).rejects.toThrow('404')
  })

  it('does not call spawnCli in operator mode', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    await health({ agentName: 'budget-assistant', controlPlaneUrl: 'https://cp.example.com' })
    expect(spawnCliMock).not.toHaveBeenCalled()
  })

  it('operator mode takes precedence over file when both provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'healthy' }) })
    await health({
      file: 'agent.yaml',
      agentName: 'budget-assistant',
      controlPlaneUrl: 'https://cp.example.com',
    })
    expect(spawnCliMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalled()
  })
})
