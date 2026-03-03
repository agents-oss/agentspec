import type { FastifyInstance } from 'fastify'
import { AUDIT_RULE_IDS, type ProofRecord } from '@agentspec/sdk'

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_FIELD_LENGTH = 2048

// ── ProofStore ────────────────────────────────────────────────────────────────

/**
 * In-memory store for proof records submitted by external tools.
 * Each ruleId holds at most one proof record (the latest submission overwrites).
 *
 * WARNING: Records are lost on sidecar restart. For production use,
 * re-submit proof records from your CI pipeline after deployment.
 * Set AGENTSPEC_PROOF_TOKEN to require bearer-token auth on mutating routes.
 */
export class ProofStore {
  private records = new Map<string, ProofRecord>()

  isValidRuleId(ruleId: string): boolean {
    return AUDIT_RULE_IDS.has(ruleId)
  }

  set(record: ProofRecord): void {
    this.records.set(record.ruleId, record)
  }

  get(ruleId: string): ProofRecord | undefined {
    return this.records.get(ruleId)
  }

  getAll(): ProofRecord[] {
    return [...this.records.values()]
  }

  delete(ruleId: string): boolean {
    return this.records.delete(ruleId)
  }

  clear(): void {
    this.records.clear()
  }
}

// ── Route builder ─────────────────────────────────────────────────────────────

export async function buildProofRoutes(
  app: FastifyInstance,
  store: ProofStore,
): Promise<void> {
  const proofToken = process.env['AGENTSPEC_PROOF_TOKEN']

  /**
   * Authenticate mutating requests (POST, DELETE) when AGENTSPEC_PROOF_TOKEN is set.
   * GET requests are always allowed.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET') return
    if (!proofToken) return // token not configured — allow (dev mode)
    const authHeader = req.headers['authorization'] ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (token !== proofToken) {
      return reply.status(401).send({ error: 'Unauthorized — provide a valid Bearer token in Authorization header' })
    }
  })

  /**
   * GET /proof
   * Returns all proof records as a JSON array.
   */
  app.get('/proof', async () => {
    return store.getAll()
  })

  /**
   * GET /proof/rule/:ruleId
   * Returns the proof record for a specific rule, or 404 if not found.
   */
  app.get<{ Params: { ruleId: string } }>('/proof/rule/:ruleId', async (req, reply) => {
    const { ruleId } = req.params
    const record = store.get(ruleId)
    if (!record) {
      return reply.status(404).send({ error: `No proof record for rule ${ruleId}` })
    }
    return record
  })

  /**
   * POST /proof/rule/:ruleId
   * Submit a proof record for a specific rule.
   * Body: { verifiedBy: string, method: string, expiresAt?: string }
   * Returns 201 Created with the stored ProofRecord.
   * Returns 400 if ruleId is not a known rule.
   */
  app.post<{
    Params: { ruleId: string }
    Body: { verifiedBy: string; method: string; expiresAt?: string }
  }>('/proof/rule/:ruleId', async (req, reply) => {
    const { ruleId } = req.params

    if (!store.isValidRuleId(ruleId)) {
      return reply.status(400).send({
        error: `Unknown rule ID: ${ruleId}`,
        validIds: [...AUDIT_RULE_IDS].sort(),
      })
    }

    const body = req.body as { verifiedBy?: unknown; method?: unknown; expiresAt?: unknown }

    if (typeof body?.verifiedBy !== 'string' || !body.verifiedBy) {
      return reply.status(400).send({ error: 'verifiedBy is required and must be a string' })
    }
    if (typeof body?.method !== 'string' || !body.method) {
      return reply.status(400).send({ error: 'method is required and must be a string' })
    }
    if (body.verifiedBy.length > MAX_FIELD_LENGTH) {
      return reply.status(400).send({ error: `verifiedBy exceeds ${MAX_FIELD_LENGTH} characters` })
    }
    if (body.method.length > MAX_FIELD_LENGTH) {
      return reply.status(400).send({ error: `method exceeds ${MAX_FIELD_LENGTH} characters` })
    }
    if (typeof body.expiresAt === 'string') {
      const d = new Date(body.expiresAt)
      if (isNaN(d.getTime())) {
        return reply.status(400).send({ error: 'expiresAt must be a valid ISO 8601 timestamp' })
      }
    }

    const record: ProofRecord = {
      ruleId,
      verifiedAt: new Date().toISOString(),
      verifiedBy: body.verifiedBy,
      method: body.method,
      ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}),
    }

    store.set(record)
    return reply.status(201).send(record)
  })

  /**
   * DELETE /proof/rule/:ruleId
   * Remove a proof record. Returns 204 No Content.
   * Returns 404 if no record exists for the rule.
   */
  app.delete<{ Params: { ruleId: string } }>('/proof/rule/:ruleId', async (req, reply) => {
    const { ruleId } = req.params
    const existed = store.delete(ruleId)
    if (!existed) {
      return reply.status(404).send({ error: `No proof record for rule ${ruleId}` })
    }
    return reply.status(204).send()
  })
}
