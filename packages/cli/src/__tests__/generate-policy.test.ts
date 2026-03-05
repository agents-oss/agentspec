/**
 * TDD tests for `agentspec generate-policy <file>` command.
 *
 * Written before the implementation — these tests define the expected
 * behaviour of:
 *   1. generateRegoPolicy(manifest)  — pure Rego template function
 *   2. generateDataJson(manifest)    — pure threshold extractor
 *   3. registerGeneratePolicyCommand — Commander integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const { mockLoadManifest } = vi.hoisted(() => ({
  mockLoadManifest: vi.fn(),
}))

const { mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}))

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('@agentspec/sdk', () => ({
  loadManifest: mockLoadManifest,
}))

vi.mock('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}))

// ── Imports under test ─────────────────────────────────────────────────────────

import {
  generateRegoPolicy,
  generateDataJson,
  registerGeneratePolicyCommand,
} from '../commands/generate-policy.js'

// ── Test fixtures ──────────────────────────────────────────────────────────────

const fullManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: { name: 'gymcoach', version: '1.0.0', description: 'AI fitness coach' },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
      costControls: {
        maxMonthlyUSD: 200,
        alertAtUSD: 150,
      },
    },
    prompts: { system: 'You are a coach.', hotReload: false },
    tools: [
      {
        name: 'log-workout',
        type: 'function',
        description: 'Log a workout session',
        annotations: { destructiveHint: false },
      },
      {
        name: 'delete-workout',
        type: 'function',
        description: 'Permanently delete a workout session',
        annotations: { destructiveHint: true },
      },
    ],
    memory: {
      shortTerm: {
        backend: 'redis',
        ttlSeconds: 3600,
        connection: '$env:REDIS_URL',
      },
      hygiene: {
        piiScrubFields: ['name', 'email', 'date_of_birth'],
        auditLog: true,
      },
    },
    guardrails: {
      input: [
        { type: 'pii-detector', action: 'scrub', fields: ['date_of_birth'] },
        { type: 'topic-filter', blockedTopics: ['violence', 'self_harm'], action: 'reject' },
        { type: 'prompt-injection', action: 'reject', sensitivity: 'high' },
      ],
      output: [
        { type: 'toxicity-filter', threshold: 0.7, action: 'reject' },
        { type: 'hallucination-detector', threshold: 0.8, action: 'retry', maxRetries: 2 },
      ],
    },
  },
} as const

const minimalManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: { name: 'minimal-agent', version: '1.0.0', description: 'Minimal agent' },
  spec: {
    model: { provider: 'openai', id: 'gpt-4o', apiKey: 'literal-key' },
    prompts: { system: 'You are an assistant.', hotReload: false },
  },
} as const

// ── ExitError for process.exit spying ─────────────────────────────────────────

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitError'
  }
}

// ── generateRegoPolicy tests ───────────────────────────────────────────────────

describe('generateRegoPolicy', () => {
  it('generates Rego with correct package name derived from agent name', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('package agentspec.agent.gymcoach')
  })

  it('includes default allow := false and allow if count(deny) == 0', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('default allow := false')
    expect(rego).toContain('count(deny) == 0')
  })

  it('includes pii-detector input guardrail deny rule', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('pii_detector_not_invoked')
    expect(rego).toContain('guardrails_invoked')
    expect(rego).toContain('"pii-detector"')
  })

  it('includes topic-filter input guardrail deny rule', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('topic_filter_not_invoked')
    expect(rego).toContain('"topic-filter"')
  })

  it('includes prompt-injection input guardrail deny rule', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('prompt_injection_not_invoked')
    expect(rego).toContain('"prompt-injection"')
  })

  it('includes toxicity-filter output deny rule using data.toxicityThreshold', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('toxicity_threshold_exceeded')
    expect(rego).toContain('input.toxicity_score >= data.toxicityThreshold')
  })

  it('includes hallucination-detector output deny rule', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('hallucination_threshold_exceeded')
    expect(rego).toContain('input.hallucination_score >= data.hallucinationThreshold')
  })

  it('includes cost control deny rule when costControls declared', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('monthly_cost_limit_exceeded')
    expect(rego).toContain('data.maxMonthlyUSD')
  })

  it('includes memory TTL mismatch deny rule when ttlSeconds declared', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('memory_ttl_mismatch')
    expect(rego).toContain('data.shortTermTtlSeconds')
  })

  it('includes destructive tool confirmation deny rule', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('destructive_tool_without_confirmation')
    expect(rego).toContain('data.destructiveTools')
    expect(rego).toContain('input.user_confirmed')
  })

  it('does NOT include cost rules when no costControls declared', () => {
    const manifest = {
      ...fullManifest,
      spec: {
        ...fullManifest.spec,
        model: { ...fullManifest.spec.model, costControls: undefined },
      },
    }
    const rego = generateRegoPolicy(manifest as never)
    expect(rego).not.toContain('monthly_cost_limit_exceeded')
    expect(rego).not.toContain('maxMonthlyUSD')
  })

  it('does NOT include memory TTL rule when no ttlSeconds declared', () => {
    const manifest = {
      ...fullManifest,
      spec: {
        ...fullManifest.spec,
        memory: { shortTerm: { backend: 'redis' as const, connection: '$env:REDIS_URL' } },
      },
    }
    const rego = generateRegoPolicy(manifest as never)
    expect(rego).not.toContain('memory_ttl_mismatch')
    expect(rego).not.toContain('shortTermTtlSeconds')
  })

  it('does NOT include destructive tool rule when no destructive tools', () => {
    const manifest = {
      ...fullManifest,
      spec: {
        ...fullManifest.spec,
        tools: [
          {
            name: 'log-workout',
            type: 'function' as const,
            description: 'Log workout',
            annotations: { destructiveHint: false },
          },
        ],
      },
    }
    const rego = generateRegoPolicy(manifest as never)
    expect(rego).not.toContain('destructive_tool_without_confirmation')
    expect(rego).not.toContain('destructiveTools')
  })

  it('does NOT include guardrail rules when no guardrails declared', () => {
    const manifest = {
      ...fullManifest,
      spec: { ...fullManifest.spec, guardrails: undefined },
    }
    const rego = generateRegoPolicy(manifest as never)
    expect(rego).not.toContain('guardrails_invoked')
    expect(rego).not.toContain('toxicity_threshold_exceeded')
    expect(rego).not.toContain('hallucination_threshold_exceeded')
  })

  it('sanitizes hyphens in agent name to underscores for valid Rego package identifier', () => {
    const rego = generateRegoPolicy(minimalManifest as never)
    // "minimal-agent" → package agentspec.agent.minimal_agent (underscore, not hyphen)
    expect(rego).toContain('package agentspec.agent.minimal_agent')
    expect(rego).not.toContain('package agentspec.agent.minimal-agent')
  })

  it('generates valid minimal Rego with just package and allow rules for minimal manifest', () => {
    const rego = generateRegoPolicy(minimalManifest as never)
    expect(rego).toContain('package agentspec.agent.minimal_agent')
    expect(rego).toContain('default allow := false')
  })

  it('includes rego.v1 import for modern OPA compatibility', () => {
    const rego = generateRegoPolicy(fullManifest as never)
    expect(rego).toContain('import rego.v1')
  })
})

// ── generateDataJson tests ─────────────────────────────────────────────────────

describe('generateDataJson', () => {
  it('extracts toxicityThreshold from output guardrail', () => {
    const data = generateDataJson(fullManifest as never)
    expect(data.toxicityThreshold).toBe(0.7)
  })

  it('extracts hallucinationThreshold from output guardrail', () => {
    const data = generateDataJson(fullManifest as never)
    expect(data.hallucinationThreshold).toBe(0.8)
  })

  it('extracts shortTermTtlSeconds from memory', () => {
    const data = generateDataJson(fullManifest as never)
    expect(data.shortTermTtlSeconds).toBe(3600)
  })

  it('extracts maxMonthlyUSD from costControls', () => {
    const data = generateDataJson(fullManifest as never)
    expect(data.maxMonthlyUSD).toBe(200)
  })

  it('extracts alertAtUSD from costControls', () => {
    const data = generateDataJson(fullManifest as never)
    expect(data.alertAtUSD).toBe(150)
  })

  it('lists only tools with destructiveHint=true in destructiveTools', () => {
    const data = generateDataJson(fullManifest as never)
    expect(data.destructiveTools).toContain('delete-workout')
    expect(data.destructiveTools).not.toContain('log-workout')
  })

  it('extracts piiScrubFields from memory hygiene', () => {
    const data = generateDataJson(fullManifest as never)
    expect(data.piiScrubFields).toContain('name')
    expect(data.piiScrubFields).toContain('email')
  })

  it('extracts blockedTopics from topic-filter guardrail', () => {
    const data = generateDataJson(fullManifest as never)
    expect(data.blockedTopics).toContain('violence')
    expect(data.blockedTopics).toContain('self_harm')
  })

  it('omits shortTermTtlSeconds when memory has no ttlSeconds', () => {
    const manifest = {
      ...fullManifest,
      spec: {
        ...fullManifest.spec,
        memory: { shortTerm: { backend: 'redis' as const, connection: '$env:REDIS_URL' } },
      },
    }
    const data = generateDataJson(manifest as never)
    expect(data.shortTermTtlSeconds).toBeUndefined()
  })

  it('omits maxMonthlyUSD when costControls not declared', () => {
    const manifest = {
      ...fullManifest,
      spec: {
        ...fullManifest.spec,
        model: { ...fullManifest.spec.model, costControls: undefined },
      },
    }
    const data = generateDataJson(manifest as never)
    expect(data.maxMonthlyUSD).toBeUndefined()
  })

  it('returns empty destructiveTools array when no destructive tools', () => {
    const manifest = {
      ...fullManifest,
      spec: {
        ...fullManifest.spec,
        tools: [
          {
            name: 'log-workout',
            type: 'function' as const,
            description: 'Log workout',
            annotations: { destructiveHint: false },
          },
        ],
      },
    }
    const data = generateDataJson(manifest as never)
    expect(data.destructiveTools).toEqual([])
  })

  it('returns empty object for minimal manifest with no optional fields', () => {
    const data = generateDataJson(minimalManifest as never)
    expect(data.toxicityThreshold).toBeUndefined()
    expect(data.shortTermTtlSeconds).toBeUndefined()
    expect(data.maxMonthlyUSD).toBeUndefined()
    expect(data.destructiveTools).toEqual([])
  })
})

// ── registerGeneratePolicyCommand CLI tests ────────────────────────────────────

describe('registerGeneratePolicyCommand CLI', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      if ((code ?? 0) !== 0) throw new ExitError(code ?? 0)
    }) as unknown as typeof process.exit)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerGeneratePolicyCommand(program)
    await program.parseAsync(['node', 'cli', 'generate-policy', ...args])
  }

  function logOutput(): string {
    return logSpy.mock.calls.map((c) => String(c[0])).join('\n')
  }

  it('writes policy.rego to the specified --out directory', async () => {
    mockLoadManifest.mockReturnValue({ manifest: fullManifest, filePath: '/fake/agent.yaml' })
    await run(['/fake/agent.yaml', '--out', '/fake/policies/gymcoach'])
    expect(mockMkdirSync).toHaveBeenCalledWith('/fake/policies/gymcoach', { recursive: true })
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/fake/policies/gymcoach/policy.rego',
      expect.stringContaining('package agentspec.agent.gymcoach'),
      'utf-8',
    )
  })

  it('writes data.json to the specified --out directory', async () => {
    mockLoadManifest.mockReturnValue({ manifest: fullManifest, filePath: '/fake/agent.yaml' })
    await run(['/fake/agent.yaml', '--out', '/fake/policies/gymcoach'])
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/fake/policies/gymcoach/data.json',
      expect.stringContaining('"toxicityThreshold"'),
      'utf-8',
    )
  })

  it('defaults output dir to policies/<agent-name> when --out not given', async () => {
    mockLoadManifest.mockReturnValue({ manifest: fullManifest, filePath: '/fake/agent.yaml' })
    await run(['/fake/agent.yaml'])
    const mkdirCall = mockMkdirSync.mock.calls[0]?.[0] as string
    expect(mkdirCall).toMatch(/gymcoach/)
  })

  it('outputs JSON summary with --json flag', async () => {
    mockLoadManifest.mockReturnValue({ manifest: fullManifest, filePath: '/fake/agent.yaml' })
    await run(['/fake/agent.yaml', '--out', '/out', '--json'])
    const parsed = JSON.parse(logOutput())
    expect(parsed.agentName).toBe('gymcoach')
    expect(parsed.rulesGenerated).toBeGreaterThan(0)
    expect(parsed.outputDir).toBeDefined()
    expect(Array.isArray(parsed.files)).toBe(true)
    expect(parsed.files).toContain('policy.rego')
    expect(parsed.files).toContain('data.json')
  })

  it('prints human-readable summary in text mode', async () => {
    mockLoadManifest.mockReturnValue({ manifest: fullManifest, filePath: '/fake/agent.yaml' })
    await run(['/fake/agent.yaml', '--out', '/out'])
    const out = logOutput()
    expect(out).toContain('gymcoach')
    expect(out).toContain('policy.rego')
  })

  it('prints OPA usage hint in text mode', async () => {
    mockLoadManifest.mockReturnValue({ manifest: fullManifest, filePath: '/fake/agent.yaml' })
    await run(['/fake/agent.yaml', '--out', '/out'])
    expect(logOutput()).toContain('opa run')
  })

  it('exits 1 when manifest cannot be loaded', async () => {
    mockLoadManifest.mockImplementation(() => { throw new Error('File not found') })
    await expect(run(['/nonexistent/agent.yaml'])).rejects.toThrow('process.exit(1)')
  })

  it('exits 1 and logs error message on load failure', async () => {
    mockLoadManifest.mockImplementation(() => { throw new Error('ENOENT: no such file') })
    await expect(run(['/nonexistent/agent.yaml'])).rejects.toThrow()
    const errOut = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errOut).toContain('Cannot load manifest')
  })

  it('creates output directory recursively before writing files', async () => {
    mockLoadManifest.mockReturnValue({ manifest: fullManifest, filePath: '/fake/agent.yaml' })
    await run(['/fake/agent.yaml', '--out', '/deep/nested/dir'])
    expect(mockMkdirSync).toHaveBeenCalledWith('/deep/nested/dir', { recursive: true })
  })

  it('passes resolve:false to loadManifest (no I/O for refs)', async () => {
    mockLoadManifest.mockReturnValue({ manifest: fullManifest, filePath: '/fake/agent.yaml' })
    await run(['/fake/agent.yaml', '--out', '/out'])
    expect(mockLoadManifest).toHaveBeenCalledWith(
      '/fake/agent.yaml',
      expect.objectContaining({ resolve: false }),
    )
  })
})
