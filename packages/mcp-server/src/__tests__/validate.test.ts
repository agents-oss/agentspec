import { describe, it, expect, vi } from 'vitest'
import { validate } from '../tools/validate.js'

vi.mock('../cli-runner.js', () => ({
  spawnCli: vi.fn(),
}))

import { spawnCli } from '../cli-runner.js'
const spawnCliMock = vi.mocked(spawnCli)

describe('validate()', () => {
  it('returns JSON with success:true and output on success', async () => {
    spawnCliMock.mockResolvedValue('Validation passed\n')
    const result = await validate('agent.yaml')
    const parsed = JSON.parse(result)
    expect(parsed.success).toBe(true)
    expect(parsed.output).toBe('Validation passed')
  })

  it('calls spawnCli with validate and file arg', async () => {
    spawnCliMock.mockResolvedValue('')
    await validate('/workspace/agent.yaml')
    expect(spawnCliMock).toHaveBeenCalledWith(['validate', '/workspace/agent.yaml'])
  })

  it('propagates errors from spawnCli', async () => {
    spawnCliMock.mockRejectedValue(new Error('Schema violation at line 3'))
    await expect(validate('bad.yaml')).rejects.toThrow('Schema violation at line 3')
  })

  it('trims whitespace from output', async () => {
    spawnCliMock.mockResolvedValue('  ok  \n')
    const result = await validate('agent.yaml')
    expect(JSON.parse(result).output).toBe('ok')
  })
})
