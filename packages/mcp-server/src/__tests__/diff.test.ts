import { describe, it, expect, vi } from 'vitest'
import { diff } from '../tools/diff.js'

vi.mock('../cli-runner.js', () => ({
  spawnCli: vi.fn(),
}))

import { spawnCli } from '../cli-runner.js'
const spawnCliMock = vi.mocked(spawnCli)

const DIFF_RESULT = JSON.stringify({
  changes: [
    { field: 'model.id', from: 'gpt-4', to: 'gpt-4o', type: 'changed' },
    { field: 'tools[0].name', from: undefined, to: 'web_search', type: 'added' },
  ],
})

describe('diff()', () => {
  it('calls spawnCli with both file args and --json', async () => {
    spawnCliMock.mockResolvedValue(DIFF_RESULT)
    await diff('v1/agent.yaml', 'v2/agent.yaml')
    expect(spawnCliMock).toHaveBeenCalledWith(['diff', 'v1/agent.yaml', 'v2/agent.yaml', '--json'])
  })

  it('returns parsed JSON diff', async () => {
    spawnCliMock.mockResolvedValue(DIFF_RESULT + '\n')
    const result = await diff('v1/agent.yaml', 'v2/agent.yaml')
    expect(JSON.parse(result)).toMatchObject({ changes: expect.arrayContaining([expect.objectContaining({ type: 'changed' })]) })
  })

  it('propagates errors from spawnCli', async () => {
    spawnCliMock.mockRejectedValue(new Error('v1/agent.yaml not found'))
    await expect(diff('v1/agent.yaml', 'v2/agent.yaml')).rejects.toThrow('v1/agent.yaml not found')
  })

  it('trims whitespace from output', async () => {
    spawnCliMock.mockResolvedValue('  {"changes":[]}\n  ')
    const result = await diff('a.yaml', 'b.yaml')
    expect(result).toBe('{"changes":[]}')
  })
})
