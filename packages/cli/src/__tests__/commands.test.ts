/**
 * Unit tests for all CLI commands: validate, audit, health, export, migrate, init.
 *
 * Strategy:
 * - Mock @agentspec/sdk, node:fs, and @clack/prompts at module level
 * - Use process.exit spy that throws ExitError — prevents undefined-access after
 *   a mocked exit and makes "expects exit(1)" tests clean and unambiguous
 * - Each command test creates a fresh Commander instance via `runCommand()`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ── Hoisted mock functions (must be declared before vi.mock factories) ─────────

const {
  mockLoadManifest,
  mockRunAudit,
  mockRunHealthCheck,
  mockMigrateManifest,
  mockDetectVersion,
  mockIsLatestVersion,
} = vi.hoisted(() => ({
  mockLoadManifest: vi.fn(),
  mockRunAudit: vi.fn(),
  mockRunHealthCheck: vi.fn(),
  mockMigrateManifest: vi.fn(),
  mockDetectVersion: vi.fn(),
  mockIsLatestVersion: vi.fn(),
}))

const { mockWriteFileSync, mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}))

const {
  mockConfirm,
  mockIsCancel,
  mockCancel,
  mockIntro,
  mockGroup,
  mockOutro,
} = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockIsCancel: vi.fn(),
  mockCancel: vi.fn(),
  mockIntro: vi.fn(),
  mockGroup: vi.fn(),
  mockOutro: vi.fn(),
}))

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('@agentspec/sdk', () => ({
  loadManifest: mockLoadManifest,
  runAudit: mockRunAudit,
  runHealthCheck: mockRunHealthCheck,
  migrateManifest: mockMigrateManifest,
  detectVersion: mockDetectVersion,
  isLatestVersion: mockIsLatestVersion,
  LATEST_API_VERSION: 'agentspec.io/v1',
}))

vi.mock('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}))

vi.mock('@clack/prompts', () => ({
  confirm: mockConfirm,
  isCancel: mockIsCancel,
  cancel: mockCancel,
  intro: mockIntro,
  group: mockGroup,
  outro: mockOutro,
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}))

// ── Test data ─────────────────────────────────────────────────────────────────

const mockManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'test-agent',
    version: '1.0.0',
    description: 'A test agent',
    tags: ['ai'],
    author: 'Tester',
  },
  spec: {
    model: { provider: 'openai', id: 'gpt-4o', apiKey: 'literal-key' },
    tools: [],
    mcp: { servers: [] },
    skills: [],
    memory: undefined,
    api: undefined,
  },
}

const mockLoadResult = {
  manifest: mockManifest,
  filePath: '/fake/agent.yaml',
  raw: 'apiVersion: agentspec.io/v1',
  baseDir: '/fake',
}

// ── Custom exit error (makes tests unambiguous) ───────────────────────────────

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitError'
  }
}

// ── Shared setup ──────────────────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    // Only throw for non-zero exit codes — exit(0) returns normally so action
    // handlers can continue past the process.exit call (e.g. JSON mode early return)
    if ((code ?? 0) !== 0) {
      throw new ExitError(code ?? 0)
    }
  }) as unknown as typeof process.exit)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Helper ────────────────────────────────────────────────────────────────────

async function runCommand(register: (p: Command) => void, args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  register(program)
  await program.parseAsync(['node', 'cli', ...args])
}

function logOutput(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join('\n')
}

// ── validate command ──────────────────────────────────────────────────────────

describe('validate command', () => {
  async function run(args: string[]): Promise<void> {
    const { registerValidateCommand } = await import('../commands/validate.js')
    return runCommand(registerValidateCommand, ['validate', ...args])
  }

  it('prints manifest details in text mode for a valid manifest', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('test-agent')
  })

  it('shows model provider/id in text mode', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('openai')
  })

  it('outputs JSON with valid:true in --json mode', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    await run(['/fake/agent.yaml', '--json'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.valid).toBe(true)
    expect(parsed.agentName).toBe('test-agent')
    expect(parsed.version).toBe('1.0.0')
    expect(parsed.apiVersion).toBe('agentspec.io/v1')
  })

  it('throws ExitError(1) when loadManifest throws (text mode)', async () => {
    mockLoadManifest.mockImplementation(() => { throw new Error('No such file') })
    await expect(run(['/nonexistent/agent.yaml'])).rejects.toThrow('process.exit(1)')
  })

  it('outputs JSON with valid:false and exits 1 when file is missing (--json mode)', async () => {
    mockLoadManifest.mockImplementation(() => { throw new Error('Cannot read manifest') })
    await expect(run(['/nonexistent.yaml', '--json'])).rejects.toThrow('process.exit(1)')
    const parsed = JSON.parse(logOutput())
    expect(parsed.valid).toBe(false)
    expect(parsed.error).toContain('Cannot read manifest')
  })

  it('handles ZodError by printing individual issues (text mode)', async () => {
    class ZodError extends Error {}
    const zodErr = new ZodError('[{"path":["spec","model"],"message":"Field required"}]')
    mockLoadManifest.mockImplementation(() => { throw zodErr })
    await expect(run(['/fake/agent.yaml'])).rejects.toThrow('process.exit(1)')
    const errOutput = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errOutput).toContain('Manifest validation failed')
  })

  it('wraps non-array ZodError message correctly', async () => {
    class ZodError extends Error {}
    const zodErr = new ZodError('Unexpected error message')
    mockLoadManifest.mockImplementation(() => { throw zodErr })
    await expect(run(['/fake/agent.yaml'])).rejects.toThrow('process.exit(1)')
    const errOutput = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errOutput).toContain('Manifest validation failed')
  })

  it('shows tools and MCP server counts', async () => {
    mockLoadManifest.mockReturnValue({
      ...mockLoadResult,
      manifest: {
        ...mockManifest,
        spec: {
          ...mockManifest.spec,
          tools: [{ name: 'tool1' }, { name: 'tool2' }],
          mcp: { servers: [{ name: 'server1' }] },
          memory: { shortTerm: {} },
        },
      },
    })
    await run(['/fake/agent.yaml'])
    const out = logOutput()
    expect(out).toContain('2')
    expect(out).toContain('1')
    expect(out).toContain('configured')
  })
})

// ── audit command ─────────────────────────────────────────────────────────────

describe('audit command', () => {
  async function run(args: string[]): Promise<void> {
    const { registerAuditCommand } = await import('../commands/audit.js')
    return runCommand(registerAuditCommand, ['audit', ...args])
  }

  const mockAuditReport = {
    overallScore: 85,
    grade: 'B',
    passedRules: 10,
    totalRules: 12,
    categoryScores: { security: 80, reliability: 90 },
    violations: [],
    suppressions: [],
    evidenceBreakdown: {
      declarative: { passed: 0, total: 0 },
      probed:      { passed: 10, total: 12 },
      behavioral:  { passed: 0, total: 0 },
      external:    { passed: 0, total: 0 },
    },
  }

  it('displays human-readable audit output', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue(mockAuditReport)
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('Score')
    expect(logOutput()).toContain('Rules')
  })

  it('shows category scores with progress bars', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue(mockAuditReport)
    await run(['/fake/agent.yaml'])
    const out = logOutput()
    expect(out).toContain('security')
    expect(out).toContain('reliability')
  })

  it('outputs JSON with audit report in --json mode', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue(mockAuditReport)
    await run(['/fake/agent.yaml', '--json'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.overallScore).toBe(85)
    expect(parsed.grade).toBe('B')
  })

  it('writes report to --output file', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue(mockAuditReport)
    await run(['/fake/agent.yaml', '--output', '/tmp/report.json'])
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/report.json',
      expect.stringContaining('"overallScore"'),
      'utf-8',
    )
  })

  it('throws ExitError(1) when loadManifest throws', async () => {
    mockLoadManifest.mockImplementation(() => { throw new Error('No such file') })
    await expect(run(['/nonexistent/agent.yaml'])).rejects.toThrow('process.exit(1)')
  })

  it('exits 1 when score is below --fail-below threshold (text mode)', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue({ ...mockAuditReport, overallScore: 50 })
    await expect(run(['/fake/agent.yaml', '--fail-below', '60'])).rejects.toThrow(
      'process.exit(1)',
    )
    const errOut = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errOut).toContain('50')
    expect(errOut).toContain('60')
  })

  it('exits 1 when score is below --fail-below threshold (--json mode)', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue({ ...mockAuditReport, overallScore: 50 })
    await expect(
      run(['/fake/agent.yaml', '--json', '--fail-below', '60']),
    ).rejects.toThrow('process.exit(1)')
  })

  it('does NOT exit when score meets --fail-below threshold', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue({ ...mockAuditReport, overallScore: 85 })
    await run(['/fake/agent.yaml', '--fail-below', '60'])
    // no throw = exit not called
  })

  it('displays violations with path, recommendation, and references', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue({
      ...mockAuditReport,
      violations: [
        {
          ruleId: 'SEC-001',
          title: 'Missing guardrail',
          severity: 'high',
          message: 'No guardrails configured',
          path: 'spec.guardrails',
          recommendation: 'Add guardrails',
          references: ['https://example.com/sec'],
        },
      ],
    })
    await run(['/fake/agent.yaml'])
    const out = logOutput()
    expect(out).toContain('Violations')
    expect(out).toContain('SEC-001')
    expect(out).toContain('Missing guardrail')
    expect(out).toContain('Add guardrails')
    expect(out).toContain('https://example.com/sec')
  })

  it('displays violation path when present', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue({
      ...mockAuditReport,
      violations: [
        {
          ruleId: 'SEC-002',
          title: 'Issue',
          severity: 'medium',
          message: 'Some issue',
          path: 'spec.model.apiKey',
        },
      ],
    })
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('spec.model.apiKey')
  })

  it('displays suppressions when present', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue({
      ...mockAuditReport,
      suppressions: [{ ruleId: 'SEC-001', reason: 'Intentionally disabled for testing' }],
    })
    await run(['/fake/agent.yaml'])
    const out = logOutput()
    expect(out).toContain('Suppressions')
    expect(out).toContain('Intentionally disabled for testing')
  })

  it('passes --pack option to runAudit', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue(mockAuditReport)
    await run(['/fake/agent.yaml', '--pack', 'owasp-llm-top10'])
    expect(mockRunAudit).toHaveBeenCalledWith(
      mockManifest,
      { packs: ['owasp-llm-top10'], proofRecords: undefined },
    )
  })

  it('passes undefined packs to runAudit when no --pack specified', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue(mockAuditReport)
    await run(['/fake/agent.yaml'])
    expect(mockRunAudit).toHaveBeenCalledWith(mockManifest, { packs: undefined, proofRecords: undefined })
  })

  it('shows [P] badge for probed violations', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue({
      ...mockAuditReport,
      violations: [
        {
          ruleId: 'SEC-LLM-05',
          title: 'Supply chain: model provider and version pinned',
          severity: 'medium',
          message: 'Model provider or version not pinned.',
          evidenceLevel: 'probed',
        },
      ],
    })
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('[P]')
  })

  it('shows [X] badge for external violations', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue({
      ...mockAuditReport,
      violations: [
        {
          ruleId: 'SEC-LLM-04',
          title: 'Model DoS: rate limiting + cost controls declared',
          severity: 'medium',
          message: 'No rate limiting or cost controls declared.',
          evidenceLevel: 'external',
          proofTool: 'k6 load test',
        },
      ],
    })
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('[X]')
  })

  it('shows evidence breakdown footer', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunAudit.mockReturnValue(mockAuditReport)
    await run(['/fake/agent.yaml'])
    const out = logOutput()
    expect(out).toContain('Evidence')
    expect(out).toContain('Declarative')
  })
})

// ── health command ────────────────────────────────────────────────────────────

describe('health command', () => {
  async function run(args: string[]): Promise<void> {
    const { registerHealthCommand } = await import('../commands/health.js')
    return runCommand(registerHealthCommand, ['health', ...args])
  }

  const passCheck = { id: 'model:openai/gpt-4o', status: 'pass', category: 'model', severity: 'error', latencyMs: 42 }
  const warnFailCheck = { id: 'memory:redis', status: 'fail', category: 'memory', severity: 'warning', message: 'Not reachable', remediation: 'Start Redis' }
  const errFailCheck = { id: 'env:OPENAI_API_KEY', status: 'fail', category: 'env', severity: 'error', message: 'Missing' }

  const healthyReport = {
    status: 'healthy',
    summary: { passed: 1, failed: 0, skipped: 0 },
    checks: [passCheck],
  }

  it('displays health check status in table mode', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue(healthyReport)
    await run(['/fake/agent.yaml'])
    const out = logOutput()
    expect(out).toContain('healthy')
    expect(out).toContain('MODEL')
  })

  it('shows latency for checks that have it', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue(healthyReport)
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('42ms')
  })

  it('shows message for failing checks', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      status: 'unhealthy',
      checks: [warnFailCheck],
    })
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('Not reachable')
  })

  it('shows remediation for failing checks', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      status: 'unhealthy',
      checks: [warnFailCheck],
    })
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('Start Redis')
  })

  it('outputs JSON report in --json mode', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue(healthyReport)
    await run(['/fake/agent.yaml', '--json'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.status).toBe('healthy')
    expect(Array.isArray(parsed.checks)).toBe(true)
  })

  it('outputs JSON via --format json', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue(healthyReport)
    await run(['/fake/agent.yaml', '--format', 'json'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.status).toBe('healthy')
  })

  it('throws ExitError(1) when loadManifest throws', async () => {
    mockLoadManifest.mockImplementation(() => { throw new Error('Not found') })
    await expect(run(['/nonexistent/agent.yaml'])).rejects.toThrow('process.exit(1)')
  })

  it('exits 1 for error-severity failure with default --fail-on error', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      checks: [errFailCheck],
    })
    await expect(run(['/fake/agent.yaml'])).rejects.toThrow('process.exit(1)')
  })

  it('does NOT exit 1 for warning-severity failure with --fail-on error (default)', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      checks: [warnFailCheck],
    })
    // Should complete without throwing
    await run(['/fake/agent.yaml'])
  })

  it('exits 1 for warning-severity failure with --fail-on warning', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      checks: [warnFailCheck],
    })
    await expect(run(['/fake/agent.yaml', '--fail-on', 'warning'])).rejects.toThrow(
      'process.exit(1)',
    )
  })

  it('exits 1 for any failure with --fail-on info', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      checks: [{ id: 'x', status: 'fail', category: 'env', severity: 'info' }],
    })
    await expect(run(['/fake/agent.yaml', '--fail-on', 'info'])).rejects.toThrow(
      'process.exit(1)',
    )
  })

  it('groups checks by category in table output', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      checks: [
        { id: 'model:openai/gpt-4o', status: 'pass', category: 'model', severity: 'error' },
        { id: 'env:OPENAI_API_KEY', status: 'pass', category: 'env', severity: 'error' },
      ],
    })
    await run(['/fake/agent.yaml'])
    const out = logOutput()
    expect(out).toContain('MODEL')
    expect(out).toContain('ENV')
  })

  it('uses warn symbol for checks with status "warn"', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      checks: [
        { id: 'mcp:myserver', status: 'warn', category: 'mcp', severity: 'warning', message: 'MCP server may be slow' },
      ],
    })
    await run(['/fake/agent.yaml'])
    // As long as no exception is thrown, the warn branch was exercised
    expect(logOutput()).toContain('mcp:myserver')
  })

  it('uses skip symbol for checks with status "skip"', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      checks: [
        { id: 'memory:redis', status: 'skip', category: 'memory', severity: 'warning', message: 'Not configured' },
      ],
    })
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('memory:redis')
  })

  it('does NOT exit for warning-severity failure with --fail-on error in json mode', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    mockRunHealthCheck.mockResolvedValue({
      ...healthyReport,
      checks: [warnFailCheck],
    })
    await run(['/fake/agent.yaml', '--json'])
    // Warning fails should not trigger exit under --fail-on error
  })
})

// ── export command ────────────────────────────────────────────────────────────

describe('export command', () => {
  async function run(args: string[]): Promise<void> {
    const { registerExportCommand } = await import('../commands/export.js')
    return runCommand(registerExportCommand, ['export', ...args])
  }

  it('outputs AgentCard JSON for --format agentcard', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    await run(['/fake/agent.yaml', '--format', 'agentcard'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.name).toBe('test-agent')
    expect(parsed.description).toBe('A test agent')
    expect(parsed.version).toBe('1.0.0')
    expect(parsed.capabilities).toBeDefined()
    expect(parsed.skills).toEqual([])
    expect(parsed.provider.organization).toBe('Tester')
  })

  it('includes skills in agentcard output', async () => {
    mockLoadManifest.mockReturnValue({
      ...mockLoadResult,
      manifest: {
        ...mockManifest,
        spec: {
          ...mockManifest.spec,
          skills: [{ id: 'fitness', name: 'Fitness', module: 'skills.fitness' }],
        },
      },
    })
    await run(['/fake/agent.yaml', '--format', 'agentcard'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.skills).toHaveLength(1)
    expect(parsed.skills[0].id).toBe('fitness')
  })

  it('includes API URL when spec.api is defined', async () => {
    mockLoadManifest.mockReturnValue({
      ...mockLoadResult,
      manifest: {
        ...mockManifest,
        spec: {
          ...mockManifest.spec,
          api: { port: 9090, pathPrefix: '/api/v2', streaming: true },
        },
      },
    })
    await run(['/fake/agent.yaml', '--format', 'agentcard'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.url).toContain('9090')
    expect(parsed.url).toContain('/api/v2')
    expect(parsed.capabilities.streaming).toBe(true)
  })

  it('uses default port 8000 and pathPrefix /api/v1 when not specified', async () => {
    mockLoadManifest.mockReturnValue({
      ...mockLoadResult,
      manifest: {
        ...mockManifest,
        spec: { ...mockManifest.spec, api: { streaming: false } },
      },
    })
    await run(['/fake/agent.yaml', '--format', 'agentcard'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.url).toContain('8000')
    expect(parsed.url).toContain('/api/v1')
  })

  it('includes stateTransitionHistory when longTerm memory is configured', async () => {
    mockLoadManifest.mockReturnValue({
      ...mockLoadResult,
      manifest: {
        ...mockManifest,
        spec: {
          ...mockManifest.spec,
          memory: { longTerm: { backend: 'postgres' } },
        },
      },
    })
    await run(['/fake/agent.yaml', '--format', 'agentcard'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.capabilities.stateTransitionHistory).toBe(true)
  })

  it('outputs agents-md-block markdown for --format agents-md-block', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    await run(['/fake/agent.yaml', '--format', 'agents-md-block'])
    const out = logOutput()
    expect(out).toContain('## Agent Manifest')
    expect(out).toContain('test-agent')
    expect(out).toContain('openai/gpt-4o')
    expect(out).toContain('npx agentspec health agent.yaml')
  })

  it('throws ExitError(1) for unknown format', async () => {
    mockLoadManifest.mockReturnValue(mockLoadResult)
    await expect(
      run(['/fake/agent.yaml', '--format', 'unknown-fmt']),
    ).rejects.toThrow('process.exit(1)')
  })

  it('throws ExitError(1) when loadManifest throws', async () => {
    mockLoadManifest.mockImplementation(() => { throw new Error('Missing file') })
    await expect(
      run(['/nonexistent.yaml', '--format', 'agentcard']),
    ).rejects.toThrow('process.exit(1)')
  })
})

// ── migrate command ───────────────────────────────────────────────────────────

describe('migrate command', () => {
  async function run(args: string[]): Promise<void> {
    const { registerMigrateCommand } = await import('../commands/migrate.js')
    return runCommand(registerMigrateCommand, ['migrate', ...args])
  }

  const validYaml = 'apiVersion: agentspec/v1alpha1\nkind: AgentSpec\nmetadata:\n  name: old-agent\n'
  const migratedObj = {
    apiVersion: 'agentspec.io/v1',
    kind: 'AgentSpec',
    metadata: { name: 'old-agent' },
  }

  it('prints "already at latest version" when already up to date', async () => {
    mockReadFileSync.mockReturnValue('apiVersion: agentspec.io/v1\nkind: AgentSpec\n')
    mockDetectVersion.mockReturnValue('agentspec.io/v1')
    mockIsLatestVersion.mockReturnValue(true)
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('latest')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('applies migration and writes updated file', async () => {
    mockReadFileSync.mockReturnValue(validYaml)
    mockDetectVersion.mockReturnValue('agentspec/v1alpha1')
    mockIsLatestVersion.mockReturnValue(false)
    mockMigrateManifest.mockReturnValue({
      result: migratedObj,
      migrationsApplied: ['agentspec/v1alpha1 → agentspec.io/v1'],
    })
    await run(['/fake/agent.yaml'])
    expect(mockWriteFileSync).toHaveBeenCalled()
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string
    expect(writtenPath).toContain('agent.yaml')
  })

  it('shows migration steps applied', async () => {
    mockReadFileSync.mockReturnValue(validYaml)
    mockDetectVersion.mockReturnValue('agentspec/v1alpha1')
    mockIsLatestVersion.mockReturnValue(false)
    mockMigrateManifest.mockReturnValue({
      result: migratedObj,
      migrationsApplied: ['agentspec/v1alpha1 → agentspec.io/v1'],
    })
    await run(['/fake/agent.yaml'])
    expect(logOutput()).toContain('agentspec/v1alpha1')
  })

  it('shows dry-run output without writing file', async () => {
    mockReadFileSync.mockReturnValue(validYaml)
    mockDetectVersion.mockReturnValue('agentspec/v1alpha1')
    mockIsLatestVersion.mockReturnValue(false)
    mockMigrateManifest.mockReturnValue({
      result: migratedObj,
      migrationsApplied: ['agentspec/v1alpha1 → agentspec.io/v1'],
    })
    await run(['/fake/agent.yaml', '--dry-run'])
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(logOutput()).toContain('dry-run')
  })

  it('writes to --output path instead of original', async () => {
    mockReadFileSync.mockReturnValue(validYaml)
    mockDetectVersion.mockReturnValue('agentspec/v1alpha1')
    mockIsLatestVersion.mockReturnValue(false)
    mockMigrateManifest.mockReturnValue({
      result: migratedObj,
      migrationsApplied: ['migration'],
    })
    await run(['/fake/agent.yaml', '--output', '/output/migrated.yaml'])
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string
    expect(writtenPath).toContain('migrated.yaml')
  })

  it('throws ExitError(1) when readFileSync throws', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('Permission denied') })
    await expect(run(['/protected/agent.yaml'])).rejects.toThrow('process.exit(1)')
  })

  it('throws ExitError(1) when YAML is invalid', async () => {
    // Tab-indented YAML which is invalid in YAML spec
    mockReadFileSync.mockReturnValue('apiVersion: foo\n\t: bad-tab-indent')
    await expect(run(['/fake/agent.yaml'])).rejects.toThrow('process.exit(1)')
  })

  it('throws ExitError(1) when no migration path found (empty migrationsApplied)', async () => {
    mockReadFileSync.mockReturnValue(validYaml)
    mockDetectVersion.mockReturnValue('unknown/v99')
    mockIsLatestVersion.mockReturnValue(false)
    mockMigrateManifest.mockReturnValue({
      result: {},
      migrationsApplied: [], // no path found
    })
    await expect(run(['/fake/agent.yaml'])).rejects.toThrow('process.exit(1)')
    expect(logOutput()).toContain('No migration path')
  })

  it('throws ExitError(1) when writeFileSync throws', async () => {
    mockReadFileSync.mockReturnValue(validYaml)
    mockDetectVersion.mockReturnValue('agentspec/v1alpha1')
    mockIsLatestVersion.mockReturnValue(false)
    mockMigrateManifest.mockReturnValue({
      result: migratedObj,
      migrationsApplied: ['migration'],
    })
    mockWriteFileSync.mockImplementation(() => { throw new Error('Disk full') })
    await expect(run(['/fake/agent.yaml'])).rejects.toThrow('process.exit(1)')
  })
})

// ── init command ──────────────────────────────────────────────────────────────

describe('init command', () => {
  async function run(args: string[]): Promise<void> {
    const { registerInitCommand } = await import('../commands/init.js')
    return runCommand(registerInitCommand, ['init', ...args])
  }

  it('creates agent.yaml with defaults using --yes (file does not exist)', async () => {
    mockExistsSync.mockReturnValue(false)
    await run(['--yes'])
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const content = mockWriteFileSync.mock.calls[0][1] as string
    expect(content).toContain('apiVersion: agentspec.io/v1')
    expect(content).toContain('my-agent')
  })

  it('skips overwrite prompt and creates file with --yes even when file exists', async () => {
    mockExistsSync.mockReturnValue(true)
    await run(['.', '--yes'])
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
  })

  it('creates manifest without memory section by default (--yes)', async () => {
    mockExistsSync.mockReturnValue(false)
    await run(['.', '--yes'])
    const content = mockWriteFileSync.mock.calls[0][1] as string
    expect(content).not.toContain('memory:')
  })

  it('creates manifest with guardrails section by default (--yes)', async () => {
    mockExistsSync.mockReturnValue(false)
    await run(['.', '--yes'])
    const content = mockWriteFileSync.mock.calls[0][1] as string
    expect(content).toContain('guardrails:')
  })

  it('prompts for overwrite when file exists without --yes', async () => {
    mockExistsSync.mockReturnValue(true)
    mockConfirm.mockResolvedValue(true)
    mockIsCancel.mockReturnValue(false)
    mockGroup.mockResolvedValue({
      name: 'test-agent',
      description: 'A test agent',
      version: '1.0.0',
      provider: 'openai',
      modelId: 'gpt-4o',
      includeMemory: false,
      includeGuardrails: true,
      includeEval: false,
    })
    await run(['.'])
    expect(mockConfirm).toHaveBeenCalledOnce()
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
  })

  it('cancels init when user declines overwrite (confirm returns false)', async () => {
    mockExistsSync.mockReturnValue(true)
    mockConfirm.mockResolvedValue(false)
    mockIsCancel.mockReturnValue(false)
    await run(['.'])
    expect(mockCancel).toHaveBeenCalledWith('Init cancelled.')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('cancels init when user cancels the confirm prompt (isCancel returns true)', async () => {
    mockExistsSync.mockReturnValue(true)
    const cancelSymbol = Symbol('cancel')
    mockConfirm.mockResolvedValue(cancelSymbol)
    mockIsCancel.mockReturnValue(true)
    await run(['.'])
    expect(mockCancel).toHaveBeenCalled()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('uses answers from group prompt for manifest content (interactive mode)', async () => {
    mockExistsSync.mockReturnValue(false)
    mockGroup.mockResolvedValue({
      name: 'my-custom-agent',
      description: 'Custom description',
      version: '2.0.0',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      includeMemory: true,
      includeGuardrails: false,
      includeEval: true,
    })
    await run(['.'])
    const content = mockWriteFileSync.mock.calls[0][1] as string
    expect(content).toContain('my-custom-agent')
    expect(content).toContain('anthropic')
    expect(content).toContain('claude-sonnet-4-6')
    expect(content).toContain('memory:')
    expect(content).toContain('evaluation:')
    expect(content).not.toContain('guardrails:')
  })

  it('generates ANTHROPIC_API_KEY env var reference for anthropic provider', async () => {
    mockExistsSync.mockReturnValue(false)
    mockGroup.mockResolvedValue({
      name: 'claude-agent',
      description: 'Claude agent',
      version: '0.1.0',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      includeMemory: false,
      includeGuardrails: false,
      includeEval: false,
    })
    await run(['.'])
    const content = mockWriteFileSync.mock.calls[0][1] as string
    expect(content).toContain('ANTHROPIC_API_KEY')
  })

  it('logs next steps after creation', async () => {
    mockExistsSync.mockReturnValue(false)
    await run(['.', '--yes'])
    const out = logOutput()
    expect(out).toContain('Next steps')
    expect(out).toContain('validate')
  })
})
