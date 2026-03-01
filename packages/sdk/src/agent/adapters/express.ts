/**
 * Express middleware adapter for AgentSpecReporter.
 *
 * Returns a plain Express middleware (req, res, next) that handles
 * GET /health relative to the mount point.
 *
 * Usage:
 *   import { AgentSpecReporter } from '@agentspec/sdk'
 *   import { agentSpecExpressRouter } from '@agentspec/sdk/agent/adapters/express'
 *
 *   const reporter = new AgentSpecReporter(manifest)
 *   reporter.start()
 *   app.use('/agentspec', agentSpecExpressRouter(reporter))
 *
 * The middleware also exposes a ._routes array for introspection in tests.
 */

import type { AgentSpecReporter } from '../reporter.js'

// Express types — declared inline to avoid adding express as a required dep
type ExpressRequest = { method?: string; path?: string; url?: string }
type ExpressResponse = {
  status(code: number): ExpressResponse
  json(body: unknown): void
}
type NextFunction = (err?: unknown) => void
type ExpressMiddleware = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction,
) => void

/**
 * Creates an Express-compatible middleware that serves the AgentSpec health
 * endpoint at GET /health (relative to where it is mounted).
 *
 * Mount at /agentspec to expose GET /agentspec/health.
 *
 * @param reporter - An AgentSpecReporter instance (should be started before use)
 * @returns A plain Express middleware function (compatible with app.use())
 */
export function agentSpecExpressRouter(
  reporter: AgentSpecReporter,
): ExpressMiddleware & { _routes: Array<{ path: string }> } {
  const handler: ExpressMiddleware = async (req, res, next) => {
    // Only handle GET /health; pass everything else down the chain
    const method = req.method?.toUpperCase() ?? 'GET'
    const path = req.path ?? req.url ?? ''

    if (method !== 'GET' || path !== '/health') {
      next()
      return
    }

    try {
      const report = await reporter.getReport()
      res.status(200).json(report)
    } catch (err) {
      try {
        res.status(500).json({ error: String(err) })
      } catch {
        next(err)
      }
    }
  }

  // Expose registered routes for test introspection
  ;(handler as ExpressMiddleware & { _routes: Array<{ path: string }> })._routes = [
    { path: '/health' },
  ]

  return handler as ExpressMiddleware & { _routes: Array<{ path: string }> }
}
