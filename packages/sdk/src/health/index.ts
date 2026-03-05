import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import { runEnvChecks, runFileChecks } from './checks/env.check.js'
import { runModelChecks } from './checks/model.check.js'
import { runMcpChecks } from './checks/mcp.check.js'
import { runMemoryChecks } from './checks/memory.check.js'
import { runSecretChecks } from './checks/secret.check.js'
import { runServiceChecks } from './checks/service.check.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip'
export type CheckSeverity = 'error' | 'warning' | 'info'

export interface HealthCheck {
  id: string
  category:
    | 'env'
    | 'file'
    | 'model'
    | 'model-fallback'
    | 'mcp'
    | 'memory'
    | 'subagent'
    | 'eval'
    | 'service'   // spec.requires.services TCP connectivity
    | 'tool'      // registered tool handler availability (agent-side)
  status: CheckStatus
  severity: CheckSeverity
  latencyMs?: number
  message?: string
  remediation?: string
}

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface HealthReport {
  agentName: string
  timestamp: string
  status: HealthStatus
  summary: {
    passed: number
    failed: number
    warnings: number
    skipped: number
  }
  checks: HealthCheck[]
}

export interface HealthCheckOptions {
  /** Run model API reachability checks (makes HTTP requests). Default: true */
  checkModel?: boolean
  /** Run MCP server checks. Default: true */
  checkMcp?: boolean
  /** Run memory backend checks. Default: true */
  checkMemory?: boolean
  /** Run spec.requires.services TCP connectivity checks. Default: true */
  checkServices?: boolean
  /** Override base directory for $file resolution */
  baseDir?: string
  /** Raw parsed YAML object (for $env/$file ref collection) */
  rawManifest?: unknown
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function runSubagentChecks(
  manifest: AgentSpecManifest,
  opts: Pick<HealthCheckOptions, 'baseDir'>,
): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = []
  if (!manifest.spec.subagents) return checks

  for (const sub of manifest.spec.subagents) {
    const ref = sub.ref
    if ('agentspec' in ref && opts.baseDir) {
      const subPath = resolve(opts.baseDir, ref.agentspec)
      const exists = existsSync(subPath)
      checks.push({
        id: `subagent:${sub.name}`,
        category: 'subagent',
        status: exists ? 'pass' : 'fail',
        severity: 'warning',
        message: exists
          ? undefined
          : `Sub-agent manifest not found: ${ref.agentspec}`,
        remediation: exists
          ? undefined
          : `Create the sub-agent manifest at ${subPath}`,
      })
    } else if ('a2a' in ref) {
      const rawUrl = ref.a2a.url
      if (!rawUrl.startsWith('$')) {
        const check = await checkA2aEndpoint(sub.name, rawUrl)
        checks.push(check)
      } else {
        checks.push({
          id: `subagent:${sub.name}`,
          category: 'subagent',
          status: 'skip',
          severity: 'warning',
          message: `Cannot check A2A endpoint: URL not resolved (${rawUrl})`,
        })
      }
    }
  }
  return checks
}

function runEvalChecks(
  manifest: AgentSpecManifest,
  opts: Pick<HealthCheckOptions, 'baseDir'>,
): HealthCheck[] {
  const checks: HealthCheck[] = []
  if (!manifest.spec.evaluation?.datasets || !opts.baseDir) return checks

  for (const dataset of manifest.spec.evaluation.datasets) {
    const path = dataset.path
    if (!path.startsWith('$')) {
      const absPath = resolve(opts.baseDir, path)
      const exists = existsSync(absPath)
      checks.push({
        id: `eval:dataset:${dataset.name}`,
        category: 'eval',
        status: exists ? 'pass' : 'fail',
        severity: 'info',
        message: exists
          ? undefined
          : `Eval dataset not found: ${path}`,
        remediation: exists
          ? undefined
          : `Create the dataset file at ${absPath}`,
      })
    }
  }
  return checks
}

