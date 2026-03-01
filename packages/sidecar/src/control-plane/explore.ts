import type { FastifyInstance } from 'fastify'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { config } from '../config.js'
import { probeAgent } from './agent-probe.js'

const SIDECAR_VERSION = '0.1.0'

export async function buildExploreRoutes(
  app: FastifyInstance,
  manifest: AgentSpecManifest,
  opts: { startedAt?: number } = {},
): Promise<void> {
  const startedAt = opts.startedAt ?? Date.now()

  app.get('/explore', async () => {
    // Attempt live probe — graceful degradation if agent SDK not integrated
    const probe = await probeAgent(config.upstreamUrl)

    // ── Tools ──────────────────────────────────────────────────────────────────
    const tools = (manifest.spec.tools ?? []).map((t) => {
      const liveCheck = probe.report?.checks.find((c) => c.id === `tool:${t.name}`)
      return {
        name: t.name,
        type: t.type,
        readOnly: t.annotations?.readOnlyHint ?? false,
        destructive: t.annotations?.destructiveHint ?? false,
        status: liveCheck?.status ?? (probe.sdkAvailable ? 'unknown' : 'unknown'),
      }
    })

    // ── Dependencies ────────────────────────────────────────────────────────────
    const services = manifest.spec.requires?.services ?? []
    const dependencies: Array<{
      type: string
      connection: string
      status: string
      latencyMs?: number
    }> = services.map((svc) => {
      if (probe.sdkAvailable) {
        // Use live connectivity data from the agent
        const check = probe.report!.checks.find((c) => c.id === `service:${svc.type}`)
        return {
          type: svc.type,
          connection: svc.connection,
          status: check?.status ?? 'unknown',
          latencyMs: check?.latencyMs,
        }
      }
      // Static fallback — connection ref not resolved, status unknown
      return {
        type: svc.type,
        connection: svc.connection,
        status: 'unknown',
      }
    })

    // ── Model ──────────────────────────────────────────────────────────────────
    const modelCheck = probe.report?.checks.find((c) => c.category === 'model')
    const model = {
      provider: manifest.spec.model.provider,
      id: manifest.spec.model.id,
      configStatus: modelCheck?.status ?? 'unknown',
      ...(modelCheck?.message && { message: modelCheck.message }),
    }

    // ── Sub-agents ─────────────────────────────────────────────────────────────
    const subagents = (manifest.spec.subagents ?? []).map((s) => ({
      name: s.name,
      ref: s.ref,
      invocation: s.invocation,
      reachable: null as boolean | null,
    }))

    return {
      agent: {
        name: manifest.metadata.name,
        version: manifest.metadata.version,
      },
      source: probe.sdkAvailable ? 'agent-sdk' : 'manifest-static',
      model,
      tools,
      subagents,
      dependencies,
      sidecar: {
        version: SIDECAR_VERSION,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
      },
    }
  })
}
