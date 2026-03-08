#!/usr/bin/env node
/**
 * AgentSpec MCP Server — Streamable HTTP transport (MCP spec 2025-03-26).
 * POST /mcp  →  JSON-RPC 2.0 for tools/list + tools/call
 *
 * Add to Claude Code / Cursor / Windsurf:
 *   { "mcpServers": { "agentspec": { "command": "npx", "args": ["-y", "@agentspec/mcp-server"] } } }
 */

import http from 'http'
import { validate } from './tools/validate.js'
import { health } from './tools/health.js'
import { audit } from './tools/audit.js'
import { scan } from './tools/scan.js'
import { generate } from './tools/generate.js'
import { gap } from './tools/gap.js'
import { diff } from './tools/diff.js'
import { listAgents } from './tools/listAgents.js'
import { proof } from './tools/proof.js'

// ── Types ─────────────────────────────────────────────────────────────────────

interface McpRequest {
  jsonrpc: string
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

interface McpResponse {
  jsonrpc: '2.0'
  id?: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    name: 'agentspec_validate',
    description: 'Validate an agent.yaml manifest against the AgentSpec schema',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Path to agent.yaml' } },
      required: ['file'],
    },
  },
  {
    name: 'agentspec_health',
    description: 'Run or fetch health checks for an agent. Use file for local manifest checks, sidecarUrl for live sidecar data, or agentName+controlPlaneUrl for Operator-stored data.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to agent.yaml (file mode — runs local health checks via CLI)' },
        agentName: { type: 'string', description: 'Agent name as registered in the Operator (operator mode)' },
        controlPlaneUrl: { type: 'string', description: 'AgentSpec Operator URL (e.g. https://agentspec.mycompany.com). Required with agentName.' },
        adminKey: { type: 'string', description: 'X-Admin-Key for the Operator API (optional if public)' },
        sidecarUrl: { type: 'string', description: 'Direct sidecar URL for live health data (e.g. http://localhost:4001)' },
      },
      required: [],
    },
  },
  {
    name: 'agentspec_audit',
    description: 'Run compliance audit and return score, grade, and violations. Use file for declarative audit, sidecarUrl to enrich with sidecar proof records, or agentName+controlPlaneUrl to include Operator-stored proofs.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to agent.yaml' },
        pack: { type: 'string', description: 'Compliance pack (e.g. owasp-llm-top10)' },
        agentName: { type: 'string', description: 'Agent name for Operator proof lookup (operator mode)' },
        controlPlaneUrl: { type: 'string', description: 'AgentSpec Operator URL. Required with agentName.' },
        adminKey: { type: 'string', description: 'X-Admin-Key for the Operator API (optional if public)' },
        sidecarUrl: { type: 'string', description: 'Sidecar URL to fetch proof records (sidecar mode)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'agentspec_scan',
    description: 'Scan a source directory and generate an agent.yaml manifest (dry-run)',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Directory to scan' } },
      required: ['dir'],
    },
  },
  {
    name: 'agentspec_generate',
    description: 'Generate framework code (LangGraph, CrewAI, Mastra) from an agent.yaml',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to agent.yaml' },
        framework: { type: 'string', description: 'Target framework: langgraph, crewai, or mastra' },
        out: { type: 'string', description: 'Output directory (optional)' },
      },
      required: ['file', 'framework'],
    },
  },
  {
    name: 'agentspec_gap',
    description: 'Fetch the declared-vs-runtime gap report for an agent. Use agentName+controlPlaneUrl to query by name (multi-agent clusters), or sidecarUrl for direct local access.',
    inputSchema: {
      type: 'object',
      properties: {
        agentName: { type: 'string', description: 'Agent name as registered in the control plane (e.g. budget-assistant)' },
        controlPlaneUrl: { type: 'string', description: 'Control plane URL (e.g. https://agentspec.mycompany.com). Required when using agentName.' },
        adminKey: { type: 'string', description: 'X-Admin-Key for the control plane API (optional if public)' },
        sidecarUrl: { type: 'string', description: 'Direct sidecar URL for local dev (e.g. http://localhost:4001). Use instead of agentName when no control plane is available.' },
      },
      required: [],
    },
  },
  {
    name: 'agentspec_diff',
    description: 'Compare two agent.yaml files and return a JSON diff',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Path to the base agent.yaml' },
        to: { type: 'string', description: 'Path to the new agent.yaml' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'agentspec_proof',
    description: 'Fetch compliance proof records for an agent. Use agentName+controlPlaneUrl to query by name (multi-agent clusters), or sidecarUrl for direct local access.',
    inputSchema: {
      type: 'object',
      properties: {
        agentName: { type: 'string', description: 'Agent name as registered in the control plane (e.g. budget-assistant)' },
        controlPlaneUrl: { type: 'string', description: 'Control plane URL (e.g. https://agentspec.mycompany.com). Required when using agentName.' },
        adminKey: { type: 'string', description: 'X-Admin-Key for the control plane API (optional if public)' },
        sidecarUrl: { type: 'string', description: 'Direct sidecar URL for local dev (e.g. http://localhost:4001). Use instead of agentName when no control plane is available.' },
      },
      required: [],
    },
  },
  {
    name: 'agentspec_list_agents',
    description: 'Find all agent.yaml files under a directory and return a summary list (name, version, model)',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory to search (default: current working directory)' },
      },
      required: [],
    },
  },
]

