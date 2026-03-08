import { readdir, readFile } from 'fs/promises'
import { join, resolve } from 'path'

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentSummary {
  path: string
  name?: string
  version?: string
  model?: string
  framework?: string
}

interface ClusterAgent {
  agentId?: string
  agentName: string
  runtime?: string
  phase?: string
  grade?: string
  score?: number
  lastSeen?: string
  heartbeat: boolean
}

export interface ListAgentsArgs {
  dir?: string
  controlPlaneUrl?: string
  adminKey?: string
}

// ── Control plane (heartbeat agents) ────────────────────────────────────────

async function fetchHeartbeatAgents(controlPlaneUrl: string, adminKey?: string): Promise<ClusterAgent[]> {
  const url = `${controlPlaneUrl.replace(/\/$/, '')}/api/v1/agents`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (adminKey) headers['X-Admin-Key'] = adminKey

  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return [] // control plane may be empty or unavailable
    const agents = JSON.parse(await res.text()) as Record<string, unknown>[]
    return agents.map(a => ({
      ...a,
      heartbeat: a.lastSeen != null,
    }) as ClusterAgent)
  } catch {
    return []
  }
}

// ── Cluster mode ─────────────────────────────────────────────────────────────

async function fetchFromCluster(controlPlaneUrl: string, adminKey?: string): Promise<string> {
  const heartbeatAgents = await fetchHeartbeatAgents(controlPlaneUrl, adminKey)

  const total = heartbeatAgents.length
  const withHeartbeat = heartbeatAgents.filter(a => a.heartbeat).length

  return JSON.stringify({
    agents: heartbeatAgents,
    source: 'cluster',
    total,
    summary: {
      total,
      withHeartbeat,
      withoutHeartbeat: total - withHeartbeat,
      message: total === 0
        ? 'No agents registered in the control plane. Agents need to call POST /api/v1/register and push heartbeats via the SDK push mode (AGENTSPEC_URL + AGENTSPEC_KEY env vars).'
        : `${total} agent(s) registered, ${withHeartbeat} with active heartbeats.`,
    },
  })
}

// ── Local mode ───────────────────────────────────────────────────────────────

async function findAgentYamls(dir: string, depth = 0, max = 4): Promise<string[]> {
  if (depth > max) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`warn: skipping unreadable directory ${dir} — ${msg}\n`)
    return []
  }
  const results: string[] = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === 'agent.yaml') {
      results.push(full)
    } else if (entry.isDirectory()) {
      results.push(...await findAgentYamls(full, depth + 1, max))
    }
  }
  return results
}

function extractField(yaml: string, field: string): string | undefined {
  const match = new RegExp(`^\\s*${field}:\\s*(.+)`, 'm').exec(yaml)
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
}

async function summarise(filePath: string): Promise<AgentSummary> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return {
      path: filePath,
      name: extractField(raw, 'name'),
      version: extractField(raw, 'version'),
      model: extractField(raw, 'id'),
      framework: extractField(raw, 'framework'),
    }
  } catch {
    return { path: filePath }
  }
}

async function scanLocal(dir?: string): Promise<string> {
  const root = resolve(dir ?? process.cwd())
  const paths = await findAgentYamls(root)

  if (paths.length === 0) {
    return JSON.stringify({ agents: [], root, source: 'local', message: 'No agent.yaml files found.' })
  }

  const agents = await Promise.all(paths.map(summarise))
  return JSON.stringify({ agents, root, source: 'local', total: agents.length })
}

// ── Public orchestrator ──────────────────────────────────────────────────────

export async function listAgents(args?: ListAgentsArgs | string): Promise<string> {
  // Backward compat: old callers pass a string (dir)
  if (typeof args === 'string') return scanLocal(args)
  if (!args) return scanLocal()

  const { controlPlaneUrl, adminKey, dir } = args
  if (controlPlaneUrl) return fetchFromCluster(controlPlaneUrl, adminKey)
  return scanLocal(dir)
}
