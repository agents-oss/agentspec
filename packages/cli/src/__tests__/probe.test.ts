/**
 * Unit tests for the `agentspec probe pii` command.
 *
 * Strategy: mock node:child_process (spawnSync) and node:fs (existsSync)
 * so no real Python process or file system access is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ── Hoisted mock functions ────────────────────────────────────────────────────

const { mockSpawnSync, mockExistsSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockExistsSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}))

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitError'
  }
}

async function runCommand(args: string[]): Promise<void> {
  const { registerProbeCommand } = await import('../commands/probe.js')
  const program = new Command()
  program.exitOverride()
  registerProbeCommand(program)
  await program.parseAsync(['node', 'agentspec', ...args])
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()

  // Default: log-file exists
  mockExistsSync.mockReturnValue(true)

  // Default: python3 --version succeeds (so resolvePython returns 'python3')
  // spawnSync is also used for the actual probe run — differentiate by args
  mockSpawnSync.mockImplementation((bin: string, args: string[]) => {
    if (args[0] === '--version') return { status: 0, error: undefined }
    // Actual probe run: return success
    return { status: 0, error: undefined }
  })

  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    if ((code ?? 0) !== 0) throw new ExitError(code ?? 0)
  }) as unknown as (code?: number) => never)

  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('agentspec probe pii — validation', () => {
  it('exits 1 when neither --log-file nor --text is provided', async () => {
    await expect(runCommand(['probe', 'pii', 'agent.yaml'])).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('at least one required'))
  })

  it('exits 1 when --log-file and --text are both provided (mutual exclusivity)', async () => {
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--log-file', '/tmp/agent.log', '--text', 'hello']),
    ).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'))
  })

  it('exits 1 when --submit is given without --sidecar-url', async () => {
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--log-file', '/tmp/agent.log', '--submit']),
    ).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--submit requires --sidecar-url'))
  })

  it('exits 1 when --threshold is not a valid float', async () => {
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello', '--threshold', 'banana']),
    ).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--threshold must be a number between 0.0 and 1.0'))
  })

  it('exits 1 when --threshold is out of range (> 1)', async () => {
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello', '--threshold', '1.5']),
    ).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('0.0 and 1.0'))
  })

  it('exits 1 when --threshold is out of range (< 0)', async () => {
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello', '--threshold', '-0.1']),
    ).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('0.0 and 1.0'))
  })

  it('exits 1 when --log-file does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--log-file', '/no/such/file.log']),
    ).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Log file not found'))
  })
})

describe('agentspec probe pii — python resolution', () => {
  it('exits 1 with clear message when python is not found', async () => {
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined })
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello']),
    ).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Python 3 not found'))
  })

  it('exits 1 with install hint when spawnSync returns an error', async () => {
    mockSpawnSync.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, error: undefined }
      return { status: null, error: new Error('ENOENT') }
    })
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello']),
    ).rejects.toThrow(ExitError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pip install agentspec'))
  })
})

describe('agentspec probe pii — correct arg assembly', () => {
  it('passes --manifest <file> and --log-file to python', async () => {
    await runCommand(['probe', 'pii', 'agent.yaml', '--log-file', '/tmp/agent.log'])
    // Find the call that is the actual probe run (not --version)
    const probeCall = mockSpawnSync.mock.calls.find(
      ([, args]: [string, string[]]) => args.includes('-m'),
    )
    expect(probeCall).toBeDefined()
    const [, pyArgs] = probeCall as [string, string[]]
    expect(pyArgs).toContain('--manifest')
    expect(pyArgs).toContain('agent.yaml')
    expect(pyArgs).toContain('--log-file')
    expect(pyArgs).toContain('/tmp/agent.log')
  })

  it('passes multiple --text values', async () => {
    await runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello', '--text', 'world'])
    const probeCall = mockSpawnSync.mock.calls.find(
      ([, args]: [string, string[]]) => args.includes('-m'),
    )
    const [, pyArgs] = probeCall as [string, string[]]
    const textIdx = pyArgs.indexOf('--text')
    expect(textIdx).toBeGreaterThan(-1)
    expect(pyArgs.filter((a: string) => a === '--text').length).toBe(2)
  })

  it('passes --sidecar-url and --submit when provided', async () => {
    await runCommand([
      'probe', 'pii', 'agent.yaml',
      '--text', 'hello',
      '--sidecar-url', 'http://localhost:4001',
      '--submit',
    ])
    const probeCall = mockSpawnSync.mock.calls.find(
      ([, args]: [string, string[]]) => args.includes('-m'),
    )
    const [, pyArgs] = probeCall as [string, string[]]
    expect(pyArgs).toContain('--sidecar-url')
    expect(pyArgs).toContain('http://localhost:4001')
    expect(pyArgs).toContain('--submit')
  })

  it('passes --threshold when provided', async () => {
    await runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello', '--threshold', '0.85'])
    const probeCall = mockSpawnSync.mock.calls.find(
      ([, args]: [string, string[]]) => args.includes('-m'),
    )
    const [, pyArgs] = probeCall as [string, string[]]
    expect(pyArgs).toContain('--threshold')
    expect(pyArgs).toContain('0.85')
  })

  it('passes --json flag when provided', async () => {
    await runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello', '--json'])
    const probeCall = mockSpawnSync.mock.calls.find(
      ([, args]: [string, string[]]) => args.includes('-m'),
    )
    const [, pyArgs] = probeCall as [string, string[]]
    expect(pyArgs).toContain('--json')
  })

  it('exits with the same status code as the python process', async () => {
    mockSpawnSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, error: undefined }
      return { status: 1, error: undefined } // PII found
    })
    await expect(
      runCommand(['probe', 'pii', 'agent.yaml', '--text', 'hello']),
    ).rejects.toThrow(ExitError)
  })
})
