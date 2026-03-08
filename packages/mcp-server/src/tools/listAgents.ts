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

export interface ListAgentsArgs {
  dir?: string
  controlPlaneUrl?: string
  adminKey?: string
}

// ── Cluster mode ─────────────────────────────────────────────────────────────

async function fetchFromCluster(controlPlaneUrl: string, adminKey?: string): Promise<string> {
  const url = `${controlPlaneUrl.replace(/\/$/, '')}/api/v1/agents`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (adminKey) headers['X-Admin-Key'] = adminKey

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`)

  const agents = JSON.parse(await res.text())
  return JSON.stringify({ agents, source: 'cluster', total: agents.length })
}

// ── Local mode ───────────────────────────────────────────────────────────────

async function findAgentYamls(dir: string, depth = 0, max = 4): Promise<string[]> {
  if (depth > max) return []
  const entries = await readdir(dir, { withFileTypes: true })
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
