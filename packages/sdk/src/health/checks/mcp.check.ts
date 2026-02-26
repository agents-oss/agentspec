import type { AgentSpecMcpServer } from '../../schema/manifest.schema.js'
import type { HealthCheck } from '../index.js'

export async function runMcpChecks(servers: AgentSpecMcpServer[]): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = []

  for (const server of servers) {
    if (server.transport === 'sse' || server.transport === 'http') {
      // HTTP-based: can do a simple fetch health check
      const url = server.url
      if (url && !url.startsWith('$')) {
        const check = await checkHttpMcpServer(server.name, url)
        checks.push(check)
      } else {
        checks.push({
          id: `mcp:${server.name}`,
          category: 'mcp',
          status: 'skip',
          severity: 'warning',
          message: `Cannot check MCP server ${server.name}: URL not resolved`,
        })
      }
    } else if (server.transport === 'stdio') {
      // stdio: check if the command exists
      const check = await checkStdioMcpServer(server)
      checks.push(check)
    }
  }

  return checks
}

async function checkHttpMcpServer(name: string, url: string): Promise<HealthCheck> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  const start = Date.now()

  try {
    const res = await fetch(url, { signal: controller.signal })
    const latencyMs = Date.now() - start
    return {
      id: `mcp:${name}`,
      category: 'mcp',
      status: res.ok || res.status === 404 ? 'pass' : 'fail',
      severity: 'warning',
      latencyMs,
      message:
        res.status >= 500
          ? `MCP server ${name} returned HTTP ${res.status}`
          : undefined,
    }
  } catch (err) {
    const latencyMs = Date.now() - start
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return {
      id: `mcp:${name}`,
      category: 'mcp',
      status: 'fail',
      severity: 'warning',
      latencyMs,
      message: isTimeout
        ? `MCP server ${name} health check timed out`
        : `MCP server ${name} unreachable: ${String(err)}`,
      remediation: `Check that the MCP server ${name} is running and accessible`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function checkStdioMcpServer(server: AgentSpecMcpServer): Promise<HealthCheck> {
  // For stdio, we check if the command is available using `which` / `where`
  const command = server.command
  if (!command) {
    return {
      id: `mcp:${server.name}`,
      category: 'mcp',
      status: 'skip',
      severity: 'warning',
      message: `MCP server ${server.name} has no command specified`,
    }
  }

  // Validate command name to contain only safe characters (no shell metacharacters)
  if (!/^[a-zA-Z0-9._-]+$/.test(command)) {
    return {
      id: `mcp:${server.name}`,
      category: 'mcp',
      status: 'fail',
      severity: 'warning',
      message: `MCP server ${server.name} has unsafe command name: "${command}"`,
      remediation: 'MCP server command must match /^[a-zA-Z0-9._-]+$/',
    }
  }

  try {
    // Use execFileSync (not execSync) — does NOT invoke a shell, prevents injection
    const { execFileSync } = await import('node:child_process')
    const whichBin = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(whichBin, [command], { stdio: 'ignore' })
    return {
      id: `mcp:${server.name}`,
      category: 'mcp',
      status: 'pass',
      severity: 'warning',
      message: undefined,
    }
  } catch {
    return {
      id: `mcp:${server.name}`,
      category: 'mcp',
      status: 'fail',
      severity: 'warning',
      message: `MCP server ${server.name} command not found: ${command}`,
      remediation: `Install ${command} or add it to PATH`,
    }
  }
}
