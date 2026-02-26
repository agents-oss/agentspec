import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentSpecManifest } from '../../schema/manifest.schema.js'
import { collectEnvRefs, collectFileRefs } from '../../loader/resolvers.js'
import type { HealthCheck } from '../index.js'

export function runEnvChecks(
  manifest: AgentSpecManifest,
  rawManifest: unknown,
): HealthCheck[] {
  const checks: HealthCheck[] = []

  // Collect all $env: references from the raw manifest
  const envRefs = collectEnvRefs(rawManifest)

  // Also include explicitly declared envVars from spec.requires
  const declared = manifest.spec.requires?.envVars ?? []
  for (const v of declared) envRefs.add(v)

  for (const varName of envRefs) {
    const present = process.env[varName] !== undefined && process.env[varName] !== ''
    checks.push({
      id: `env:${varName}`,
      category: 'env',
      status: present ? 'pass' : 'fail',
      severity: 'error',
      message: present
        ? undefined
        : `Environment variable ${varName} is not set`,
      remediation: present
        ? undefined
        : `Set ${varName} in your .env file or environment`,
    })
  }

  return checks
}

export function runFileChecks(
  rawManifest: unknown,
  baseDir: string,
): HealthCheck[] {
  const checks: HealthCheck[] = []
  const fileRefs = collectFileRefs(rawManifest)

  for (const filePath of fileRefs) {
    const absPath = resolve(baseDir, filePath)
    const exists = existsSync(absPath)
    checks.push({
      id: `file:${filePath}`,
      category: 'file',
      status: exists ? 'pass' : 'fail',
      severity: 'error',
      message: exists ? undefined : `Referenced file not found: ${filePath}`,
      remediation: exists
        ? undefined
        : `Create the file at ${absPath} or update the $file: reference`,
    })
  }

  return checks
}
