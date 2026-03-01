/**
 * Unit tests for `agentspec diff` command.
 *
 * Tests cover:
 *   - computeDiff(): structural diff with DIFF_SCORE_TABLE lookup
 *   - scoreToGrade(): grade letter from numeric score
 *   - CLI integration: --json output, --exit-code, no-drift exit 0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'

// Functions under test (RED until implemented)
import { computeDiff, scoreToGrade } from '../commands/diff.js'

// ── Mock @clack/prompts (no TTY in tests) ────────────────────────────────────

vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_MANIFEST = {
  agentspec: 'v1',
  metadata: { name: 'my-agent' },
  spec: {
    model: { provider: 'openai', name: 'gpt-4o', apiKey: '$env:OPENAI_API_KEY' },
    tools: [],
    guardrails: {
      content_filter: { enabled: true },
      rate_limit: { enabled: true },
    },
    eval: { hooks: ['deepeval'] },
  },
}

const manifestWithRemovedGuardrail = {
  ...BASE_MANIFEST,
  spec: {
    ...BASE_MANIFEST.spec,
    guardrails: {
      rate_limit: { enabled: true },
      // content_filter removed
    },
  },
}

const manifestWithAddedTool = {
  ...BASE_MANIFEST,
  spec: {
    ...BASE_MANIFEST.spec,
    tools: [{ name: 'fetch_prices', description: 'Fetch external prices' }],
  },
}

const manifestWithChangedModel = {
  ...BASE_MANIFEST,
  spec: {
    ...BASE_MANIFEST.spec,
    model: { ...BASE_MANIFEST.spec.model, name: 'gpt-3.5-turbo' },
  },
}

const manifestWithRemovedApiKey = {
  ...BASE_MANIFEST,
  spec: {
    ...BASE_MANIFEST.spec,
    model: { provider: 'openai', name: 'gpt-4o' }, // apiKey removed
  },
}

const manifestWithRemovedEvalHooks = {
  ...BASE_MANIFEST,
  spec: {
    ...BASE_MANIFEST.spec,
    eval: { hooks: [] },
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeYaml(dir: string, filename: string, content: string): string {
  const path = join(dir, filename)
  writeFileSync(path, content, 'utf-8')
  return path
}

async function runDiff(from: string, to: string, extraArgs: string[] = []): Promise<void> {
  const { registerDiffCommand } = await import('../commands/diff.js')
  const program = new Command()
  program.exitOverride()
  registerDiffCommand(program)
  await program.parseAsync(['node', 'cli', 'diff', from, to, ...extraArgs])
}

// ── Tests: scoreToGrade ───────────────────────────────────────────────────────

describe('scoreToGrade', () => {
  it('returns A for score 100', () => expect(scoreToGrade(100)).toBe('A'))
  it('returns A for score 90', () => expect(scoreToGrade(90)).toBe('A'))
  it('returns B for score 89', () => expect(scoreToGrade(89)).toBe('B'))
  it('returns B for score 75', () => expect(scoreToGrade(75)).toBe('B'))
  it('returns C for score 74', () => expect(scoreToGrade(74)).toBe('C'))
  it('returns C for score 60', () => expect(scoreToGrade(60)).toBe('C'))
  it('returns D for score 59', () => expect(scoreToGrade(59)).toBe('D'))
  it('returns D for score 45', () => expect(scoreToGrade(45)).toBe('D'))
  it('returns F for score 44', () => expect(scoreToGrade(44)).toBe('F'))
  it('returns F for score 0', () => expect(scoreToGrade(0)).toBe('F'))
})

// ── Tests: computeDiff ────────────────────────────────────────────────────────

describe('computeDiff', () => {
  it('returns empty array for identical manifests', () => {
    const changes = computeDiff(BASE_MANIFEST, BASE_MANIFEST)
    expect(changes).toHaveLength(0)
  })

  it('detects removed content_filter as HIGH severity with negative scoreImpact', () => {
    const changes = computeDiff(BASE_MANIFEST, manifestWithRemovedGuardrail)
    const found = changes.find(c =>
      c.property.includes('content_filter') && c.type === 'removed'
    )
    expect(found).toBeDefined()
    expect(found!.severity).toBe('HIGH')
    expect(found!.scoreImpact).toBeLessThan(0)
  })

  it('detects added tool as LOW severity with zero scoreImpact', () => {
    const changes = computeDiff(BASE_MANIFEST, manifestWithAddedTool)
    const found = changes.find(c => c.type === 'added')
    expect(found).toBeDefined()
    expect(found!.severity).toBe('LOW')
    expect(found!.scoreImpact).toBe(0)
  })

  it('detects model name change as MEDIUM severity with negative scoreImpact', () => {
    const changes = computeDiff(BASE_MANIFEST, manifestWithChangedModel)
    const found = changes.find(c =>
      c.property.includes('model') && c.property.includes('name')
    )
    expect(found).toBeDefined()
    expect(found!.severity).toBe('MEDIUM')
    expect(found!.scoreImpact).toBeLessThan(0)
  })

  it('detects removed apiKey as HIGH severity', () => {
    const changes = computeDiff(BASE_MANIFEST, manifestWithRemovedApiKey)
    const found = changes.find(c =>
      c.property.includes('apiKey') && c.type === 'removed'
    )
    expect(found).toBeDefined()
    expect(found!.severity).toBe('HIGH')
  })

  it('detects removed eval hooks as MEDIUM severity', () => {
    const changes = computeDiff(BASE_MANIFEST, manifestWithRemovedEvalHooks)
    const found = changes.find(c =>
      c.property.includes('eval') || c.property.includes('hooks')
    )
    expect(found).toBeDefined()
    expect(found!.severity).toBe('MEDIUM')
  })

  it('change objects have required shape: type, property, severity, scoreImpact, description', () => {
    const changes = computeDiff(BASE_MANIFEST, manifestWithRemovedGuardrail)
    expect(changes.length).toBeGreaterThan(0)
    for (const c of changes) {
      expect(c).toHaveProperty('type')
      expect(c).toHaveProperty('property')
      expect(c).toHaveProperty('severity')
      expect(c).toHaveProperty('scoreImpact')
      expect(c).toHaveProperty('description')
    }
  })
})

// ── Tests: CLI diff integration ───────────────────────────────────────────────

describe('diff — CLI integration', () => {
  let workDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agentspec-diff-cli-'))
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('prints "No compliance drift" for identical files', async () => {
    const yaml = 'agentspec: v1\nmetadata:\n  name: agent\n'
    const from = writeYaml(workDir, 'from.yaml', yaml)
    const to = writeYaml(workDir, 'to.yaml', yaml)

    await runDiff(from, to)

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output.toLowerCase()).toMatch(/no.*drift|no.*change/i)
  })

  it('prints change details when drift exists', async () => {
    const from = writeYaml(workDir, 'from.yaml', [
      'agentspec: v1',
      'spec:',
      '  guardrails:',
      '    content_filter:',
      '      enabled: true',
    ].join('\n'))
    const to = writeYaml(workDir, 'to.yaml', [
      'agentspec: v1',
      'spec:',
      '  guardrails: {}',
    ].join('\n'))

    await runDiff(from, to)

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toMatch(/content_filter|HIGH|REMOVED/i)
  })

  it('--json outputs valid JSON', async () => {
    const yaml = 'agentspec: v1\nmetadata:\n  name: agent\n'
    const from = writeYaml(workDir, 'from.yaml', yaml)
    const to = writeYaml(workDir, 'to.yaml', yaml)

    await runDiff(from, to, ['--json'])

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it('--json output has required fields: from, to, scoreFrom, scoreTo, netScoreChange, changes', async () => {
    const yaml = 'agentspec: v1\nmetadata:\n  name: agent\n'
    const from = writeYaml(workDir, 'from.yaml', yaml)
    const to = writeYaml(workDir, 'to.yaml', yaml)

    await runDiff(from, to, ['--json'])

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    const parsed = JSON.parse(output)
    expect(parsed).toHaveProperty('from')
    expect(parsed).toHaveProperty('to')
    expect(parsed).toHaveProperty('scoreFrom')
    expect(parsed).toHaveProperty('scoreTo')
    expect(parsed).toHaveProperty('netScoreChange')
    expect(parsed).toHaveProperty('changes')
    expect(Array.isArray(parsed.changes)).toBe(true)
  })

  it('--json netScoreChange is 0 for identical files', async () => {
    const yaml = 'agentspec: v1\nmetadata:\n  name: agent\n'
    const from = writeYaml(workDir, 'from.yaml', yaml)
    const to = writeYaml(workDir, 'to.yaml', yaml)

    await runDiff(from, to, ['--json'])

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    const parsed = JSON.parse(output)
    expect(parsed.netScoreChange).toBe(0)
  })

  it('--exit-code with no drift exits 0 (no thrown error)', async () => {
    const yaml = 'agentspec: v1\nmetadata:\n  name: agent\n'
    const from = writeYaml(workDir, 'from.yaml', yaml)
    const to = writeYaml(workDir, 'to.yaml', yaml)

    await expect(runDiff(from, to, ['--exit-code'])).resolves.not.toThrow()
  })

  it('--exit-code exits 1 when drift is detected', async () => {
    const from = writeYaml(workDir, 'from.yaml', [
      'agentspec: v1',
      'spec:',
      '  guardrails:',
      '    content_filter:',
      '      enabled: true',
    ].join('\n'))
    const to = writeYaml(workDir, 'to.yaml', [
      'agentspec: v1',
      'spec:',
      '  guardrails: {}',
    ].join('\n'))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`)
    })

    try {
      await expect(runDiff(from, to, ['--exit-code'])).rejects.toThrow('process.exit(1)')
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('prints net score change when drift exists', async () => {
    const from = writeYaml(workDir, 'from.yaml', [
      'agentspec: v1',
      'spec:',
      '  guardrails:',
      '    content_filter:',
      '      enabled: true',
    ].join('\n'))
    const to = writeYaml(workDir, 'to.yaml', [
      'agentspec: v1',
      'spec:',
      '  guardrails: {}',
    ].join('\n'))

    await runDiff(from, to)

    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toMatch(/score|grade/i)
  })
})
