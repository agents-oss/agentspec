import { spawnCli } from '../cli-runner.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuditArgs {
  file: string
  pack?: string
  /** Operator mode: fetch stored proofs from the AgentSpec Operator. */
  agentName?: string
  controlPlaneUrl?: string
  adminKey?: string
  /** Sidecar mode: pass --url to CLI so it fetches proofs from the sidecar. */
  sidecarUrl?: string
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function fetchOperatorProofs(
  agentName: string,
  controlPlaneUrl: string,
  adminKey?: string,
): Promise<unknown[]> {
  const headers: Record<string, string> = {}
  if (adminKey) headers['X-Admin-Key'] = adminKey
  const url = `${controlPlaneUrl}/api/v1/agents/${encodeURIComponent(agentName)}/proof`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    process.stderr.write(`fetchOperatorProofs: GET ${url} returned ${res.status} ${res.statusText}\n`)
    return []
  }
  // Operator returns { records: [...], receivedAt: "..." } — extract the list
  const data = await res.json() as { records?: unknown[] }
  return data.records ?? []
}

// ── Public orchestrator ───────────────────────────────────────────────────────

/**
 * Run compliance audit for an agent.
 *
 * Modes:
 * - **File only**: `agentspec audit <file> --json` — declarative audit, no proofs.
 * - **Sidecar mode** (`sidecarUrl`): passes `--url` to CLI so it fetches proofs from the sidecar.
 * - **Operator mode** (`agentName + controlPlaneUrl`): fetches stored proofs from the Operator,
 *   runs declarative audit via CLI, and merges the proof records into the response.
 */
export async function audit(args: AuditArgs): Promise<string> {
  const { file, pack, agentName, controlPlaneUrl, adminKey, sidecarUrl } = args

  const cliArgs = ['audit', file, '--json']
  if (pack) cliArgs.push('--pack', pack)

  // Sidecar mode: let CLI handle proof fetching via --url
  if (sidecarUrl) {
    cliArgs.push('--url', sidecarUrl)
    return (await spawnCli(cliArgs)).trim()
  }

  // Run declarative audit first
  const auditOutput = await spawnCli(cliArgs)

  // Operator mode: fetch stored proofs and merge into output
  if (agentName && controlPlaneUrl) {
    const proofRecords = await fetchOperatorProofs(agentName, controlPlaneUrl, adminKey)
    const auditReport = JSON.parse(auditOutput) as Record<string, unknown>
    return JSON.stringify({ ...auditReport, proofRecords, source: 'operator' })
  }

  return auditOutput.trim()
}
