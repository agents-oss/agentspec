/**
 * Vitest global setup/teardown for E2E tests.
 *
 * setup()    — docker compose up --build, then waits for /health/live
 * teardown() — docker compose down --volumes --remove-orphans
 */

import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const COMPOSE_FILE = join(__dirname, '../../docker-compose.test.yml')
const HEALTH_URL = 'http://localhost:14001/health/live'
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_POLL_INTERVAL_MS = 500

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = String(err)
    }
    await new Promise<void>((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }

  throw new Error(
    `Sidecar health check timed out after ${timeoutMs}ms. Last error: ${lastError}`,
  )
}

export async function setup(): Promise<void> {
  console.log('\n[e2e] Starting Docker Compose test stack...')
  execSync(`docker compose -f ${COMPOSE_FILE} up --build -d`, {
    stdio: 'inherit',
    timeout: 120_000,
  })
  console.log('[e2e] Waiting for sidecar health...')
  await waitForHealth(HEALTH_URL, HEALTH_TIMEOUT_MS)
  console.log('[e2e] Sidecar is healthy — running tests.')
}

export async function teardown(): Promise<void> {
  console.log('\n[e2e] Tearing down Docker Compose test stack...')
  execSync(
    `docker compose -f ${COMPOSE_FILE} down --volumes --remove-orphans`,
    { stdio: 'inherit', timeout: 30_000 },
  )
}
