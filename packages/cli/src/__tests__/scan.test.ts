/**
 * Unit tests for `agentspec scan` command.
 *
 * Tests cover:
 *   - collectSourceFiles(): file collection, size cap, file count cap, path traversal
 *   - resolveOutputPath(): output path logic (new / existing / --update / --out)
 *   - CLI integration: generateWithClaude called with 'scan' skill, --dry-run, --update
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'

// Functions under test (exported from scan.ts — RED until implemented)
import { collectSourceFiles, resolveOutputPath } from '../commands/scan.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@agentspec/adapter-claude', () => ({
  generateWithClaude: vi.fn().mockResolvedValue({
    files: {
      'agent.yaml': [
        'agentspec: v1',
        'metadata:',
        '  name: my-agent',
        'spec:',
        '  model:',
        '    provider: openai',
        '    name: gpt-4o',
      ].join('\n'),
    },
    installCommands: [],
    envVars: [],
  }),
  listFrameworks: vi.fn(() => ['langgraph', 'crewai', 'mastra']),
}))

vi.mock('@agentspec/sdk', () => ({
  loadManifest: vi.fn().mockReturnValue({ manifest: { name: 'test-agent' } }),
}))

vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runScan(
  srcDir: string,
  extraArgs: string[] = [],
): Promise<void> {
  const { registerScanCommand } = await import('../commands/scan.js')
  const program = new Command()
  program.exitOverride()
  registerScanCommand(program)

  await program.parseAsync([
    'node', 'cli',
    'scan',
    '--dir', srcDir,
    ...extraArgs,
  ])
}

// ── Tests: collectSourceFiles ─────────────────────────────────────────────────

describe('collectSourceFiles', () => {
  let srcDir: string

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'agentspec-scan-src-'))
  })

  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true })
  })

  it('collects .py files', () => {
    writeFileSync(join(srcDir, 'agent.py'), '# agent code')
    const files = collectSourceFiles(srcDir)
    expect(files.some(f => f.path.endsWith('agent.py'))).toBe(true)
  })

  it('collects .ts files', () => {
    writeFileSync(join(srcDir, 'agent.ts'), '// agent code')
    const files = collectSourceFiles(srcDir)
    expect(files.some(f => f.path.endsWith('agent.ts'))).toBe(true)
  })

  it('collects .js files', () => {
    writeFileSync(join(srcDir, 'agent.js'), '// agent code')
    const files = collectSourceFiles(srcDir)
    expect(files.some(f => f.path.endsWith('agent.js'))).toBe(true)
  })

  it('ignores non-source files like .txt and .yaml', () => {
    writeFileSync(join(srcDir, 'readme.txt'), 'docs')
    writeFileSync(join(srcDir, 'agent.yaml'), 'name: agent')
    const files = collectSourceFiles(srcDir)
    expect(files.some(f => f.path.endsWith('readme.txt'))).toBe(false)
    expect(files.some(f => f.path.endsWith('agent.yaml'))).toBe(false)
  })

  it('collects files recursively from subdirectories', () => {
    mkdirSync(join(srcDir, 'tools'))
    writeFileSync(join(srcDir, 'tools', 'search.py'), '# search tool')
    const files = collectSourceFiles(srcDir)
    expect(files.some(f => f.path.includes('search.py'))).toBe(true)
  })

  it('caps at 50 files by default', () => {
    for (let i = 0; i < 55; i++) {
      writeFileSync(join(srcDir, `file${i}.py`), `# file ${i}`)
    }
    const files = collectSourceFiles(srcDir)
    expect(files.length).toBeLessThanOrEqual(50)
  })

  it('caps at 200 KB total content', () => {
    // Write 3 files of 100KB each = 300KB total
    const bigContent = 'x'.repeat(100 * 1024)
    writeFileSync(join(srcDir, 'big1.py'), bigContent)
    writeFileSync(join(srcDir, 'big2.py'), bigContent)
    writeFileSync(join(srcDir, 'big3.py'), bigContent)
    const files = collectSourceFiles(srcDir)
    const totalBytes = files.reduce((sum, f) => sum + f.content.length, 0)
    expect(totalBytes).toBeLessThanOrEqual(200 * 1024)
  })

  it('returns SourceFile objects with path and content', () => {
    writeFileSync(join(srcDir, 'hello.py'), 'print("hello")')
    const files = collectSourceFiles(srcDir)
    expect(files[0]).toHaveProperty('path')
    expect(files[0]).toHaveProperty('content')
    expect(files[0].content).toBe('print("hello")')
  })

  it('returns empty array for empty directory', () => {
    const files = collectSourceFiles(srcDir)
    expect(files).toEqual([])
  })

  it('does not follow symlinks pointing outside srcDir (C1 security)', () => {
    // Create a secret file OUTSIDE srcDir
    const outsideDir = mkdtempSync(join(tmpdir(), 'agentspec-scan-outside-'))
    writeFileSync(join(outsideDir, 'secret.py'), 'SECRET_KEY = "leaked-value"')

    // Place a symlink inside srcDir pointing to the outside directory
    symlinkSync(outsideDir, join(srcDir, 'link-to-outside'))

    try {
      const files = collectSourceFiles(srcDir)
      const leaked = files.find(f => f.content.includes('leaked-value'))
      expect(leaked).toBeUndefined()
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('does not follow file symlinks pointing outside srcDir', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'agentspec-scan-filesym-'))
    writeFileSync(join(outsideDir, 'passwd'), 'root:x:0:0:root:/root:/bin/bash')

    // Symlink that looks like a .py file but points outside
    symlinkSync(join(outsideDir, 'passwd'), join(srcDir, 'evil.py'))

    try {
      const files = collectSourceFiles(srcDir)
      const leaked = files.find(f => f.content.includes('root:x:0:0'))
      expect(leaked).toBeUndefined()
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('excludes node_modules directory (C3)', () => {
    mkdirSync(join(srcDir, 'node_modules', 'some-dep'), { recursive: true })
    writeFileSync(join(srcDir, 'node_modules', 'some-dep', 'index.js'), '// dep code')
    writeFileSync(join(srcDir, 'agent.py'), '# agent')

    const files = collectSourceFiles(srcDir)
    expect(files.some(f => f.path.includes('node_modules'))).toBe(false)
    expect(files.some(f => f.path.endsWith('agent.py'))).toBe(true)
  })

  it('excludes .git directory (C3)', () => {
    mkdirSync(join(srcDir, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(srcDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh')
    writeFileSync(join(srcDir, 'main.ts'), 'export {}')

    const files = collectSourceFiles(srcDir)
    expect(files.some(f => f.path.includes('.git'))).toBe(false)
  })
})

// ── Tests: resolveOutputPath ──────────────────────────────────────────────────

describe('resolveOutputPath', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agentspec-scan-out-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('returns agent.yaml when no existing file', () => {
    const outPath = resolveOutputPath({ srcDir: workDir })
    expect(outPath).toBe(join(workDir, 'agent.yaml'))
  })

  it('returns agent.yaml.new when agent.yaml exists and --update not set', () => {
    writeFileSync(join(workDir, 'agent.yaml'), 'name: existing')
    const outPath = resolveOutputPath({ srcDir: workDir })
    expect(outPath).toBe(join(workDir, 'agent.yaml.new'))
  })

  it('returns agent.yaml when agent.yaml exists and --update is set', () => {
    writeFileSync(join(workDir, 'agent.yaml'), 'name: existing')
    const outPath = resolveOutputPath({ srcDir: workDir, update: true })
    expect(outPath).toBe(join(workDir, 'agent.yaml'))
  })

  it('returns explicit --out path when provided', () => {
    const outPath = resolveOutputPath({ srcDir: workDir, out: '/some/custom/path.yaml' })
    expect(outPath).toBe('/some/custom/path.yaml')
  })

  it('dry-run always resolves a path (caller decides not to write)', () => {
    // resolveOutputPath is path-only; --dry-run logic lives in the command handler
    const outPath = resolveOutputPath({ srcDir: workDir, dryRun: true })
    expect(typeof outPath).toBe('string')
    expect(outPath.length).toBeGreaterThan(0)
  })
})

// ── Tests: CLI integration ────────────────────────────────────────────────────

describe('scan — CLI integration', () => {
  let srcDir: string
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'agentspec-scan-cli-'))
    writeFileSync(join(srcDir, 'agent.py'), 'import openai\napi_key = os.getenv("OPENAI_API_KEY")')
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    rmSync(srcDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('calls generateWithClaude with skill "scan"', async () => {
    const { generateWithClaude } = await import('@agentspec/adapter-claude')
    vi.mocked(generateWithClaude).mockClear()

    await runScan(srcDir)

    expect(vi.mocked(generateWithClaude)).toHaveBeenCalledOnce()
    const [, opts] = vi.mocked(generateWithClaude).mock.calls[0]
    expect(opts).toMatchObject({ framework: 'scan' })
  })

  it('writes agent.yaml when no existing file', async () => {
    await runScan(srcDir)
    expect(existsSync(join(srcDir, 'agent.yaml'))).toBe(true)
  })

  it('writes agent.yaml.new when agent.yaml already exists (no --update)', async () => {
    writeFileSync(join(srcDir, 'agent.yaml'), 'name: existing')
    await runScan(srcDir)
    expect(existsSync(join(srcDir, 'agent.yaml.new'))).toBe(true)
    // original must NOT be overwritten
    expect(readFileSync(join(srcDir, 'agent.yaml'), 'utf-8')).toBe('name: existing')
  })

  it('overwrites agent.yaml when --update flag is set', async () => {
    writeFileSync(join(srcDir, 'agent.yaml'), 'name: old')
    await runScan(srcDir, ['--update'])
    const content = readFileSync(join(srcDir, 'agent.yaml'), 'utf-8')
    expect(content).toContain('agentspec: v1')
  })

  it('--dry-run prints to stdout and does not write a file', async () => {
    await runScan(srcDir, ['--dry-run'])
    // No agent.yaml created
    expect(existsSync(join(srcDir, 'agent.yaml'))).toBe(false)
    // Something was printed
    expect(consoleLogSpy).toHaveBeenCalled()
  })

  it('printed dry-run output contains agent.yaml content', async () => {
    await runScan(srcDir, ['--dry-run'])
    const output = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('agentspec')
  })

  it('ANTHROPIC_API_KEY missing → exits 1', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number): never => {
      throw new Error(`process.exit(${_code})`)
    }) as unknown as typeof process.exit)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(runScan(srcDir)).rejects.toThrow('process.exit(1)')
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})

// ── Tests: file count cap warning ─────────────────────────────────────────────

describe('scan — file count cap warning', () => {
  let srcDir: string
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'agentspec-scan-cap-'))
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    rmSync(srcDir, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('warns when source dir contains >50 files and truncates to 50', async () => {
    for (let i = 0; i < 55; i++) {
      writeFileSync(join(srcDir, `file${i}.py`), `# ${i}`)
    }
    await runScan(srcDir)
    const warnOutput = consoleWarnSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(warnOutput).toMatch(/truncat|cap|limit|50/i)
  })
})