// ── Tool dispatch ─────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'agentspec_validate':
      return validate(args['file'] as string)
    case 'agentspec_health':
      return health({
        file: args['file'] as string | undefined,
        agentName: args['agentName'] as string | undefined,
        controlPlaneUrl: args['controlPlaneUrl'] as string | undefined,
        adminKey: args['adminKey'] as string | undefined,
        sidecarUrl: args['sidecarUrl'] as string | undefined,
      })
    case 'agentspec_audit':
      return audit({
        file: args['file'] as string,
        pack: args['pack'] as string | undefined,
        agentName: args['agentName'] as string | undefined,
        controlPlaneUrl: args['controlPlaneUrl'] as string | undefined,
        adminKey: args['adminKey'] as string | undefined,
        sidecarUrl: args['sidecarUrl'] as string | undefined,
      })
    case 'agentspec_scan':
      return scan(args['dir'] as string)
    case 'agentspec_generate':
      return generate(
        args['file'] as string,
        args['framework'] as string,
        args['out'] as string | undefined,
      )
    case 'agentspec_proof':
      return proof({
        agentName: args['agentName'] as string | undefined,
        controlPlaneUrl: args['controlPlaneUrl'] as string | undefined,
        adminKey: args['adminKey'] as string | undefined,
        sidecarUrl: args['sidecarUrl'] as string | undefined,
      })
    case 'agentspec_gap':
      return gap({
        agentName: args['agentName'] as string | undefined,
        controlPlaneUrl: args['controlPlaneUrl'] as string | undefined,
        adminKey: args['adminKey'] as string | undefined,
        sidecarUrl: args['sidecarUrl'] as string | undefined,
      })
    case 'agentspec_diff':
      return diff(args['from'] as string, args['to'] as string)
    case 'agentspec_list_agents':
      return listAgents(args['dir'] as string | undefined)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ── JSON-RPC handler ──────────────────────────────────────────────────────────

function mcpOk(id: string | number | undefined, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function mcpErr(id: string | number | undefined, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

async function handleRpc(req: McpRequest): Promise<McpResponse> {
  if (req.jsonrpc !== '2.0') {
    return mcpErr(req.id, -32600, 'Invalid JSON-RPC version')
  }

  switch (req.method) {
    case 'initialize':
      return mcpOk(req.id, {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'agentspec', version: '1.0.0' },
        capabilities: { tools: {} },
      })

    case 'tools/list':
      return mcpOk(req.id, { tools: TOOLS })

    case 'tools/call': {
      const toolName = req.params?.['name'] as string | undefined
      const toolArgs = (req.params?.['arguments'] ?? {}) as Record<string, unknown>
      if (!toolName) return mcpErr(req.id, -32602, 'Missing tool name')
      try {
        const text = await callTool(toolName, toolArgs)
        return mcpOk(req.id, { content: [{ type: 'text', text }] })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return mcpOk(req.id, {
          content: [{ type: 'text', text: `Error: ${msg}` }],
          isError: true,
        })
      }
    }

    case 'ping':
      return mcpOk(req.id, {})

    default:
      return mcpErr(req.id, -32601, `Method not found: ${req.method}`)
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', server: 'agentspec-mcp' }))
    return
  }

  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found. POST /mcp for MCP JSON-RPC.' }))
    return
  }

  let body: string
  try {
    body = await readBody(req)
  } catch {
    res.writeHead(400)
    res.end('Bad request')
    return
  }

  let rpcReq: McpRequest
  try {
    rpcReq = JSON.parse(body) as McpRequest
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mcpErr(undefined, -32700, 'Parse error')))
    return
  }

  const response = await handleRpc(rpcReq)
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(response))
}

// ── Entry point ───────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['MCP_PORT'] ?? '3666', 10)

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    res.writeHead(500)
    res.end(String(err))
  })
})

server.listen(PORT, () => {
  process.stderr.write(`AgentSpec MCP server listening on http://localhost:${PORT}/mcp\n`)
})

export { handleRpc, callTool, TOOLS }
