/**
 * service.check.ts — TCP port reachability checks for spec.requires.services.
 *
 * Uses raw TCP connections (node:net) — no Redis/Postgres drivers required.
 * Resolves connection strings from environment variables when necessary.
 *
 * Design: fail-safe. If a connection string references an unresolved $env: var,
 * the check returns 'skip' rather than 'fail' (the env check will surface the
 * underlying problem).
 *
 * Security: link-local (169.254.x.x) and loopback (127.x.x.x, ::1) addresses
 * are always rejected to prevent unintentional SSRF in container deployments.
 */

import type { HealthCheck } from '../index.js'

interface ServiceSpec {
  type: string
  connection: string
}

const TIMEOUT_MS = 3_000

/**
 * Runs TCP connectivity checks for all declared services.
 * Returns one HealthCheck per service entry.
 */
export async function runServiceChecks(services: ServiceSpec[]): Promise<HealthCheck[]> {
  return Promise.all(services.map((svc) => checkService(svc)))
}

async function checkService(svc: ServiceSpec): Promise<HealthCheck> {
  const id = `service:${svc.type}`
  const connection = resolveConnection(svc.connection)

  if (!connection) {
    return {
      id,
      category: 'service',
      status: 'skip',
      severity: 'warning',
      message: `Cannot check ${svc.type}: connection string not resolved (${svc.connection})`,
    }
  }

  const parsed = parseConnectionUrl(connection)
  if (!parsed) {
    return {
      id,
      category: 'service',
      status: 'skip',
      severity: 'warning',
      message: `Cannot check ${svc.type}: unrecognised connection string format`,
    }
  }

  // Reject link-local and loopback addresses to prevent SSRF probes from the
  // SDK running inside a container reaching instance metadata services.
  const hostRisk = classifyHost(parsed.host)
  if (hostRisk) {
    return {
      id,
      category: 'service',
      status: 'skip',
      severity: 'warning',
      message: `Cannot check ${svc.type}: ${hostRisk}`,
    }
  }

  if (!isSupportedType(svc.type)) {
    return {
      id,
      category: 'service',
      status: 'skip',
      severity: 'info',
      message: `TCP check not implemented for service type "${svc.type}"`,
    }
  }

  return tcpCheck(id, parsed.host, parsed.port)
}

/** Resolve $env:VAR_NAME references from the environment. Returns null if unresolved. */
function resolveConnection(connection: string): string | null {
  if (!connection.startsWith('$')) return connection

  const envMatch = connection.match(/^\$env:(.+)$/)
  if (envMatch) {
    return process.env[envMatch[1]] ?? null
  }

  // Other reference types ($secret:, $file:, etc.) cannot be resolved here
  return null
}

/** Parse host and port from a connection URL or host:port string. */
function parseConnectionUrl(connection: string): { host: string; port: number } | null {
  try {
    // Try URL parsing first (redis://host:port, postgres://host:port, etc.)
    const url = new URL(connection)
    const host = url.hostname || 'localhost'
    const defaultPort = getDefaultPort(url.protocol.replace(':', ''))
    const port = url.port ? parseInt(url.port, 10) : defaultPort
    if (!port || isNaN(port) || port < 1 || port > 65535) return null
    return { host, port }
  } catch {
    // Try host:port format
    const colonIdx = connection.lastIndexOf(':')
    if (colonIdx > 0) {
      const host = connection.slice(0, colonIdx)
      const port = parseInt(connection.slice(colonIdx + 1), 10)
      if (!isNaN(port) && port >= 1 && port <= 65535) return { host, port }
    }
    return null
  }
}

/**
 * Returns a rejection reason string if the host is a sensitive address,
 * or null if the host is acceptable for a TCP connectivity check.
 *
 * Rejects:
 *  - IPv4 loopback (127.0.0.0/8)
 *  - IPv4 link-local (169.254.0.0/16) — AWS/GCP instance metadata
 *  - IPv6 loopback (::1)
 *  - IPv6 link-local (fe80::/10)
 *  - Unspecified address (0.0.0.0)
 */
function classifyHost(host: string): string | null {
  // Normalize IPv6 bracket notation
  const h = host.replace(/^\[(.+)\]$/, '$1').toLowerCase()

  if (h === '0.0.0.0') return 'unspecified address 0.0.0.0 is not a valid service host'
  if (h === '::1' || h === 'localhost') return 'loopback address is not probed from service checks'
  if (h.startsWith('127.')) return 'IPv4 loopback (127.x.x.x) is not probed from service checks'
  if (h.startsWith('169.254.')) return 'link-local address (169.254.x.x) blocked to prevent instance-metadata SSRF'
  if (h.startsWith('fe80:')) return 'IPv6 link-local (fe80::/10) blocked to prevent SSRF'

  return null
}

function getDefaultPort(scheme: string): number {
  const ports: Record<string, number> = {
    redis: 6379,
    rediss: 6379,
    postgres: 5432,
    postgresql: 5432,
    mysql: 3306,
    mongodb: 27017,
    elasticsearch: 9200,
  }
  return ports[scheme] ?? 0
}

function isSupportedType(type: string): boolean {
  return ['redis', 'postgres', 'mysql', 'mongodb', 'elasticsearch'].includes(type)
}

async function tcpCheck(id: string, host: string, port: number): Promise<HealthCheck> {
  const start = Date.now()

  try {
    const { createConnection } = await import('node:net')

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port })

      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`TCP connection timed out after ${TIMEOUT_MS}ms`))
      }, TIMEOUT_MS)

      socket.on('connect', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve()
      })

      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    return {
      id,
      category: 'service',
      status: 'pass',
      severity: 'info',
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    return {
      id,
      category: 'service',
      status: 'fail',
      severity: 'warning',
      latencyMs: Date.now() - start,
      message: `Service unreachable at ${host}:${port} — ${String(err)}`,
      remediation: `Check the connection string for ${id} and ensure the service is running and accessible`,
    }
  }
}