function computeHealthStatus(checks: HealthCheck[]): {
  status: HealthStatus
  summary: { passed: number; failed: number; warnings: number; skipped: number }
} {
  const failed   = checks.filter((c) => c.status === 'fail')
  const warnings = checks.filter((c) => c.status === 'warn')
  const passed   = checks.filter((c) => c.status === 'pass')
  const skipped  = checks.filter((c) => c.status === 'skip')

  const hasErrors   = failed.some((c) => c.severity === 'error')
  const hasWarnings = failed.some((c) => c.severity === 'warning') || warnings.length > 0

  const status: HealthStatus = hasErrors ? 'unhealthy' : hasWarnings ? 'degraded' : 'healthy'

  return {
    status,
    summary: {
      passed:   passed.length,
      failed:   failed.length,
      warnings: warnings.length,
      skipped:  skipped.length,
    },
  }
}

// ── Main health check runner ──────────────────────────────────────────────────

export async function runHealthCheck(
  manifest: AgentSpecManifest,
  opts: HealthCheckOptions = {},
): Promise<HealthReport> {
  const checks: HealthCheck[] = []

  // Build raw manifest for ref collection (when not provided)
  const rawManifest = opts.rawManifest ?? manifest

  // 1. Env var checks
  checks.push(...runEnvChecks(manifest, rawManifest))

  // 1b. Secret backend reachability
  checks.push(...await runSecretChecks())

  // 2. File reference checks
  if (opts.baseDir) {
    checks.push(...runFileChecks(rawManifest, opts.baseDir))
  }

  // 3. Model endpoint checks
  if (opts.checkModel !== false && manifest.spec.model) {
    checks.push(...await runModelChecks(manifest.spec.model))
  }

  // 4. MCP server checks
  if (opts.checkMcp !== false && manifest.spec.mcp?.servers?.length) {
    checks.push(...await runMcpChecks(manifest.spec.mcp.servers))
  }

  // 5. Memory backend checks
  if (opts.checkMemory !== false && manifest.spec.memory) {
    checks.push(...await runMemoryChecks(manifest.spec.memory))
  }

  // 6. Service connectivity checks (spec.requires.services)
  if (opts.checkServices !== false && manifest.spec.requires?.services?.length) {
    checks.push(...await runServiceChecks(manifest.spec.requires.services))
  }

  // 7. Sub-agent local file / A2A endpoint checks
  checks.push(...await runSubagentChecks(manifest, opts))

  // 8. Eval dataset file checks
  checks.push(...runEvalChecks(manifest, opts))

  const { status, summary } = computeHealthStatus(checks)

  return {
    agentName: manifest.metadata.name,
    timestamp: new Date().toISOString(),
    status,
    summary,
    checks,
  }
}

async function checkA2aEndpoint(name: string, url: string): Promise<HealthCheck> {
  // Validate URL scheme — only http/https permitted (prevents file://, javascript:, etc.)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      id: `subagent:${name}`,
      category: 'subagent',
      status: 'fail',
      severity: 'warning',
      message: `A2A endpoint for ${name} has an invalid URL`,
      remediation: `Set ref.a2a.url to a valid http:// or https:// URL`,
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      id: `subagent:${name}`,
      category: 'subagent',
      status: 'fail',
      severity: 'warning',
      message: `A2A endpoint for ${name} uses disallowed scheme "${parsed.protocol}"`,
      remediation: `Use an http:// or https:// URL for ref.a2a.url`,
    }
  }
  // Reject loopback and link-local addresses (SSRF guard)
  const host = parsed.hostname.replace(/^\[(.+)\]$/, '$1') // unwrap IPv6 brackets
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('169.254.') || // link-local (AWS metadata, etc.)
    host.startsWith('fe80:')
  ) {
    return {
      id: `subagent:${name}`,
      category: 'subagent',
      status: 'skip',
      severity: 'warning',
      message: `Skipping A2A check for ${name} — loopback/link-local address not checked`,
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  const start = Date.now()

  try {
    await fetch(url, { signal: controller.signal })
    return {
      id: `subagent:${name}`,
      category: 'subagent',
      status: 'pass',
      severity: 'warning',
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return {
      id: `subagent:${name}`,
      category: 'subagent',
      status: 'fail',
      severity: 'warning',
      latencyMs: Date.now() - start,
      message: isTimeout
        ? `A2A endpoint for ${name} timed out`
        : `A2A endpoint for ${name} unreachable: ${String(err)}`,
      remediation: `Check that the A2A endpoint is reachable`,
    }
  } finally {
    clearTimeout(timeout)
  }
}
