/**
 * POST /agentspec/events — EventPush behavioral observation endpoint.
 *
 * The sdk-langgraph SidecarClient pushes a batch of behavioral events for each
 * request after the agent has finished processing (out-of-band, fire-and-forget).
 *
 * The sidecar:
 *   1. Looks up the requestId in the audit ring (must have been injected by the proxy)
 *   2. Updates the entry with real behavioral data (guardrails, tools, model calls)
 *   3. Optionally evaluates OPA against the real data (fail-open)
 *   4. Returns violations (if any) so the agent can log them
 *
 * Returns 202 if the requestId is not yet in the ring — the agent pushed before the
 * proxy recorded (TTL race at high throughput). The agent should not retry.
 */

import type { FastifyInstance } from 'fastify'
import type { AgentSpecManifest } from '@agentspec/sdk'
import type { AuditRing } from '../audit-ring.js'
import { config } from '../config.js'
import { buildBehavioralOPAInput, queryOPA } from './opa-client.js'

// ── Event type definitions ────────────────────────────────────────────────────

interface GuardrailEventPayload {
  type: 'guardrail'
  guardrailType: string
  invoked: boolean
  blocked: boolean
  score?: number | null
  action?: string | null
}

interface ToolEventPayload {
  type: 'tool'
  name: string
  success: boolean
  latencyMs?: number
}

interface ModelEventPayload {
  type: 'model'
  modelId: string
  tokenCount?: number
}

interface MemoryEventPayload {
  type: 'memory'
  backend: string
  ttlSeconds?: number
  piiScrubbed?: boolean
}

type EventPayload =
  | GuardrailEventPayload
  | ToolEventPayload
  | ModelEventPayload
  | MemoryEventPayload

interface EventBatchRequest {
  requestId: string
  agentName: string
  events: EventPayload[]
}

// ── Route builder ─────────────────────────────────────────────────────────────

export interface EventsRouteOptions {
  /** Override OPA URL for this route (defaults to config.opaUrl). Pass null to disable. */
  opaUrl?: string | null
}

export async function buildEventsRoutes(
  app: FastifyInstance,
  manifest: AgentSpecManifest,
  auditRing: AuditRing,
  opts: EventsRouteOptions = {},
): Promise<void> {
  const opaUrl = opts.opaUrl !== undefined ? opts.opaUrl : config.opaUrl

  app.post('/events', { bodyLimit: 65_536 }, async (request, reply) => {
    const body = request.body as EventBatchRequest

    // ── Validate required fields ───────────────────────────────────────────────
    if (!body || typeof body.requestId !== 'string' || !body.requestId) {
      return reply.code(400).send({ error: 'requestId is required' })
    }
    if (!Array.isArray(body.events)) {
      return reply.code(400).send({ error: 'events must be an array' })
    }
    if (body.events.length > 500) {
      return reply.code(400).send({ error: 'events array exceeds maximum length (500)' })
    }

    const requestId = body.requestId
    // Cap agentName to prevent oversized strings reaching the audit ring / OPA input
    const agentName =
      typeof body.agentName === 'string' ? body.agentName.slice(0, 64) : ''
    const events = body.events

    // ── Find entry in audit ring ───────────────────────────────────────────────
    const entry = auditRing.findById(requestId)
    if (!entry) {
      // Race: agent pushed before the proxy recorded the request.
      // This is expected at high throughput. Tell the agent not to retry.
      return reply.code(202).send({
        requestId,
        found: false,
        message: 'Request not yet in audit ring — TTL race, no retry needed',
      })
    }

    // ── Extract behavioral data from the event batch ────────────────────────────
    const guardrailsInvoked: string[] = []
    const toolsCalled: string[] = []
    const modelCalls: { modelId: string; tokenCount: number }[] = []

    for (const event of events) {
      if (!event || typeof event.type !== 'string') continue

      switch (event.type) {
        case 'guardrail': {
          const g = event as GuardrailEventPayload
          if (g.invoked && typeof g.guardrailType === 'string') {
            guardrailsInvoked.push(g.guardrailType)
          }
          break
        }
        case 'tool': {
          const t = event as ToolEventPayload
          if (typeof t.name === 'string') {
            toolsCalled.push(t.name)
          }
          break
        }
        case 'model': {
          const m = event as ModelEventPayload
          if (typeof m.modelId === 'string') {
            modelCalls.push({
              modelId: m.modelId,
              tokenCount: typeof m.tokenCount === 'number' ? m.tokenCount : 0,
            })
          }
          break
        }
        // memory events: record nothing on AuditEntry for now
      }
    }

    // ── Update the audit ring entry with behavioral data ────────────────────────
    const behavioralUpdate: Partial<typeof entry> = {}
    if (guardrailsInvoked.length > 0) behavioralUpdate.guardrailsInvoked = guardrailsInvoked
    if (toolsCalled.length > 0) behavioralUpdate.toolsCalled = toolsCalled
    if (modelCalls.length > 0) behavioralUpdate.modelCalls = modelCalls

    // ── OPA evaluation on real behavioral data (fail-open) ─────────────────────
    let opaViolations: string[] = []
    if (opaUrl) {
      try {
        const opaInput = buildBehavioralOPAInput(
          manifest,
          guardrailsInvoked,
          toolsCalled,
        )
        const opaResult = await queryOPA(opaUrl, manifest.metadata.name, opaInput)

        if (!opaResult.opaUnavailable) {
          opaViolations = opaResult.violations
          behavioralUpdate.behavioralCompliant = opaResult.allow
          if (opaViolations.length > 0) {
            // Merge violations into existing entry (don't overwrite proxy-level violations)
            const existing = entry.opaViolations ?? []
            const merged = [...new Set([...existing, ...opaViolations])]
            behavioralUpdate.opaViolations = merged
          }
        }
      } catch {
        // OPA errors are non-fatal — behavioral data is still recorded
      }
    }

    auditRing.updateById(requestId, behavioralUpdate)

    return reply.code(200).send({
      requestId,
      found: true,
      opaViolations,
    })
  })
}
