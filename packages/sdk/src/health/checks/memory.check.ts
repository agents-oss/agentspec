import type { AgentSpecMemory } from '../../schema/manifest.schema.js'
import type { HealthCheck } from '../index.js'

export async function runMemoryChecks(memory: AgentSpecMemory): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = []

  if (memory.shortTerm) {
    const st = memory.shortTerm
    const connection = st.connection

    if (st.backend === 'redis' && connection && !connection.startsWith('$')) {
      checks.push(await checkRedis(connection))
    } else if (st.backend === 'in-memory') {
      checks.push({
        id: 'memory.shortTerm:in-memory',
        category: 'memory',
        status: 'pass',
        severity: 'warning',
        message: undefined,
      })
    } else {
      checks.push({
        id: `memory.shortTerm:${st.backend}`,
        category: 'memory',
        status: 'skip',
        severity: 'warning',
        message: `Cannot check ${st.backend} connection: connection string not resolved`,
      })
    }
  }

  if (memory.longTerm) {
    const lt = memory.longTerm
    const conn = lt.connectionString

    if (!conn.startsWith('$')) {
      if (lt.backend === 'postgres') {
        checks.push(await checkPostgres(conn))
      } else {
        checks.push({
          id: `memory.longTerm:${lt.backend}`,
          category: 'memory',
          status: 'skip',
          severity: 'warning',
          message: `${lt.backend} connectivity check not yet supported`,
        })
      }
    } else {
      checks.push({
        id: `memory.longTerm:${lt.backend}`,
        category: 'memory',
        status: 'skip',
        severity: 'warning',
        message: `Cannot check ${lt.backend}: connection string not resolved (${conn})`,
      })
    }
  }

  if (memory.vector) {
    const v = memory.vector
    const conn = v.connectionString ?? v.apiKey

    if (conn && !conn.startsWith('$')) {
      if (v.backend === 'pgvector') {
        checks.push(await checkPostgres(conn, 'memory.vector:pgvector'))
      } else {
        checks.push({
          id: `memory.vector:${v.backend}`,
          category: 'memory',
          status: 'skip',
          severity: 'warning',
          message: `${v.backend} connectivity check not yet supported`,
        })
      }
    } else {
      checks.push({
        id: `memory.vector:${v.backend}`,
        category: 'memory',
        status: 'skip',
        severity: 'warning',
        message: `Cannot check ${v.backend}: connection not resolved`,
      })
    }
  }

  return checks
}

async function checkRedis(url: string): Promise<HealthCheck> {
  const start = Date.now()
  try {
    // Basic TCP connectivity check using Node's net module
    const { createConnection } = await import('node:net')
    const parsed = new URL(url)
    const port = parseInt(parsed.port || '6379', 10)
    const host = parsed.hostname || 'localhost'

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port, host }, () => {
        socket.destroy()
        resolve()
      })
      // Ensure socket is destroyed on both timeout and error to prevent resource leak
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('timeout'))
      }, 3000)
      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      socket.on('connect', () => clearTimeout(timer))
    })

    return {
      id: 'memory.shortTerm:redis',
      category: 'memory',
      status: 'pass',
      severity: 'warning',
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    return {
      id: 'memory.shortTerm:redis',
      category: 'memory',
      status: 'fail',
      severity: 'warning',
      latencyMs: Date.now() - start,
      message: `Redis not reachable: ${String(err)}`,
      remediation: 'Check REDIS_URL and ensure your Redis instance is running',
    }
  }
}

async function checkPostgres(connStr: string, id = 'memory.longTerm:postgres'): Promise<HealthCheck> {
  const start = Date.now()
  try {
    const parsed = new URL(connStr)
    const port = parseInt(parsed.port || '5432', 10)
    const host = parsed.hostname || 'localhost'

    const { createConnection } = await import('node:net')
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port, host }, () => {
        socket.destroy()
        resolve()
      })
      // Ensure socket is destroyed on both timeout and error to prevent resource leak
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('timeout'))
      }, 3000)
      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      socket.on('connect', () => clearTimeout(timer))
    })

    return {
      id,
      category: 'memory',
      status: 'pass',
      severity: 'warning',
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    return {
      id,
      category: 'memory',
      status: 'fail',
      severity: 'warning',
      latencyMs: Date.now() - start,
      message: `PostgreSQL not reachable: ${String(err)}`,
      remediation: 'Check DATABASE_URL and ensure your PostgreSQL instance is running',
    }
  }
}
