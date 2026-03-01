/**
 * Unit tests for the `generate` command's file-writing behaviour.
 *
 * Regression test for: generated files inside subdirectories (e.g.
 * `prompts/system_prompt.txt`) must be written successfully — the command
 * must create the parent directory before calling writeFileSync.
 *
 * Also tests: control plane files (manifest.py, tests/, eval datasets,
 * agent.yaml copy) are written when Claude returns them in the file set.
 *
 * Helper unit tests: writeGeneratedFiles and copyManifestToOutput are
 * exported for direct, Commander-free testing.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'

// Helpers under test (exported from generate.ts — importing here causes RED until exported)
import { writeGeneratedFiles, copyManifestToOutput } from '../commands/generate.js'

// k8s generator (mocked for --deploy k8s tests)
import { generateK8sManifests } from '../deploy/k8s.js'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../deploy/k8s.js', () => ({
  generateK8sManifests: vi.fn(() => ({
    'k8s/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\n',
    'k8s/service.yaml': 'apiVersion: v1\nkind: Service\n',
    'k8s/configmap.yaml': 'apiVersion: v1\nkind: ConfigMap\n',
    'k8s/secret.yaml.example': '# Example Secret\napiVersion: v1\nkind: Secret\n',
  })),
}))

vi.mock('@agentspec/adapter-claude', () => ({
  listFrameworks: vi.fn(() => ['langgraph', 'crewai', 'mastra']),
  generateWithClaude: vi.fn().mockResolvedValue({
    files: {
      'agent.py': '# agent',
      'tools.py': '# tools',
      'tool_implementations.py': '# impls',   // flat — no tools/ subdir
      'manifest.py': '# manifest loader',
      'server.py': '# server',
      'guardrails.py': '# guardrails',
      'tests/test_guardrails.py': '# unit tests',
      'tests/test_tools.py': '# tool tests',
      'tests/test_eval.py': '# pytest eval',
      'tests/eval/workout-qa.jsonl': '{"input":"..."}\n',
      'agent.yaml': '# manifest copy',
      'prompts/system_prompt.txt': 'You are a gym coach.',
      'prompts/tools/list.txt': 'push_up, squat, deadlift',
      'docker-compose.yml': 'services:\n  gymcoach:\n    build: .\n  agentspec-sidecar:\n    image: ghcr.io/agentspec/sidecar:latest\n',
      'agentspec-sidecar.env': 'UPSTREAM_URL=http://gymcoach:8000\nMANIFEST_PATH=/manifest/agent.yaml\n',
    },
    installCommands: [],
    envVars: [],
  }),
}))

vi.mock('@agentspec/sdk', () => ({
  loadManifest: vi.fn().mockReturnValue({ manifest: { name: 'test-agent' } }),
}))

// spinner() must not crash in a non-TTY test environment
vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runGenerate(outDir: string): Promise<void> {
  const { registerGenerateCommand } = await import('../commands/generate.js')
  const program = new Command()
  program.exitOverride() // throw instead of calling process.exit
  registerGenerateCommand(program)

  await program.parseAsync([
    'node', 'cli',
    'generate', 'fake-manifest.yaml',
    '--framework', 'langgraph',
    '--output', outDir,
  ])
}

async function runGenerateWithDeploy(outDir: string, target: string): Promise<void> {
  const { registerGenerateCommand } = await import('../commands/generate.js')
  const program = new Command()
  program.exitOverride()
  registerGenerateCommand(program)

  await program.parseAsync([
    'node', 'cli',
    'generate', 'fake-manifest.yaml',
    '--framework', 'langgraph',
    '--deploy', target,
    '--output', outDir,
  ])
}

// ── Tests: nested directory creation ─────────────────────────────────────────

describe('generate — nested directory creation', () => {
  let outDir: string
  // Track the spy so only it is restored — restoring other spies separately
  // avoids accidentally wiping vi.fn() implementations in vi.mock() factories.
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-gen-test-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('writes a top-level file', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'agent.py'))).toBe(true)
  })

  it('creates a missing subdirectory and writes the file inside it', async () => {
    await runGenerate(outDir)
    // This is the exact path that triggered the ENOENT crash before the fix
    expect(existsSync(join(outDir, 'prompts', 'system_prompt.txt'))).toBe(true)
  })

  it('creates deeply nested subdirectories', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'prompts', 'tools', 'list.txt'))).toBe(true)
  })

  it('writes correct content to subdirectory files', async () => {
    await runGenerate(outDir)
    const content = readFileSync(join(outDir, 'prompts', 'system_prompt.txt'), 'utf-8')
    expect(content).toBe('You are a gym coach.')
  })
})

// ── Tests: control plane files ────────────────────────────────────────────────

describe('generate — control plane files', () => {
  let outDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-ctrl-test-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('generates manifest.py control plane file', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'manifest.py'))).toBe(true)
  })

  it('generates flat tool_implementations.py (no tools/ subdir)', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'tool_implementations.py'))).toBe(true)
  })

  it('generates tests/ directory with guardrail unit tests', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'tests', 'test_guardrails.py'))).toBe(true)
  })

  it('generates tests/test_tools.py', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'tests', 'test_tools.py'))).toBe(true)
  })

  it('generates tests/test_eval.py (pytest-compatible eval harness)', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'tests', 'test_eval.py'))).toBe(true)
  })

  it('generates seed eval JSONL datasets under tests/eval/', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'tests', 'eval', 'workout-qa.jsonl'))).toBe(true)
  })

  it('seed JSONL dataset contains valid JSON lines', async () => {
    await runGenerate(outDir)
    const content = readFileSync(join(outDir, 'tests', 'eval', 'workout-qa.jsonl'), 'utf-8')
    const lines = content.split('\n').filter(l => l.trim())
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('copies agent.yaml to output dir', async () => {
    await runGenerate(outDir)
    // agent.yaml is part of the generated files returned by Claude
    expect(existsSync(join(outDir, 'agent.yaml'))).toBe(true)
  })

  it('agent.yaml in output dir has content', async () => {
    await runGenerate(outDir)
    const content = readFileSync(join(outDir, 'agent.yaml'), 'utf-8')
    expect(content.length).toBeGreaterThan(0)
  })

  it('docker-compose.yml is generated', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'docker-compose.yml'))).toBe(true)
  })

  it('docker-compose.yml references agentspec-sidecar image', async () => {
    await runGenerate(outDir)
    const content = readFileSync(join(outDir, 'docker-compose.yml'), 'utf-8')
    expect(content).toContain('agentspec-sidecar')
    expect(content).toContain('ghcr.io/agentspec/sidecar')
  })

  it('agentspec-sidecar.env is generated', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, 'agentspec-sidecar.env'))).toBe(true)
  })

  it('agentspec-sidecar.env contains UPSTREAM_URL', async () => {
    await runGenerate(outDir)
    const content = readFileSync(join(outDir, 'agentspec-sidecar.env'), 'utf-8')
    expect(content).toContain('UPSTREAM_URL=')
  })
})

// ── Tests: writeGeneratedFiles helper (unit) ──────────────────────────────────

describe('writeGeneratedFiles helper', () => {
  let outDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-wgf-test-'))
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
  })

  it('writes a flat file to outDir', () => {
    writeGeneratedFiles({ 'main.py': '# hello' }, outDir)
    expect(readFileSync(join(outDir, 'main.py'), 'utf-8')).toBe('# hello')
  })

  it('creates subdirectory and writes nested file', () => {
    writeGeneratedFiles({ 'tests/test_foo.py': '# test' }, outDir)
    expect(existsSync(join(outDir, 'tests', 'test_foo.py'))).toBe(true)
  })

  it('creates deeply nested subdirectory', () => {
    writeGeneratedFiles({ 'tests/eval/data.jsonl': '{}' }, outDir)
    expect(existsSync(join(outDir, 'tests', 'eval', 'data.jsonl'))).toBe(true)
  })

  it('writes correct content to a nested file', () => {
    writeGeneratedFiles({ 'prompts/system.txt': 'You are a coach.' }, outDir)
    expect(readFileSync(join(outDir, 'prompts', 'system.txt'), 'utf-8')).toBe('You are a coach.')
  })

  it('writes multiple files in one call', () => {
    writeGeneratedFiles({ 'a.py': '# a', 'b.py': '# b', 'sub/c.py': '# c' }, outDir)
    expect(existsSync(join(outDir, 'a.py'))).toBe(true)
    expect(existsSync(join(outDir, 'b.py'))).toBe(true)
    expect(existsSync(join(outDir, 'sub', 'c.py'))).toBe(true)
  })

  it('throws on path traversal attempt with ../..', () => {
    expect(() =>
      writeGeneratedFiles({ '../../etc/passwd': 'pwned' }, outDir)
    ).toThrow(/path traversal/i)
  })

  it('throws on absolute path filename', () => {
    expect(() =>
      writeGeneratedFiles({ '/tmp/evil.sh': 'rm -rf /' }, outDir)
    ).toThrow(/path traversal/i)
  })
})

// ── Tests: copyManifestToOutput helper (unit) ─────────────────────────────────

describe('copyManifestToOutput helper', () => {
  let srcDir: string
  let destDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'agentspec-cmo-src-'))
    destDir = mkdtempSync(join(tmpdir(), 'agentspec-cmo-dest-'))
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(srcDir, { recursive: true, force: true })
    rmSync(destDir, { recursive: true, force: true })
  })

  it('is a no-op when source file does not exist', () => {
    copyManifestToOutput('/no/such/file.yaml', destDir, {})
    expect(existsSync(join(destDir, 'file.yaml'))).toBe(false)
  })

  it('is a no-op when basename is already in generated files set', () => {
    const src = join(srcDir, 'agent.yaml')
    writeFileSync(src, 'name: test\n', 'utf-8')
    copyManifestToOutput(src, destDir, { 'agent.yaml': '# already written by Claude' })
    expect(existsSync(join(destDir, 'agent.yaml'))).toBe(false)
  })

  it('copies manifest to destDir when source exists and not in generated set', () => {
    const src = join(srcDir, 'agent.yaml')
    writeFileSync(src, 'name: test\n', 'utf-8')
    copyManifestToOutput(src, destDir, {})
    expect(existsSync(join(destDir, 'agent.yaml'))).toBe(true)
  })

  it('strips $secret: values from copied content', () => {
    const src = join(srcDir, 'agent.yaml')
    writeFileSync(src, 'apiKey: $secret:my-openai-key\nname: test\n', 'utf-8')
    copyManifestToOutput(src, destDir, {})
    const content = readFileSync(join(destDir, 'agent.yaml'), 'utf-8')
    expect(content).not.toContain('$secret:my-openai-key')
    expect(content).toContain('name: test')
  })

  it('replaces $secret: tokens with <redacted> placeholder', () => {
    const src = join(srcDir, 'agent.yaml')
    writeFileSync(src, 'apiKey: $secret:my-openai-key\nname: test\n', 'utf-8')
    copyManifestToOutput(src, destDir, {})
    const content = readFileSync(join(destDir, 'agent.yaml'), 'utf-8')
    expect(content).toContain('<redacted>')
    expect(content).toContain('apiKey: <redacted>')
  })

  it('strips all $secret: tokens in a multi-secret file', () => {
    const src = join(srcDir, 'agent.yaml')
    writeFileSync(
      src,
      'llmKey: $secret:groq-key\ndbPass: $secret:db-password\nname: myagent\n',
      'utf-8',
    )
    copyManifestToOutput(src, destDir, {})
    const content = readFileSync(join(destDir, 'agent.yaml'), 'utf-8')
    expect(content).not.toContain('$secret:groq-key')
    expect(content).not.toContain('$secret:db-password')
    expect(content).toContain('name: myagent')
  })

  it('preserves non-secret content exactly', () => {
    const src = join(srcDir, 'agent.yaml')
    const original = 'name: gymcoach\nversion: 1.0.0\nmodel: llama-3.3-70b\n'
    writeFileSync(src, original, 'utf-8')
    copyManifestToOutput(src, destDir, {})
    expect(readFileSync(join(destDir, 'agent.yaml'), 'utf-8')).toBe(original)
  })
})

// ── Tests: listFrameworks error handling ──────────────────────────────────────

describe('generate — listFrameworks error handling', () => {
  let outDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-lfe-test-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Prevent process.exit from actually terminating the test runner
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`)
    })
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    exitSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('prints user-friendly error message when listFrameworks throws', async () => {
    const { listFrameworks } = await import('@agentspec/adapter-claude')
    vi.mocked(listFrameworks).mockImplementationOnce(() => {
      throw new Error('ENOENT: no such file or directory, scandir \'/some/skills\'')
    })

    await expect(runGenerate(outDir)).rejects.toThrow()

    // printError writes to console.error — verify the helpful hint is present
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('@agentspec/adapter-claude'),
    )
  })

  it('calls process.exit(1) when listFrameworks throws', async () => {
    const { listFrameworks } = await import('@agentspec/adapter-claude')
    vi.mocked(listFrameworks).mockImplementationOnce(() => {
      throw new Error('ENOENT: skills directory missing')
    })

    await expect(runGenerate(outDir)).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ── Tests: --deploy k8s ────────────────────────────────────────────────────────

describe('generate --deploy k8s', () => {
  let outDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-deploy-k8s-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.clearAllMocks()
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('writes k8s/deployment.yaml when --deploy k8s is passed', async () => {
    await runGenerateWithDeploy(outDir, 'k8s')
    expect(existsSync(join(outDir, 'k8s', 'deployment.yaml'))).toBe(true)
  })

  it('writes k8s/service.yaml when --deploy k8s is passed', async () => {
    await runGenerateWithDeploy(outDir, 'k8s')
    expect(existsSync(join(outDir, 'k8s', 'service.yaml'))).toBe(true)
  })

  it('writes k8s/configmap.yaml when --deploy k8s is passed', async () => {
    await runGenerateWithDeploy(outDir, 'k8s')
    expect(existsSync(join(outDir, 'k8s', 'configmap.yaml'))).toBe(true)
  })

  it('writes k8s/secret.yaml.example when --deploy k8s is passed', async () => {
    await runGenerateWithDeploy(outDir, 'k8s')
    expect(existsSync(join(outDir, 'k8s', 'secret.yaml.example'))).toBe(true)
  })

  it('calls generateK8sManifests when --deploy k8s is passed', async () => {
    await runGenerateWithDeploy(outDir, 'k8s')
    expect(vi.mocked(generateK8sManifests)).toHaveBeenCalledOnce()
  })
})

// ── Tests: --dry-run with successful generation (line 225 coverage) ───────────

describe('generate --dry-run (LLM path)', () => {
  let outDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-dry-run-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.clearAllMocks()
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('prints file list without writing files when --dry-run is set', async () => {
    const { registerGenerateCommand } = await import('../commands/generate.js')
    const program = new Command()
    program.exitOverride()
    registerGenerateCommand(program)

    await program.parseAsync([
      'node', 'cli',
      'generate', 'fake-manifest.yaml',
      '--framework', 'langgraph',
      '--output', outDir,
      '--dry-run',
    ])

    // With --dry-run, generateWithClaude runs but writeGeneratedFiles is NOT called
    // outDir should contain NO written agent code files
    const { generateWithClaude } = await import('@agentspec/adapter-claude')
    expect(vi.mocked(generateWithClaude)).toHaveBeenCalledOnce()
    // Output dir should be empty (dry-run skips writing)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(outDir, 'agent.py'))).toBe(false)
  })

  it('dry-run prints each filename in output', async () => {
    const { registerGenerateCommand } = await import('../commands/generate.js')
    const program = new Command()
    program.exitOverride()
    registerGenerateCommand(program)

    await program.parseAsync([
      'node', 'cli',
      'generate', 'fake-manifest.yaml',
      '--framework', 'langgraph',
      '--output', outDir,
      '--dry-run',
    ])

    // printDryRunOutput logs each filename
    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('agent.py')
  })
})

// ── Tests: writeGeneratedFiles error catch (lines 234-236) ───────────────────

describe('generate — writeGeneratedFiles error catch', () => {
  let outDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-wgf-err-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`)
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    exitSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('calls process.exit(1) when generateWithClaude returns path traversal filename', async () => {
    // Return a path traversal filename that writeGeneratedFiles will reject
    const { generateWithClaude } = await import('@agentspec/adapter-claude')
    vi.mocked(generateWithClaude).mockResolvedValueOnce({
      files: { '../../evil.txt': 'malicious content' },
      installCommands: [],
      envVars: [],
    })

    const { registerGenerateCommand } = await import('../commands/generate.js')
    const program = new Command()
    program.exitOverride()
    registerGenerateCommand(program)

    await expect(
      program.parseAsync([
        'node', 'cli',
        'generate', 'fake-manifest.yaml',
        '--framework', 'langgraph',
        '--output', outDir,
      ]),
    ).rejects.toThrow('process.exit(1)')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('calls process.exit(1) when generateWithClaude itself throws (lines 212-215)', async () => {
    const { generateWithClaude } = await import('@agentspec/adapter-claude')
    vi.mocked(generateWithClaude).mockRejectedValueOnce(new Error('LLM API timeout'))

    const { registerGenerateCommand } = await import('../commands/generate.js')
    const program = new Command()
    program.exitOverride()
    registerGenerateCommand(program)

    await expect(
      program.parseAsync([
        'node', 'cli',
        'generate', 'fake-manifest.yaml',
        '--framework', 'langgraph',
        '--output', outDir,
      ]),
    ).rejects.toThrow('process.exit(1)')

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('LLM API timeout'),
    )
  })
})

// ── Tests: --push flag ────────────────────────────────────────────────────────

describe('generate --push flag', () => {
  let outDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-push-test-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.clearAllMocks()
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('--push flag writes .env.agentspec with AGENTSPEC_URL and AGENTSPEC_KEY', async () => {
    const { registerGenerateCommand } = await import('../commands/generate.js')
    const program = new Command()
    program.exitOverride()
    registerGenerateCommand(program)

    await program.parseAsync([
      'node', 'cli',
      'generate', 'fake-manifest.yaml',
      '--framework', 'langgraph',
      '--output', outDir,
      '--push',
    ])

    const envPath = join(outDir, '.env.agentspec')
    expect(existsSync(envPath)).toBe(true)
    const content = readFileSync(envPath, 'utf-8')
    expect(content).toContain('AGENTSPEC_URL=')
    expect(content).toContain('AGENTSPEC_KEY=')
  })

  it('--push flag .env.agentspec is not written without the flag', async () => {
    await runGenerate(outDir)
    expect(existsSync(join(outDir, '.env.agentspec'))).toBe(false)
  })
})

// ── Tests: --deploy helm (lines 244-245) ──────────────────────────────────────

describe('generate --deploy helm', () => {
  let outDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'agentspec-deploy-helm-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.clearAllMocks()
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(outDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('calls generateWithClaude twice when --deploy helm is set', async () => {
    const { generateWithClaude } = await import('@agentspec/adapter-claude')
    vi.mocked(generateWithClaude).mockResolvedValue({
      files: { 'agent.py': '# agent', 'agent.yaml': '# manifest' },
      installCommands: [],
      envVars: [],
    })

    await runGenerateWithDeploy(outDir, 'helm')

    // Called once for main langgraph generation, once for helm chart generation
    expect(vi.mocked(generateWithClaude)).toHaveBeenCalledTimes(2)
    // Second call should use 'helm' framework
    const calls = vi.mocked(generateWithClaude).mock.calls
    expect(calls[1][1]).toMatchObject({ framework: 'helm' })
  })
})
