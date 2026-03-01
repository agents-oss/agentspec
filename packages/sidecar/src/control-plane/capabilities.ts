import type { FastifyInstance } from 'fastify'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { config } from '../config.js'

export interface AgentCard {
  schema_version: string
  name: string
  description: string
  url: string
  capabilities: {
    streaming: boolean
    mcp: boolean
  }
  tools: Array<{
    name: string
    description: string
    annotations?: Record<string, boolean | undefined>
  }>
  subagents: Array<{
    name: string
    ref: unknown
    invocation: string
  }>
  compliance_packs: string[]
  agentspec_version: string
}

export function buildAgentCard(
  manifest: AgentSpecManifest,
  proxyUrl: string,
): AgentCard {
  return {
    schema_version: '1.0',
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    url: proxyUrl,
    capabilities: {
      streaming: manifest.spec.api?.streaming ?? false,
      mcp: true,
    },
    tools: (manifest.spec.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      annotations: t.annotations
        ? {
            readOnlyHint: t.annotations.readOnlyHint,
            destructiveHint: t.annotations.destructiveHint,
            idempotentHint: t.annotations.idempotentHint,
            openWorldHint: t.annotations.openWorldHint,
          }
        : undefined,
    })),
    subagents: (manifest.spec.subagents ?? []).map((s) => ({
      name: s.name,
      ref: s.ref,
      invocation: s.invocation,
    })),
    compliance_packs: manifest.spec.compliance?.packs ?? [],
    agentspec_version: '1.0.0',
  }
}

export async function buildCapabilitiesRoutes(
  app: FastifyInstance,
  manifest: AgentSpecManifest,
  opts: { proxyUrl?: string } = {},
): Promise<void> {
  const proxyUrl =
    opts.proxyUrl ?? `http://localhost:${config.proxyPort}`
  const card = buildAgentCard(manifest, proxyUrl)

  app.get('/capabilities', async () => card)
  app.get('/.well-known/agent.json', async () => card)
}
