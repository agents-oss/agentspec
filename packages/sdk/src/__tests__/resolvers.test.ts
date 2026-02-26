import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveRef, collectEnvRefs, collectFileRefs } from '../loader/resolvers.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `agentspec-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

// ── resolveRef tests ──────────────────────────────────────────────────────────

describe('resolveRef — $env:', () => {
  it('resolves an env var that is set', () => {
    process.env['AGENTSPEC_TEST_VAR'] = 'hello-world'
    const result = resolveRef('$env:AGENTSPEC_TEST_VAR', { baseDir: testDir })
    expect(result).toBe('hello-world')
    delete process.env['AGENTSPEC_TEST_VAR']
  })

  it('throws with clear message when env var is missing', () => {
    delete process.env['AGENTSPEC_MISSING_VAR']
    expect(() =>
      resolveRef('$env:AGENTSPEC_MISSING_VAR', { baseDir: testDir, failOnMissingEnv: true }),
    ).toThrow('Missing environment variable: AGENTSPEC_MISSING_VAR')
  })

  it('returns empty string for missing var when failOnMissingEnv=false', () => {
    delete process.env['AGENTSPEC_MISSING_VAR']
    const result = resolveRef('$env:AGENTSPEC_MISSING_VAR', {
      baseDir: testDir,
      failOnMissingEnv: false,
    })
    expect(result).toBe('')
  })
})

describe('resolveRef — $file:', () => {
  it('reads a file within baseDir', () => {
    const filePath = join(testDir, 'system.md')
    writeFileSync(filePath, 'You are a helpful assistant.')
    const result = resolveRef('$file:system.md', { baseDir: testDir })
    expect(result).toBe('You are a helpful assistant.')
  })

  it('reads a nested file within baseDir', () => {
    const subDir = join(testDir, 'prompts')
    mkdirSync(subDir)
    writeFileSync(join(subDir, 'system.md'), 'Nested content')
    const result = resolveRef('$file:prompts/system.md', { baseDir: testDir })
    expect(result).toBe('Nested content')
  })

  it('BLOCKS path traversal above baseDir', () => {
    expect(() =>
      resolveRef('$file:../../etc/passwd', { baseDir: testDir }),
    ).toThrow('Path traversal detected')
  })

  it('BLOCKS absolute path traversal', () => {
    expect(() =>
      resolveRef('$file:/etc/hosts', { baseDir: testDir }),
    ).toThrow('Path traversal detected')
  })

  it('returns empty string for missing file when optional=true', () => {
    const result = resolveRef('$file:nonexistent.md', { baseDir: testDir }, { optional: true })
    expect(result).toBe('')
  })

  it('throws for missing file when optional=false', () => {
    expect(() =>
      resolveRef('$file:nonexistent.md', { baseDir: testDir }),
    ).toThrow('Cannot read file referenced by')
  })
})

describe('resolveRef — $func:', () => {
  it('resolves now_iso to an ISO date string', () => {
    const result = resolveRef('$func:now_iso', { baseDir: testDir })
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('throws for unknown function', () => {
    expect(() =>
      resolveRef('$func:unknown_func', { baseDir: testDir }),
    ).toThrow('Unknown $func: unknown_func')
  })
})

describe('resolveRef — literal', () => {
  it('returns the literal string unchanged', () => {
    const result = resolveRef('hello world', { baseDir: testDir })
    expect(result).toBe('hello world')
  })
})

// ── collectEnvRefs tests ──────────────────────────────────────────────────────

describe('collectEnvRefs', () => {
  it('collects env var names from a nested object', () => {
    const obj = {
      apiKey: '$env:GROQ_API_KEY',
      nested: {
        conn: '$env:DATABASE_URL',
        literal: 'not-an-env',
      },
      arr: ['$env:REDIS_URL'],
    }
    const refs = collectEnvRefs(obj)
    expect(refs).toContain('GROQ_API_KEY')
    expect(refs).toContain('DATABASE_URL')
    expect(refs).toContain('REDIS_URL')
    expect(refs.size).toBe(3)
  })

  it('ignores non-env references', () => {
    const obj = { a: '$file:prompts/system.md', b: '$secret:my-key', c: 'literal' }
    const refs = collectEnvRefs(obj)
    expect(refs.size).toBe(0)
  })
})

// ── collectFileRefs tests ─────────────────────────────────────────────────────

describe('collectFileRefs', () => {
  it('collects file paths from a nested object', () => {
    const obj = {
      system: '$file:prompts/system.md',
      tools: [{ module: '$file:tools/expenses.py' }],
    }
    const refs = collectFileRefs(obj)
    expect(refs).toContain('prompts/system.md')
    expect(refs).toContain('tools/expenses.py')
    expect(refs.size).toBe(2)
  })
})
