/**
 * Fetch proof records for an agent.
 *
 * Two modes:
 *   1. Named agent via control plane (preferred for multi-agent clusters):
 *      proof({ agentName: "budget-assistant", controlPlaneUrl: "https://cp.company.com", adminKey: "..." })
 *      → GET <controlPlaneUrl>/api/v1/agents/<agentName>/proof  (X-Admin-Key header)
 *
 *   2. Direct sidecar URL (local dev / single agent):
 *      proof({ sidecarUrl: "http://localhost:4001" })
 *      → GET <sidecarUrl>/proof
 */
export async function proof(args: {
  agentName?: string
  controlPlaneUrl?: string
  adminKey?: string
  sidecarUrl?: string
}): Promise<string> {
  const { agentName, controlPlaneUrl, adminKey, sidecarUrl } = args

  if (agentName && controlPlaneUrl) {
    return fetchFromControlPlane(controlPlaneUrl, agentName, adminKey)
  }

  if (sidecarUrl) {
    return fetchFromSidecar(sidecarUrl)
  }

  throw new Error(
    'Provide either (agentName + controlPlaneUrl) to query by name, ' +
    'or sidecarUrl for direct sidecar access.',
  )
}

async function fetchFromControlPlane(
  controlPlaneUrl: string,
  agentName: string,
  adminKey?: string,
): Promise<string> {
  const url = `${controlPlaneUrl.replace(/\/$/, '')}/api/v1/agents/${encodeURIComponent(agentName)}/proof`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (adminKey) headers['X-Admin-Key'] = adminKey

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`)
  return res.text()
}

async function fetchFromSidecar(sidecarUrl: string): Promise<string> {
  const url = `${sidecarUrl.replace(/\/$/, '')}/proof`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`)
  return res.text()
}
