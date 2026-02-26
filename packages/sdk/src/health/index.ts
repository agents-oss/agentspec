import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import { runEnvChecks, runFileChecks } from './checks/env.check.js'
import { runModelChecks } from './checks/model.check.js'
import { runMcpChecks } from './checks/mcp.check.js'
import { runMemoryChecks } from './checks/memory.check.js'
import { runSecretChecks } from './checks/secret.check.js'

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
  /** Override base directory for $file resolution */
  baseDir?: string
  /** Raw parsed YAML object (for $env/$file ref collection) */
  rawManifest?: unknown
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
  const envChecks = runEnvChecks(manifest, rawManifest)
  checks.push(...envChecks)

  // 1b. Secret backend reachability
  const secretChecks = await runSecretChecks()
  checks.push(...secretChecks)

  // 2. File reference checks
  if (opts.baseDir) {
    const fileChecks = runFileChecks(rawManifest, opts.baseDir)
    checks.push(...fileChecks)
  }

  // 3. Model endpoint checks
  if (opts.checkModel !== false) {
    const modelChecks = await runModelChecks(manifest.spec.model)
    checks.push(...modelChecks)
  }

  // 4. MCP server checks
  if (opts.checkMcp !== false && manifest.spec.mcp?.servers?.length) {
    const mcpChecks = await runMcpChecks(manifest.spec.mcp.servers)
    checks.push(...mcpChecks)
  }

  // 5. Memory backend checks
  if (opts.checkMemory !== false && manifest.spec.memory) {
    const memChecks = await runMemoryChecks(manifest.spec.memory)
    checks.push(...memChecks)
  }

  // 6. Sub-agent local file checks
  if (manifest.spec.subagents) {
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
  }

  // 7. Eval dataset file checks
  if (manifest.spec.evaluation?.datasets && opts.baseDir) {
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
  }

  // ── Compute overall status ────────────────────────────────────────────────
  const failed = checks.filter((c) => c.status === 'fail')
  const warnings = checks.filter((c) => c.status === 'warn')
  const passed = checks.filter((c) => c.status === 'pass')
  const skipped = checks.filter((c) => c.status === 'skip')

  const hasErrors = failed.some((c) => c.severity === 'error')
  const hasWarnings = failed.some((c) => c.severity === 'warning') || warnings.length > 0

  const status: HealthStatus = hasErrors
    ? 'unhealthy'
    : hasWarnings
      ? 'degraded'
      : 'healthy'

  return {
    agentName: manifest.metadata.name,
    timestamp: new Date().toISOString(),
    status,
    summary: {
      passed: passed.length,
      failed: failed.length,
      warnings: warnings.length,
      skipped: skipped.length,
    },
    checks,
  }
}

async function checkA2aEndpoint(name: string, url: string): Promise<HealthCheck> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  const start = Date.now()

  try {
    const res = await fetch(url, { signal: controller.signal })
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
      remediation: `Check that the A2A endpoint is reachable at ${url}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}
