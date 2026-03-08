import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnCli } from '../cli-runner.js'
import { EventEmitter } from 'events'

// ── Spawn mock ────────────────────────────────────────────────────────────────

function makeFakeChild(stdout: string, exitCode: number) {
  const child = new EventEmitter() as ReturnType<typeof import('child_process').spawn>
  const stdoutStream = new EventEmitter()
  const stderrStream = new EventEmitter()
  // @ts-expect-error mock
  child.stdout = stdoutStream
  // @ts-expect-error mock
  child.stderr = stderrStream

  // Emit stdout data and close on next tick
  process.nextTick(() => {
    if (stdout) stdoutStream.emit('data', Buffer.from(stdout))
    child.emit('close', exitCode)
  })

  return child
}

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import * as childProcess from 'child_process'
const spawnMock = vi.mocked(childProcess.spawn)

beforeEach(() => {
  spawnMock.mockReset()
  delete process.env['AGENTSPEC_BIN']
})

afterEach(() => {
  delete process.env['AGENTSPEC_BIN']
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('spawnCli()', () => {
  it('resolves "agentspec" bin by default', async () => {
    spawnMock.mockReturnValue(makeFakeChild('ok\n', 0) as ReturnType<typeof import('child_process').spawn>)
    await spawnCli(['validate', 'agent.yaml'])
    expect(spawnMock).toHaveBeenCalledWith('agentspec', ['validate', 'agent.yaml'], { shell: false })
  })

  it('respects AGENTSPEC_BIN env var', async () => {
    process.env['AGENTSPEC_BIN'] = '/custom/bin/agentspec'
    spawnMock.mockReturnValue(makeFakeChild('ok\n', 0) as ReturnType<typeof import('child_process').spawn>)
    await spawnCli(['validate', 'agent.yaml'])
    expect(spawnMock).toHaveBeenCalledWith('/custom/bin/agentspec', expect.any(Array), expect.any(Object))
  })

  it('resolves with stdout on exit 0', async () => {
    spawnMock.mockReturnValue(makeFakeChild('{"success":true}\n', 0) as ReturnType<typeof import('child_process').spawn>)
    const result = await spawnCli(['validate', 'agent.yaml'])
    expect(result).toBe('{"success":true}\n')
  })

  it('rejects with stderr on non-zero exit', async () => {
    const child = new EventEmitter() as ReturnType<typeof import('child_process').spawn>
    const stderrStream = new EventEmitter()
    // @ts-expect-error mock
    child.stdout = new EventEmitter()
    // @ts-expect-error mock
    child.stderr = stderrStream
    process.nextTick(() => {
      stderrStream.emit('data', Buffer.from('file not found'))
      child.emit('close', 1)
    })
    spawnMock.mockReturnValue(child)
    await expect(spawnCli(['validate', 'missing.yaml'])).rejects.toThrow('file not found')
  })

  it('rejects with spawn error when binary is not found', async () => {
    const child = new EventEmitter() as ReturnType<typeof import('child_process').spawn>
    // @ts-expect-error mock
    child.stdout = new EventEmitter()
    // @ts-expect-error mock
    child.stderr = new EventEmitter()
    process.nextTick(() => {
      child.emit('error', new Error('ENOENT'))
    })
    spawnMock.mockReturnValue(child)
    await expect(spawnCli(['validate', 'agent.yaml'])).rejects.toThrow('ENOENT')
  })

  it('includes all args in spawn call', async () => {
    spawnMock.mockReturnValue(makeFakeChild('', 0) as ReturnType<typeof import('child_process').spawn>)
    await spawnCli(['audit', 'agent.yaml', '--json', '--pack', 'owasp-llm-top10'])
    expect(spawnMock).toHaveBeenCalledWith(
      'agentspec',
      ['audit', 'agent.yaml', '--json', '--pack', 'owasp-llm-top10'],
      { shell: false },
    )
  })
})
