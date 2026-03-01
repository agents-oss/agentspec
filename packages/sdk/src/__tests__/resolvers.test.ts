import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveRef, resolveRefs, collectEnvRefs, collectFileRefs } from '../loader/resolvers.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

// Use a project-relative directory to avoid macOS /var/folders EINVAL issues
const TEST_TMP_BASE = resolve(import.meta.dirname ?? process.cwd(), '..', '..', '.test-tmp')
let testDir: string

beforeEach(() => {
  testDir = join(TEST_TMP_BASE, `resolvers-${Date.now()}`)
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
      tools: [{ module: '$file:tools/workouts.py' }],
    }
    const refs = collectFileRefs(obj)
    expect(refs).toContain('prompts/system.md')
    expect(refs).toContain('tools/workouts.py')
    expect(refs.size).toBe(2)
  })
})

// ── resolveRef — $secret: tests ───────────────────────────────────────────────

describe('resolveRef — $secret: (env backend)', () => {
  afterEach(() => {
    delete process.env['AGENTSPEC_SECRET_MY_KEY']
    delete process.env['AGENTSPEC_SECRET_DB_PASSWORD']
  })

  it('resolves $secret:my-key from env var AGENTSPEC_SECRET_MY_KEY', () => {
    process.env['AGENTSPEC_SECRET_MY_KEY'] = 'super-secret-value'
    const result = resolveRef('$secret:my-key', { baseDir: testDir, secretBackend: 'env' })
    expect(result).toBe('super-secret-value')
  })

  it('converts hyphens to underscores in env key name', () => {
    process.env['AGENTSPEC_SECRET_DB_PASSWORD'] = 'db-pass-123'
    const result = resolveRef('$secret:db-password', { baseDir: testDir, secretBackend: 'env' })
    expect(result).toBe('db-pass-123')
  })

  it('throws when secret env var is not set (env backend)', () => {
    delete process.env['AGENTSPEC_SECRET_MISSING']
    expect(() =>
      resolveRef('$secret:missing', { baseDir: testDir, secretBackend: 'env' }),
    ).toThrow('"missing" not found')
  })

  it('uses AGENTSPEC_SECRET_BACKEND env var as default backend', () => {
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'env'
    process.env['AGENTSPEC_SECRET_MY_KEY'] = 'from-env-backend'

    const result = resolveRef('$secret:my-key', { baseDir: testDir })
    expect(result).toBe('from-env-backend')

    delete process.env['AGENTSPEC_SECRET_BACKEND']
    delete process.env['AGENTSPEC_SECRET_MY_KEY']
  })
})

describe('resolveRef — $secret: (non-env backends)', () => {
  it('throws for vault backend with "requires async resolution" message', () => {
    expect(() =>
      resolveRef('$secret:my-key', { baseDir: testDir, secretBackend: 'vault' }),
    ).toThrow('requires async resolution')
  })

  it('throws for aws backend', () => {
    expect(() =>
      resolveRef('$secret:my-key', { baseDir: testDir, secretBackend: 'aws' }),
    ).toThrow('requires async resolution')
  })

  it('throws for gcp backend', () => {
    expect(() =>
      resolveRef('$secret:my-key', { baseDir: testDir, secretBackend: 'gcp' }),
    ).toThrow('requires async resolution')
  })

  it('throws for azure backend', () => {
    expect(() =>
      resolveRef('$secret:my-key', { baseDir: testDir, secretBackend: 'azure' }),
    ).toThrow('requires async resolution')
  })
})

// ── resolveRefs (deep walk) ───────────────────────────────────────────────────

describe('resolveRefs — deep object walking', () => {
  afterEach(() => {
    delete process.env['TEST_API_KEY']
    delete process.env['TEST_DB_URL']
  })

  it('resolves $env: refs in a plain object', () => {
    process.env['TEST_API_KEY'] = 'resolved-key'
    const obj = { apiKey: '$env:TEST_API_KEY', name: 'my-agent' }
    const result = resolveRefs(obj, { baseDir: testDir }) as typeof obj
    expect(result.apiKey).toBe('resolved-key')
    expect(result.name).toBe('my-agent')
  })

  it('resolves $env: refs in nested objects', () => {
    process.env['TEST_DB_URL'] = 'postgres://db.example.com/mydb'
    const obj = { spec: { memory: { longTerm: { connectionString: '$env:TEST_DB_URL' } } } }
    const result = resolveRefs(obj, { baseDir: testDir }) as typeof obj
    expect(result.spec.memory.longTerm.connectionString).toBe('postgres://db.example.com/mydb')
  })

  it('resolves $env: refs inside arrays', () => {
    process.env['TEST_API_KEY'] = 'array-key'
    const obj = ['$env:TEST_API_KEY', 'literal-value']
    const result = resolveRefs(obj, { baseDir: testDir }) as string[]
    expect(result[0]).toBe('array-key')
    expect(result[1]).toBe('literal-value')
  })

  it('passes through non-string, non-object values unchanged', () => {
    const obj = { count: 42, flag: true, nothing: null }
    const result = resolveRefs(obj, { baseDir: testDir }) as typeof obj
    expect(result.count).toBe(42)
    expect(result.flag).toBe(true)
    expect(result.nothing).toBeNull()
  })

  it('returns string values directly (leaf resolveRef)', () => {
    process.env['TEST_API_KEY'] = 'direct-key'
    const result = resolveRefs('$env:TEST_API_KEY', { baseDir: testDir })
    expect(result).toBe('direct-key')
  })

  it('returns empty string for unresolved $env: when optional mode (resolveRefs uses optional=true)', () => {
    delete process.env['UNSET_VAR_XYZ']
    // resolveRefs calls resolveRef with { optional: true }, so missing vars → ''
    const result = resolveRefs('$env:UNSET_VAR_XYZ', { baseDir: testDir })
    expect(result).toBe('')
  })

  it('resolves $file: refs within objects', () => {
    writeFileSync(join(testDir, 'prompt.md'), 'System prompt content')
    const obj = { prompts: { system: '$file:prompt.md' } }
    const result = resolveRefs(obj, { baseDir: testDir }) as typeof obj
    expect(result.prompts.system).toBe('System prompt content')
  })
})

// ── resolveRef — $func: additional ───────────────────────────────────────────

describe('resolveRef — $func: now_unix and now_date', () => {
  it('resolves now_unix to a Unix timestamp string', () => {
    const result = resolveRef('$func:now_unix', { baseDir: testDir })
    const ts = parseInt(result, 10)
    expect(Number.isInteger(ts)).toBe(true)
    // Should be within a few seconds of now
    expect(Math.abs(ts - Math.floor(Date.now() / 1000))).toBeLessThan(5)
  })

  it('resolves now_date to a YYYY-MM-DD string', () => {
    const result = resolveRef('$func:now_date', { baseDir: testDir })
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
