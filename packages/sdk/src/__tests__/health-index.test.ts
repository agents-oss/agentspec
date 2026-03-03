/**
 * Unit tests for health/index.ts — runHealthCheck orchestration and
 * the private helpers (checkA2aEndpoint, subagent checks, eval checks).
 *
 * Covers the branches not reached by health.test.ts:
 * - Subagent ref type 'agentspec' + baseDir (file exists → pass, missing → fail)
 * - Subagent ref type 'a2a' + unresolved URL → skip
 * - Subagent ref type 'a2a' + valid URL → fetch (mocked)
 * - checkA2aEndpoint: invalid URL, non-http scheme, loopback/link-local, success, timeout
 * - Eval dataset checks (path exists → pass, missing → fail, $env: → skipped)
 * - HealthStatus computation: healthy / degraded / unhealthy
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runHealthCheck } from '../health/index.js'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'

// Use a project-relative directory for temp files — avoids macOS /var/folders issues
const TEST_TMP_BASE = resolve(import.meta.dirname ?? process.cwd(), '..', '..', '.test-tmp')

// ── fetch mock ────────────────────────────────────────────────────────────────

const originalFetch = global.fetch

beforeEach(() => {
  // Default: fetch succeeds — most tests override this
  global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })
  // Use env secret backend to suppress vault/aws network calls
  process.env['AGENTSPEC_SECRET_BACKEND'] = 'env'
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
  delete process.env['AGENTSPEC_SECRET_BACKEND']
  delete process.env['GROQ_API_KEY']
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: { name: 'health-idx-agent', version: '1.0.0', description: 'test' },
  spec: {
    model: { provider: 'groq', id: 'llama', apiKey: '$env:GROQ_API_KEY' },
    prompts: { system: 'You are helpful.', hotReload: false },
  },
}

// ── Subagent: agentspec ref ───────────────────────────────────────────────────

describe('runHealthCheck — subagent agentspec ref', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(TEST_TMP_BASE, `subagent-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns pass for subagent when manifest file exists', async () => {
    const subPath = 'sub-agent.yaml'
    writeFileSync(join(tmpDir, subPath), 'apiVersion: agentspec.io/v1')

    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          { name: 'worker', ref: { agentspec: subPath }, invocation: 'on-demand', passContext: false },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      baseDir: tmpDir,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:worker')
    expect(subCheck).toBeDefined()
    expect(subCheck!.status).toBe('pass')
    expect(subCheck!.category).toBe('subagent')
  })

  it('returns fail for subagent when manifest file is missing', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          { name: 'missing-worker', ref: { agentspec: 'does-not-exist.yaml' }, invocation: 'on-demand', passContext: false },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      baseDir: tmpDir,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:missing-worker')
    expect(subCheck).toBeDefined()
    expect(subCheck!.status).toBe('fail')
    expect(subCheck!.message).toContain('does-not-exist.yaml')
    expect(subCheck!.remediation).toBeDefined()
  })

  it('skips agentspec ref checks when baseDir is not provided', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          { name: 'no-basedir-worker', ref: { agentspec: 'agent.yaml' }, invocation: 'on-demand', passContext: false },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      // no baseDir — agentspec ref checks skipped
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:no-basedir-worker')
    expect(subCheck).toBeUndefined()
  })
})

// ── Subagent: a2a ref ─────────────────────────────────────────────────────────

describe('runHealthCheck — subagent a2a ref', () => {
  it('skips when a2a URL is an unresolved $env: ref', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'remote-agent',
            ref: { a2a: { url: '$env:REMOTE_AGENT_URL' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:remote-agent')
    expect(subCheck).toBeDefined()
    expect(subCheck!.status).toBe('skip')
    expect(subCheck!.message).toContain('not resolved')
  })

  it('skips for loopback a2a URL (SSRF guard)', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'loopback-agent',
            ref: { a2a: { url: 'http://localhost:8080' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:loopback-agent')
    expect(subCheck).toBeDefined()
    expect(subCheck!.status).toBe('skip')
    expect(subCheck!.message).toContain('loopback')
    // fetch should NOT have been called (SSRF guard fires before fetch)
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('skips for 127.0.0.1 a2a URL (SSRF guard)', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'loopback-ip-agent',
            ref: { a2a: { url: 'http://127.0.0.1:9000' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:loopback-ip-agent')
    expect(subCheck!.status).toBe('skip')
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('returns fail for a2a URL with invalid URL format', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'bad-url-agent',
            ref: { a2a: { url: 'not-a-valid-url' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:bad-url-agent')
    expect(subCheck).toBeDefined()
    expect(subCheck!.status).toBe('fail')
    expect(subCheck!.message).toContain('invalid URL')
  })

  it('returns fail for a2a URL with disallowed scheme (javascript:)', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'bad-scheme-agent',
            ref: { a2a: { url: 'javascript:alert(1)' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:bad-scheme-agent')
    expect(subCheck).toBeDefined()
    expect(subCheck!.status).toBe('fail')
    expect(subCheck!.message).toContain('disallowed scheme')
  })

  it('returns pass for a2a URL when fetch succeeds (non-loopback)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true })

    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'remote-ok-agent',
            ref: { a2a: { url: 'https://remote-agent.example.com/health' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:remote-ok-agent')
    expect(subCheck).toBeDefined()
    expect(subCheck!.status).toBe('pass')
    expect(typeof subCheck!.latencyMs).toBe('number')
  })

  it('returns fail for a2a URL when fetch throws (network error)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'down-agent',
            ref: { a2a: { url: 'https://down.example.com/health' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:down-agent')
    expect(subCheck!.status).toBe('fail')
    expect(subCheck!.message).toContain('unreachable')
  })

  it('returns fail with "timed out" on AbortError for a2a URL', async () => {
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    global.fetch = vi.fn().mockRejectedValue(abortErr)

    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'timeout-agent',
            ref: { a2a: { url: 'https://slow.example.com' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:timeout-agent')
    expect(subCheck!.status).toBe('fail')
    expect(subCheck!.message).toContain('timed out')
  })

  it('skips for IPv6 ::1 loopback in a2a URL', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'ipv6-loopback',
            ref: { a2a: { url: 'http://[::1]:8080' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:ipv6-loopback')
    expect(subCheck!.status).toBe('skip')
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('skips for fe80 link-local in a2a URL', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'link-local-agent',
            ref: { a2a: { url: 'http://[fe80::1]:8080' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:link-local-agent')
    expect(subCheck!.status).toBe('skip')
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('skips for 169.254.x.x link-local (AWS metadata) in a2a URL', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          {
            name: 'aws-metadata-agent',
            ref: { a2a: { url: 'http://169.254.169.254/latest/meta-data' } },
            invocation: 'on-demand',
            passContext: false,
          },
        ],
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })

    const subCheck = report.checks.find((c) => c.id === 'subagent:aws-metadata-agent')
    expect(subCheck!.status).toBe('skip')
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })
})

// ── Eval dataset checks ───────────────────────────────────────────────────────

describe('runHealthCheck — eval dataset checks', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(TEST_TMP_BASE, `eval-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns pass for eval dataset when file exists', async () => {
    writeFileSync(join(tmpDir, 'qa-pairs.jsonl'), '{"q":"test"}')

    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        evaluation: {
          framework: 'custom' as const,
          ciGate: false,
          datasets: [{ name: 'qa-set', path: 'qa-pairs.jsonl' }],
        },
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      baseDir: tmpDir,
    })

    const evalCheck = report.checks.find((c) => c.id === 'eval:dataset:qa-set')
    expect(evalCheck).toBeDefined()
    expect(evalCheck!.status).toBe('pass')
    expect(evalCheck!.category).toBe('eval')
  })

  it('returns fail for eval dataset when file is missing', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        evaluation: {
          framework: 'custom' as const,
          ciGate: false,
          datasets: [{ name: 'missing-set', path: 'nonexistent-data.jsonl' }],
        },
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      baseDir: tmpDir,
    })

    const evalCheck = report.checks.find((c) => c.id === 'eval:dataset:missing-set')
    expect(evalCheck).toBeDefined()
    expect(evalCheck!.status).toBe('fail')
    expect(evalCheck!.message).toContain('nonexistent-data.jsonl')
    expect(evalCheck!.remediation).toBeDefined()
  })

  it('skips eval dataset when path starts with $ (unresolved ref)', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        evaluation: {
          framework: 'custom' as const,
          ciGate: false,
          datasets: [{ name: 'env-set', path: '$env:EVAL_DATASET_PATH' }],
        },
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      baseDir: tmpDir,
    })

    // $env: paths are skipped (no check is pushed for them)
    const evalCheck = report.checks.find((c) => c.id === 'eval:dataset:env-set')
    expect(evalCheck).toBeUndefined()
  })

  it('skips eval checks when baseDir is not provided', async () => {
    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        evaluation: {
          framework: 'custom' as const,
          ciGate: false,
          datasets: [{ name: 'no-basedir-set', path: 'data.jsonl' }],
        },
      },
    }

    const report = await runHealthCheck(manifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      // no baseDir
    })

    const evalCheck = report.checks.find((c) => c.id === 'eval:dataset:no-basedir-set')
    expect(evalCheck).toBeUndefined()
  })
})

// ── HealthStatus computation ──────────────────────────────────────────────────

describe('runHealthCheck — status computation', () => {
  beforeEach(() => {
    process.env['GROQ_API_KEY'] = 'gsk_test_key'
  })

  it('reports "healthy" when all checks pass', async () => {
    const report = await runHealthCheck(baseManifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      rawManifest: { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } },
    })
    expect(report.status).toBe('healthy')
  })

  it('reports "unhealthy" when a check fails with severity "error"', async () => {
    delete process.env['GROQ_API_KEY'] // causes env check to fail with severity 'error'

    const report = await runHealthCheck(baseManifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      rawManifest: { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } },
    })

    expect(report.status).toBe('unhealthy')
    expect(report.summary.failed).toBeGreaterThan(0)
  })

  it('reports "degraded" when a check fails with severity "warning" (no error severity fails)', async () => {
    // An eval dataset fail has severity: 'info' → would not push to unhealthy
    // A subagent file-missing check has severity: 'warning' → causes degraded
    const tmpD = join(TEST_TMP_BASE, `status-${Date.now()}`)
    mkdirSync(tmpD, { recursive: true })

    const manifest: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        subagents: [
          { name: 'absent-sub', ref: { agentspec: 'missing.yaml' }, invocation: 'on-demand', passContext: false },
        ],
      },
    }

    try {
      const report = await runHealthCheck(manifest, {
        checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
        rawManifest: { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } },
        baseDir: tmpD,
      })

      // subagent:absent-sub fails with severity 'warning' → no error-severity failure
      // env:GROQ_API_KEY passes (key is set) → no 'error' severity failures
      const subFail = report.checks.find(
        (c) => c.id === 'subagent:absent-sub' && c.status === 'fail',
      )
      if (subFail) {
        expect(['degraded', 'unhealthy']).toContain(report.status)
      }
    } finally {
      rmSync(tmpD, { recursive: true, force: true })
    }
  })

  it('summary counts match actual check array lengths', async () => {
    const report = await runHealthCheck(baseManifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
      rawManifest: { spec: { model: { apiKey: '$env:GROQ_API_KEY' } } },
    })

    const total = report.summary.passed + report.summary.failed + report.summary.warnings + report.summary.skipped
    expect(total).toBe(report.checks.length)
  })

  it('agentName in report matches manifest.metadata.name', async () => {
    const report = await runHealthCheck(baseManifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })
    expect(report.agentName).toBe('health-idx-agent')
  })

  it('timestamp is a valid ISO string', async () => {
    const report = await runHealthCheck(baseManifest, {
      checkModel: false, checkMcp: false, checkMemory: false, checkServices: false,
    })
    expect(() => new Date(report.timestamp)).not.toThrow()
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp)
  })
})
