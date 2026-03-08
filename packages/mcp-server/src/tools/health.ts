import { spawnCli } from '../cli-runner.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HealthArgs {
  /** Path to agent.yaml — runs local health checks via the CLI. */
  file?: string
  /** Operator mode: fetch stored health from the AgentSpec Operator. */
  agentName?: string
  controlPlaneUrl?: string
  adminKey?: string
  /** Sidecar mode: fetch live health from GET <sidecarUrl>/health/ready. */
  sidecarUrl?: string
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function fetchOperatorHealth(
  agentName: string,
  controlPlaneUrl: string,
  adminKey?: string,
): Promise<string> {
  const headers: Record<string, string> = {}
  if (adminKey) headers['X-Admin-Key'] = adminKey
  const url = `${controlPlaneUrl}/api/v1/agents/${encodeURIComponent(agentName)}/health`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`)
  return JSON.stringify(await res.json())
}

async function fetchSidecarHealth(sidecarUrl: string): Promise<string> {
  const url = `${sidecarUrl.replace(/\/$/, '')}/health/ready`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`)
  return JSON.stringify(await res.json())
}

// ── Public orchestrator ───────────────────────────────────────────────────────

/**
 * Run or fetch health checks for an agent.
 *
 * Modes:
 * - **Operator mode** (`agentName + controlPlaneUrl`): fetches stored health from the Operator.
 * - **Sidecar mode** (`sidecarUrl`): fetches live health from `GET <sidecarUrl>/health/ready`.
 * - **File mode** (`file`): runs `agentspec health <file> --json` locally.
 *
 * At least one of `file`, `sidecarUrl`, or `agentName + controlPlaneUrl` is required.
 */
export async function health(args: HealthArgs): Promise<string> {
  const { file, agentName, controlPlaneUrl, adminKey, sidecarUrl } = args

  if (agentName && controlPlaneUrl) {
    return fetchOperatorHealth(agentName, controlPlaneUrl, adminKey)
  }

  if (sidecarUrl) {
    return fetchSidecarHealth(sidecarUrl)
  }

  if (!file) {
    throw new Error('One of file, sidecarUrl, or agentName+controlPlaneUrl is required')
  }

  return (await spawnCli(['health', file, '--json'])).trim()
}
