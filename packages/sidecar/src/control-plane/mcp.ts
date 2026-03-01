import type { FastifyInstance } from 'fastify'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { config } from '../config.js'

/**
 * Minimal MCP Streamable HTTP transport (2024-11-05 spec).
 * Exposes each spec.tools[] entry as an MCP tool.
 * Tool calls are proxied via POST /chat (or spec.api.chatEndpoint.path) to the upstream.
 */

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

function mcpError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): McpResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

export async function buildMcpRoutes(
  app: FastifyInstance,
  manifest: AgentSpecManifest,
): Promise<void> {
  const tools = (manifest.spec.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: `Input message for tool ${t.name}`,
        },
      },
      required: ['message'],
    },
    annotations: t.annotations,
  }))

  // MCP JSON-RPC handler — single endpoint per Streamable HTTP spec
  app.post<{ Body: McpRequest }>('/mcp', async (req, reply) => {
    const { jsonrpc, id, method, params } = req.body ?? {}

    if (jsonrpc !== '2.0') {
      reply.status(400)
      return mcpError(id, -32600, 'Invalid Request: jsonrpc must be "2.0"')
    }

    if (typeof method !== 'string') {
      reply.status(400)
      return mcpError(id, -32600, 'Invalid Request: method must be a string')
    }

    switch (method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: `agentspec-sidecar/${manifest.metadata.name}`,
              version: '0.1.0',
            },
          },
        } satisfies McpResponse
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: { tools },
        } satisfies McpResponse
      }

      case 'tools/call': {
        const rawName = params?.['name']
        if (typeof rawName !== 'string') {
          return mcpError(id, -32602, 'Invalid params: name must be a string')
        }
        const toolName: string = rawName
        const toolArgs = params?.['arguments'] as Record<string, unknown> | undefined

        const tool = tools.find((t) => t.name === toolName)
        if (!tool) {
          return mcpError(id, -32602, `Unknown tool: ${toolName}`)
        }

        // Proxy the tool call to upstream via chat endpoint
        try {
          const upstream = config.upstreamUrl
          const chatPath = manifest.spec.api?.chatEndpoint?.path ?? '/v1/chat'
          const message =
            (toolArgs?.['message'] as string | undefined) ??
            `Call tool ${toolName} with args: ${JSON.stringify(toolArgs)}`

          const res = await fetch(`${upstream}${chatPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, tool: toolName, args: toolArgs }),
            signal: AbortSignal.timeout(30_000),
          })

          const body = await res.text()
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: body }],
            },
          } satisfies McpResponse
        } catch (err) {
          return mcpError(id, -32603, `Tool call failed: ${String(err)}`)
        }
      }

      default:
        return mcpError(id, -32601, `Method not found: ${method}`)
    }
  })

  // GET /mcp — returns MCP server info (for discovery)
  app.get('/mcp', async () => ({
    name: `agentspec-sidecar/${manifest.metadata.name}`,
    version: '0.1.0',
    protocol: 'mcp/2024-11-05',
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    endpoint: '/mcp',
    transport: 'http',
  }))
}
