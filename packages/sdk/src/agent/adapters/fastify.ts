/**
 * Fastify plugin adapter for AgentSpecReporter.
 *
 * Registers GET /agentspec/health on the Fastify instance.
 *
 * Usage:
 *   import { AgentSpecReporter } from '@agentspec/sdk'
 *   import { agentSpecFastifyPlugin } from '@agentspec/sdk/agent/adapters/fastify'
 *
 *   const reporter = new AgentSpecReporter(manifest, { refreshIntervalMs: 30_000 })
 *   reporter.start()
 *   await app.register(agentSpecFastifyPlugin(reporter))
 */

import type { AgentSpecReporter } from '../reporter.js'

// Fastify types — declared inline to avoid adding fastify as a required dep
type FastifyReply = {
  status(code: number): FastifyReply
  send(body: unknown): void
}
type FastifyRequest = unknown
type FastifyInstance = {
  get(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void
}
type FastifyPluginAsync = (app: FastifyInstance) => Promise<void>

/**
 * Returns a Fastify plugin that registers the AgentSpec health endpoint.
 *
 * @param reporter - An AgentSpecReporter instance (should be started before registering)
 */
export function agentSpecFastifyPlugin(reporter: AgentSpecReporter): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.get('/agentspec/health', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const report = await reporter.getReport()
        reply.status(200).send(report)
      } catch (err) {
        reply.status(500).send({ error: String(err) })
      }
    })
  }
}
