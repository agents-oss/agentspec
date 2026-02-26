import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import { runEnvChecks, runFileChecks } from '../health/checks/env.check.js'
import { runMemoryChecks } from '../health/checks/memory.check.js'
import { runMcpChecks } from '../health/checks/mcp.check.js'
import { runHealthCheck } from '../health/index.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'health-test-agent',
    version: '1.0.0',
    description: 'Test agent for health checks',
  },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
    },
    prompts: {
      system: '$file:prompts/system.md',
      hotReload: false,
    },
  },
}

// ── runEnvChecks ──────────────────────────────────────────────────────────────

describe('runEnvChecks', () => {
  beforeEach(() => {
    delete process.env['GROQ_API_KEY']
    delete process.env['DATABASE_URL']
  })

  afterEach(() => {
    delete process.env['GROQ_API_KEY']
    delete process.env['DATABASE_URL']
  })

  it('passes when env var is set', () => {
    process.env['GROQ_API_KEY'] = 'gsk_test'
    const rawManifest = { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } }
    const checks = runEnvChecks(baseManifest, rawManifest)
    const check = checks.find((c) => c.id === 'env:GROQ_API_KEY')
    expect(check).toBeDefined()
    expect(check!.status).toBe('pass')
  })

  it('fails when env var is missing', () => {
    const rawManifest = { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } }
    const checks = runEnvChecks(baseManifest, rawManifest)
    const check = checks.find((c) => c.id === 'env:GROQ_API_KEY')
    expect(check).toBeDefined()
    expect(check!.status).toBe('fail')
    expect(check!.severity).toBe('error')
    expect(check!.message).toContain('GROQ_API_KEY')
    expect(check!.remediation).toContain('GROQ_API_KEY')
  })

  it('includes explicitly declared envVars from spec.requires', () => {
    process.env['DATABASE_URL'] = 'postgres://localhost:5432/db'
    const manifestWithRequires: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        requires: { envVars: ['DATABASE_URL'] },
      },
    }
    const checks = runEnvChecks(manifestWithRequires, {})
    const check = checks.find((c) => c.id === 'env:DATABASE_URL')
    expect(check).toBeDefined()
    expect(check!.status).toBe('pass')
  })

  it('fails for empty string env var', () => {
    process.env['GROQ_API_KEY'] = ''
    const rawManifest = { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } }
    const checks = runEnvChecks(baseManifest, rawManifest)
    const check = checks.find((c) => c.id === 'env:GROQ_API_KEY')
    expect(check!.status).toBe('fail')
  })
})

// ── runFileChecks ─────────────────────────────────────────────────────────────

describe('runFileChecks', () => {
  it('passes for existing file', () => {
    const rawManifest = { spec: { prompts: { system: '$file:package.json' } } }
    const checks = runFileChecks(rawManifest, process.cwd())
    const check = checks.find((c) => c.id === 'file:package.json')
    expect(check).toBeDefined()
    expect(check!.status).toBe('pass')
  })

  it('fails for missing file', () => {
    const rawManifest = { spec: { prompts: { system: '$file:nonexistent-file.md' } } }
    const checks = runFileChecks(rawManifest, '/tmp')
    const check = checks.find((c) => c.id === 'file:nonexistent-file.md')
    expect(check).toBeDefined()
    expect(check!.status).toBe('fail')
    expect(check!.severity).toBe('error')
    expect(check!.message).toContain('nonexistent-file.md')
  })

  it('returns empty array when no $file: refs', () => {
    const checks = runFileChecks({ spec: { model: { apiKey: '$env:GROQ_API_KEY' } } }, '/tmp')
    expect(checks).toHaveLength(0)
  })
})

// ── runMemoryChecks ───────────────────────────────────────────────────────────

describe('runMemoryChecks', () => {
  it('passes for in-memory backend', async () => {
    const checks = await runMemoryChecks({ shortTerm: { backend: 'in-memory' } })
    const check = checks.find((c) => c.id === 'memory.shortTerm:in-memory')
    expect(check).toBeDefined()
    expect(check!.status).toBe('pass')
  })

  it('skips when redis connection uses $env: (unresolved)', async () => {
    const checks = await runMemoryChecks({
      shortTerm: { backend: 'redis', connection: '$env:REDIS_URL' },
    })
    const check = checks.find((c) => c.id === 'memory.shortTerm:redis')
    expect(check).toBeDefined()
    expect(check!.status).toBe('skip')
    expect(check!.message).toContain('not resolved')
  })

  it('skips when postgres connection uses $env: (unresolved)', async () => {
    const checks = await runMemoryChecks({
      longTerm: { backend: 'postgres', connectionString: '$env:DATABASE_URL' },
    })
    const check = checks.find((c) => c.id === 'memory.longTerm:postgres')
    expect(check).toBeDefined()
    expect(check!.status).toBe('skip')
  })

  it('returns empty array when no memory configured', async () => {
    const checks = await runMemoryChecks({})
    expect(checks).toHaveLength(0)
  })
})

