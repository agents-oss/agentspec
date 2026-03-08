/**
 * Fetch the gap report for an agent.
 *
 * Two modes:
 *   1. Named agent via control plane (preferred for multi-agent clusters):
 *      gap({ agentName: "budget-assistant", controlPlaneUrl: "https://cp.company.com", adminKey: "..." })
 *      → GET <controlPlaneUrl>/api/v1/agents/<agentName>/gap  (X-Admin-Key header)
 *
 *   2. Direct sidecar URL (local dev / single agent):
 *      gap({ sidecarUrl: "http://localhost:4001" })
 *      → GET <sidecarUrl>/gap
 */
export async function gap(args: {
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
  const url = `${controlPlaneUrl.replace(/\/$/, '')}/api/v1/agents/${encodeURIComponent(agentName)}/gap`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (adminKey) headers['X-Admin-Key'] = adminKey

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`)
  return res.text()
}

async function fetchFromSidecar(sidecarUrl: string): Promise<string> {
  const url = `${sidecarUrl.replace(/\/$/, '')}/gap`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`)
  return res.text()
}
