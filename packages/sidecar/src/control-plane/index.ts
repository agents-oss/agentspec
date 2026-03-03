import Fastify, { type FastifyInstance } from 'fastify'
import type { AgentSpecManifest } from '@agentspec/sdk'
import type { AuditRing } from '../audit-ring.js'
import { buildHealthRoutes } from './health.js'
import { buildCapabilitiesRoutes } from './capabilities.js'
import { buildMcpRoutes } from './mcp.js'
import { buildAuditRoutes } from './audit.js'
import { buildExplainRoutes } from './explain.js'
import { buildExploreRoutes } from './explore.js'
import { buildEvalRoutes } from './eval.js'
import { buildGapRoutes } from './gap.js'
import { buildEventsRoutes } from './events.js'

export interface ControlPlaneOptions {
  logger?: boolean
  proxyUrl?: string
  startedAt?: number
  /** OPA URL to use for /events behavioral evaluation. Defaults to config.opaUrl. */
  opaUrl?: string | null
}

export async function buildControlPlaneApp(
  manifest: AgentSpecManifest,
  auditRing: AuditRing,
  opts: ControlPlaneOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false })

  await buildHealthRoutes(app, manifest)
  await buildCapabilitiesRoutes(app, manifest, { proxyUrl: opts.proxyUrl })
  await buildMcpRoutes(app, manifest)
  await buildAuditRoutes(app, auditRing)
  await buildExplainRoutes(app, auditRing)
  await buildExploreRoutes(app, manifest, { startedAt: opts.startedAt })
  await buildEvalRoutes(app, manifest)
  await buildGapRoutes(app, manifest, auditRing)
  await buildEventsRoutes(app, manifest, auditRing, { opaUrl: opts.opaUrl })

  return app
}