// ── runMcpChecks ──────────────────────────────────────────────────────────────

describe('runMcpChecks', () => {
  it('rejects command with shell metacharacters', async () => {
    const checks = await runMcpChecks([
      {
        name: 'unsafe-server',
        transport: 'stdio',
        command: 'node; rm -rf /',
      },
    ])
    const check = checks.find((c) => c.id === 'mcp:unsafe-server')
    expect(check).toBeDefined()
    expect(check!.status).toBe('fail')
    expect(check!.message).toContain('unsafe command name')
  })

  it('skips http server when URL is unresolved $env: ref', async () => {
    const checks = await runMcpChecks([
      {
        name: 'http-server',
        transport: 'http',
        url: '$env:MCP_URL',
      },
    ])
    const check = checks.find((c) => c.id === 'mcp:http-server')
    expect(check).toBeDefined()
    expect(check!.status).toBe('skip')
  })

  it('skips sse server when URL is unresolved $env: ref', async () => {
    const checks = await runMcpChecks([
      {
        name: 'sse-server',
        transport: 'sse',
        url: '$secret:mcp-url',
      },
    ])
    const check = checks.find((c) => c.id === 'mcp:sse-server')
    expect(check).toBeDefined()
    expect(check!.status).toBe('skip')
  })

  it('returns empty array when no servers', async () => {
    const checks = await runMcpChecks([])
    expect(checks).toHaveLength(0)
  })

  it('skips stdio server with no command', async () => {
    const checks = await runMcpChecks([
      { name: 'no-cmd', transport: 'stdio' },
    ])
    const check = checks.find((c) => c.id === 'mcp:no-cmd')
    expect(check).toBeDefined()
    expect(check!.status).toBe('skip')
  })
})

// ── runHealthCheck integration ────────────────────────────────────────────────

describe('runHealthCheck integration', () => {
  beforeEach(() => {
    process.env['GROQ_API_KEY'] = 'gsk_test'
    // Ensure we use env secret backend (no network calls)
    process.env['AGENTSPEC_SECRET_BACKEND'] = 'env'
  })

  afterEach(() => {
    delete process.env['GROQ_API_KEY']
    delete process.env['AGENTSPEC_SECRET_BACKEND']
  })

  it('returns a valid HealthReport structure', async () => {
    const report = await runHealthCheck(baseManifest, {
      checkModel: false,
      checkMcp: false,
      checkMemory: false,
      rawManifest: { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } },
    })

    expect(report.agentName).toBe('health-test-agent')
    expect(report.checks).toBeInstanceOf(Array)
    expect(report.timestamp).toBeTruthy()
    expect(['healthy', 'degraded', 'unhealthy']).toContain(report.status)
    expect(typeof report.summary.passed).toBe('number')
    expect(typeof report.summary.failed).toBe('number')
    expect(typeof report.summary.warnings).toBe('number')
    expect(typeof report.summary.skipped).toBe('number')
  })

  it('is healthy when required env var is set', async () => {
    const report = await runHealthCheck(baseManifest, {
      checkModel: false,
      checkMcp: false,
      checkMemory: false,
      rawManifest: { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } },
    })
    expect(report.status).toBe('healthy')
  })

  it('is unhealthy when required env var is missing', async () => {
    delete process.env['GROQ_API_KEY']
    const report = await runHealthCheck(baseManifest, {
      checkModel: false,
      checkMcp: false,
      checkMemory: false,
      rawManifest: { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } },
    })
    expect(report.status).toBe('unhealthy')
    expect(report.summary.failed).toBeGreaterThan(0)
  })

  it('summary counts are consistent', async () => {
    const report = await runHealthCheck(baseManifest, {
      checkModel: false,
      checkMcp: false,
      checkMemory: false,
      rawManifest: { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } },
    })
    const total =
      report.summary.passed +
      report.summary.failed +
      report.summary.warnings +
      report.summary.skipped
    expect(total).toBe(report.checks.length)
  })
})
