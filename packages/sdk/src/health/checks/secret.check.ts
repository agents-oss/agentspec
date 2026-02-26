import type { HealthCheck } from '../index.js'

/**
 * Secret backend reachability check.
 *
 * Reads AGENTSPEC_SECRET_BACKEND env var (default: 'env').
 * - env:   always passes — no external backend required
 * - vault: attempts HTTP GET to VAULT_ADDR/v1/sys/health with 3s timeout
 * - aws:   attempts AWS STS metadata endpoint (no credentials needed for the check itself)
 * - gcp:   skipped (GCP ADC not trivially verifiable without a real call)
 * - azure: skipped (Azure MSI not trivially verifiable without a real call)
 */
export async function runSecretChecks(): Promise<HealthCheck[]> {
  const backend = process.env['AGENTSPEC_SECRET_BACKEND'] ?? 'env'

  if (backend === 'env') {
    return [
      {
        id: 'secret:backend',
        category: 'env',
        status: 'pass',
        severity: 'info',
        message: 'Secret backend is env — no external secret manager required',
      },
    ]
  }

  if (backend === 'vault') {
    return [await checkVault()]
  }

  if (backend === 'aws') {
    return [await checkAws()]
  }

  // gcp / azure: skip with informational message
  return [
    {
      id: 'secret:backend',
      category: 'env',
      status: 'skip',
      severity: 'info',
      message: `Secret backend '${backend}' reachability check not yet supported — verify manually`,
    },
  ]
}

async function checkVault(): Promise<HealthCheck> {
  const vaultAddr = process.env['VAULT_ADDR']
  if (!vaultAddr) {
    return {
      id: 'secret:vault',
      category: 'env',
      status: 'skip',
      severity: 'warning',
      message: 'AGENTSPEC_SECRET_BACKEND=vault but VAULT_ADDR is not set',
      remediation: 'Set VAULT_ADDR to your Vault server address (e.g. https://vault.example.com)',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  const start = Date.now()

  try {
    const url = `${vaultAddr.replace(/\/$/, '')}/v1/sys/health`
    const res = await fetch(url, { signal: controller.signal })
    // Vault /v1/sys/health returns 200, 429, 472, 473, or 501/503
    // Any reachable response means the server is up
    const ok = res.status < 600
    return {
      id: 'secret:vault',
      category: 'env',
      status: ok ? 'pass' : 'fail',
      severity: 'error',
      latencyMs: Date.now() - start,
      message: ok ? undefined : `Vault returned unexpected status ${res.status}`,
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return {
      id: 'secret:vault',
      category: 'env',
      status: 'fail',
      severity: 'error',
      latencyMs: Date.now() - start,
      message: isTimeout
        ? `Vault health check timed out (VAULT_ADDR=${vaultAddr})`
        : `Vault not reachable at ${vaultAddr}: ${String(err)}`,
      remediation: 'Check that VAULT_ADDR is correct and the Vault server is running',
    }
  } finally {
    clearTimeout(timer)
  }
}

async function checkAws(): Promise<HealthCheck> {
  // AWS STS regional endpoint — returns 200 for any valid request
  // We don't need credentials to confirm reachability
  const stsEndpoint = 'https://sts.amazonaws.com'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  const start = Date.now()

  try {
    // A plain GET returns an XML error (no credentials), but the server IS reachable
    await fetch(stsEndpoint, { signal: controller.signal })
    return {
      id: 'secret:aws',
      category: 'env',
      status: 'pass',
      severity: 'info',
      latencyMs: Date.now() - start,
      message: 'AWS STS endpoint is reachable',
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return {
      id: 'secret:aws',
      category: 'env',
      status: 'fail',
      severity: 'error',
      latencyMs: Date.now() - start,
      message: isTimeout
        ? 'AWS STS endpoint check timed out'
        : `AWS STS endpoint unreachable: ${String(err)}`,
      remediation: 'Check network connectivity and AWS credentials configuration',
    }
  } finally {
    clearTimeout(timer)
  }
}
