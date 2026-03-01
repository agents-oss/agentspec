/**
 * Minimal mock agent — simulates the upstream agent that agentspec-sidecar
 * wraps during E2E tests.
 *
 * Routes:
 *   GET  /health              → 200 {"status":"ok"}
 *   GET  /capabilities        → 200 AgentCard with a single "echo" tool
 *   GET  /agentspec/health    → 200 HealthReport (simulates @agentspec/sdk reporter)
 *   *    *                    → 200 {"method","url"}, echoes x-request-id header
 */

import { createServer } from 'node:http'

/**
 * Minimal HealthReport returned by the simulated SDK reporter.
 *
 * Must align with test/e2e/agent.yaml:
 *   model.apiKey: $env:OPENAI_API_KEY   → env:OPENAI_API_KEY check
 *   tools: [echo]                        → tool:echo check
 *   requires: (none)                     → no service checks
 */
const agentSpecHealthReport = {
  agentName: 'test-agent',
  timestamp: new Date().toISOString(),
  status: 'healthy',
  summary: { passed: 2, failed: 0, warnings: 0, skipped: 0 },
  checks: [
    { id: 'env:OPENAI_API_KEY', category: 'env', status: 'pass', severity: 'error' },
    { id: 'tool:echo', category: 'tool', status: 'pass', severity: 'info' },
  ],
}

const server = createServer((req, res) => {
  const requestId = req.headers['x-request-id']

  if (requestId) {
    res.setHeader('x-request-id', Array.isArray(requestId) ? requestId[0] : requestId)
  }
  res.setHeader('content-type', 'application/json')

  if (req.method === 'GET' && req.url === '/health') {
    res.statusCode = 200
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (req.method === 'GET' && req.url === '/capabilities') {
    res.statusCode = 200
    res.end(JSON.stringify({ name: 'test-agent', tools: [{ name: 'echo' }] }))
    return
  }

  // AgentSpec SDK reporter endpoint — simulates @agentspec/sdk AgentSpecReporter
  if (req.method === 'GET' && req.url === '/agentspec/health') {
    // Refresh the timestamp on each call (mirrors real reporter behaviour)
    const report = {
      ...agentSpecHealthReport,
      timestamp: new Date().toISOString(),
    }
    res.statusCode = 200
    res.end(JSON.stringify(report))
    return
  }

  // Default — echo method + url (drain body first)
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    res.statusCode = 200
    res.end(JSON.stringify({ method: req.method, url: req.url }))
  })
})

server.listen(8000, '0.0.0.0', () => {
  console.log('mock-agent listening on :8000')
})
