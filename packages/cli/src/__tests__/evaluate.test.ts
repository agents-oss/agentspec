/**
 * TDD tests for `agentspec evaluate` command.
 *
 * Written BEFORE implementation — these tests drive the design of evaluate.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const { mockLoadManifest } = vi.hoisted(() => ({
  mockLoadManifest: vi.fn(),
}))

const { mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}))

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}))

vi.mock('@agentspec/sdk', () => ({
  loadManifest: mockLoadManifest,
}))

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}))

// Mock global fetch
vi.stubGlobal('fetch', mockFetch)

// ── Helpers ────────────────────────────────────────────────────────────────────

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitError'
  }
}

async function runEvaluate(args: string[]): Promise<void> {
  const { Command } = await import('commander')
  const { registerEvaluateCommand } = await import('../commands/evaluate.js')
  const program = new Command()
  program.exitOverride()
  registerEvaluateCommand(program)
  await program.parseAsync(['node', 'agentspec', 'evaluate', ...args])
}

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

const mockManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: { name: 'test-agent', version: '1.0.0', description: 'A test agent' },
  spec: {
    model: { provider: 'openai', id: 'gpt-4o', apiKey: '$env:OPENAI_API_KEY' },
    prompts: { system: '$file:prompts/system.md', hotReload: false },
    evaluation: {
      framework: 'deepeval',
      datasets: [{ name: 'golden-qa', path: '$file:eval/qa.jsonl' }],
      metrics: ['faithfulness'],
      thresholds: { pass_rate: 0.8 },
      ciGate: true,
    },
    api: { type: 'rest', port: 8000, chatEndpoint: { path: '/v1/chat' } },
  },
}

const mockLoadResult = {
  manifest: mockManifest,
  filePath: '/fake/agent.yaml',
  raw: '',
  baseDir: '/fake',
}

// JSONL content: 3 samples, 2 will pass (string_match)
const JSONL_CONTENT = [
  '{"input":"What exercises for bad knees?","expected":"low-impact"}',
  '{"input":"Design a 5-day plan","expected":"rest day","tags":["planning"]}',
  '{"input":"Can I train every day?","expected":"recovery"}',
].join('\n')

function makeOkResponse(body: string) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ response: body }),
    text: () => Promise.resolve(body),
  } as unknown as Response)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    if ((code ?? 0) !== 0) throw new ExitError(code ?? 0)
  }) as unknown as (code?: number) => never)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function logOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('evaluate command', () => {
  it('loads JSONL dataset from declared path and sends inputs to agent', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSONL_CONTENT)
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ response: 'try low-impact cardio' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ response: 'include a rest day' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ response: 'no, you need recovery' }) })

    await runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'golden-qa'])
    expect(mockFetch).toHaveBeenCalledTimes(3)
    const out = logOutput()
    expect(out).toContain('golden-qa')
  })

  it('reports string match pass for expected substring in response', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{"input":"Hello","expected":"world"}\n')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ response: 'Hello world!' }),
    })

    await runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'golden-qa'])
    const out = logOutput()
    expect(out).toMatch(/✓|pass|PASS/i)
  })

  it('reports string match fail when expected substring is absent', async () => {
    // Disable ciGate so a failed string match doesn't cause exit 1 (tested separately)
    const manifestNoCiGate = {
      ...mockManifest,
      spec: {
        ...mockManifest.spec,
        evaluation: { ...mockManifest.spec.evaluation, ciGate: false },
      },
    }
    mockLoadManifest.mockReturnValue({ ...mockLoadResult, manifest: manifestNoCiGate })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{"input":"Hello","expected":"MISSING_STRING"}\n')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ response: 'Hello world!' }),
    })

    await runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'golden-qa'])
    const out = logOutput()
    expect(out).toMatch(/✗|fail|FAIL/i)
  })

  it('exits 0 when ciGate=false even with failures', async () => {
    const manifestNoCiGate = {
      ...mockManifest,
      spec: {
        ...mockManifest.spec,
        evaluation: { ...mockManifest.spec.evaluation, ciGate: false, thresholds: { pass_rate: 0.9 } },
      },
    }
    mockLoadManifest.mockReturnValue({ ...mockLoadResult, manifest: manifestNoCiGate })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{"input":"x","expected":"NEVER_FOUND"}\n')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ response: 'something else' }),
    })

    // Should NOT throw (exit 0)
    await expect(
      runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'golden-qa']),
    ).resolves.toBeUndefined()
  })

  it('exits 1 when ciGate=true and pass_rate below threshold', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockExistsSync.mockReturnValue(true)
    // All fail
    mockReadFileSync.mockReturnValue(
      '{"input":"a","expected":"NEVER_FOUND"}\n{"input":"b","expected":"ALSO_MISSING"}\n',
    )
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ response: 'nope' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ response: 'nope' }) })

    await expect(
      runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'golden-qa']),
    ).rejects.toThrow('process.exit(1)')
  })

  it('outputs JSON with --json flag', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{"input":"Hello","expected":"world"}\n')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ response: 'Hello world!' }),
    })

    await runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'golden-qa', '--json'])
    const out = logOutput()
    const parsed = JSON.parse(out)
    expect(parsed).toHaveProperty('metrics')
    expect(parsed.metrics).toHaveProperty('pass_rate')
    expect(parsed).toHaveProperty('samples')
  })

  it('handles agent connection refused gracefully', async () => {
    // Use a manifest with ciGate disabled so a network error doesn't trigger exit 1
    const manifestNoCiGate = {
      ...mockManifest,
      spec: {
        ...mockManifest.spec,
        evaluation: { ...mockManifest.spec.evaluation, ciGate: false },
      },
    }
    mockLoadManifest.mockReturnValue({ ...mockLoadResult, manifest: manifestNoCiGate })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{"input":"Hello","expected":"world"}\n')
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    // Should not throw — treated as a failed sample, not a crash
    await expect(
      runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'golden-qa']),
    ).resolves.toBeUndefined()

    const out = logOutput()
    expect(out).toMatch(/error|fail|FAIL|ECONNREFUSED/i)
  })

  it('limits samples with --sample-size', async () => {
    // Use a manifest with no ciGate so the result doesn't depend on which sample is picked
    const manifestNoCiGate = {
      ...mockManifest,
      spec: {
        ...mockManifest.spec,
        evaluation: { ...mockManifest.spec.evaluation, ciGate: false },
      },
    }
    mockLoadManifest.mockReturnValue({ ...mockLoadResult, manifest: manifestNoCiGate })
    mockExistsSync.mockReturnValue(true)
    // 3 samples in JSONL, only 1 should be sent
    mockReadFileSync.mockReturnValue(JSONL_CONTENT)
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ response: 'matched' }) })

    await runEvaluate([
      '/fake/agent.yaml', '--url', 'http://localhost:4000',
      '--dataset', 'golden-qa', '--sample-size', '1',
    ])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('exits 1 when dataset name not found in manifest', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    await expect(
      runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'nonexistent']),
    ).rejects.toThrow('process.exit(1)')
    const errOut = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errOut).toMatch(/nonexistent/i)
  })

  it('uses case-insensitive string matching', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{"input":"Test","expected":"LOW-IMPACT"}\n')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ response: 'try some low-impact exercises' }),
    })

    await runEvaluate(['/fake/agent.yaml', '--url', 'http://localhost:4000', '--dataset', 'golden-qa'])
    const out = logOutput()
    expect(out).toMatch(/✓|pass|PASS/i)
  })
})
