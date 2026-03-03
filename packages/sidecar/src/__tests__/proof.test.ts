/**
 * Unit tests for ProofStore and /proof endpoints.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { buildControlPlaneApp, ProofStore } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import { testManifest } from './fixtures.js'
import type { ProofRecord } from '@agentspec/sdk'

function makeStore(): ProofStore {
  return new ProofStore()
}

async function makeApp(store?: ProofStore) {
  return buildControlPlaneApp(testManifest, new AuditRing(), {
    proofStore: store ?? makeStore(),
  })
}

// ── ProofStore unit tests ─────────────────────────────────────────────────────

describe('ProofStore (unit)', () => {
  let store: ProofStore

  beforeEach(() => {
    store = makeStore()
  })

  it('starts empty', () => {
    expect(store.getAll()).toHaveLength(0)
  })

  it('stores and retrieves a proof record by ruleId', () => {
    const record: ProofRecord = {
      ruleId: 'SEC-LLM-04',
      verifiedAt: '2026-01-01T00:00:00Z',
      verifiedBy: 'k6',
      method: '1200 req/min, 429 at 1000',
    }
    store.set(record)
    expect(store.get('SEC-LLM-04')).toEqual(record)
  })

  it('overwrites an existing record for the same ruleId', () => {
    const r1: ProofRecord = { ruleId: 'MODEL-01', verifiedAt: '2026-01-01T00:00:00Z', verifiedBy: 'a', method: 'first' }
    const r2: ProofRecord = { ruleId: 'MODEL-01', verifiedAt: '2026-01-02T00:00:00Z', verifiedBy: 'b', method: 'second' }
    store.set(r1)
    store.set(r2)
    expect(store.get('MODEL-01')?.method).toBe('second')
    expect(store.getAll()).toHaveLength(1)
  })

  it('returns undefined for unknown ruleId', () => {
    expect(store.get('UNKNOWN-99')).toBeUndefined()
  })

  it('getAll returns all stored records', () => {
    store.set({ ruleId: 'SEC-LLM-04', verifiedAt: '', verifiedBy: 'k6', method: 'test' })
    store.set({ ruleId: 'MODEL-01', verifiedAt: '', verifiedBy: 'litellm', method: 'test' })
    expect(store.getAll()).toHaveLength(2)
  })

  it('delete removes a record and returns true', () => {
    store.set({ ruleId: 'SEC-LLM-04', verifiedAt: '', verifiedBy: 'k6', method: 'test' })
    expect(store.delete('SEC-LLM-04')).toBe(true)
    expect(store.get('SEC-LLM-04')).toBeUndefined()
  })

  it('delete returns false when record does not exist', () => {
    expect(store.delete('UNKNOWN-99')).toBe(false)
  })

  it('isValidRuleId returns true for known rule IDs', () => {
    expect(store.isValidRuleId('SEC-LLM-04')).toBe(true)
    expect(store.isValidRuleId('MODEL-01')).toBe(true)
    expect(store.isValidRuleId('MEM-01')).toBe(true)
    expect(store.isValidRuleId('EVAL-01')).toBe(true)
    expect(store.isValidRuleId('OBS-01')).toBe(true)
  })

  it('isValidRuleId returns false for unknown rule IDs', () => {
    expect(store.isValidRuleId('UNKNOWN-99')).toBe(false)
    expect(store.isValidRuleId('')).toBe(false)
    expect(store.isValidRuleId('SEC-LLM-99')).toBe(false)
  })
})

// ── GET /proof ────────────────────────────────────────────────────────────────

describe('GET /proof', () => {
  it('returns 200 with empty array when store is empty', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/proof' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns stored proof records', async () => {
    const store = makeStore()
    store.set({
      ruleId: 'SEC-LLM-04',
      verifiedAt: '2026-01-01T00:00:00Z',
      verifiedBy: 'k6',
      method: '1200 req/min',
    })
    const app = await makeApp(store)
    const res = await app.inject({ method: 'GET', url: '/proof' })
    const records = JSON.parse(res.body) as ProofRecord[]
    expect(records).toHaveLength(1)
    expect(records[0]?.ruleId).toBe('SEC-LLM-04')
    expect(records[0]?.verifiedBy).toBe('k6')
  })
})

// ── GET /proof/rule/:ruleId ───────────────────────────────────────────────────

describe('GET /proof/rule/:ruleId', () => {
  it('returns 200 with the proof record when it exists', async () => {
    const store = makeStore()
    store.set({
      ruleId: 'MODEL-01',
      verifiedAt: '2026-01-01T00:00:00Z',
      verifiedBy: 'litellm-chaos',
      method: 'fallback invoked 5/5',
    })
    const app = await makeApp(store)
    const res = await app.inject({ method: 'GET', url: '/proof/rule/MODEL-01' })
    expect(res.statusCode).toBe(200)
    const record = JSON.parse(res.body) as ProofRecord
    expect(record.ruleId).toBe('MODEL-01')
    expect(record.verifiedBy).toBe('litellm-chaos')
  })

  it('returns 404 when no proof record exists', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/proof/rule/SEC-LLM-04' })
    expect(res.statusCode).toBe(404)
  })
})

// ── POST /proof/rule/:ruleId ──────────────────────────────────────────────────

describe('POST /proof/rule/:ruleId', () => {
  it('returns 201 Created with the stored record', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/proof/rule/SEC-LLM-04',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verifiedBy: 'k6',
        method: '1200 req/min throttled at 1000 (100% 429 rate)',
      }),
    })
    expect(res.statusCode).toBe(201)
    const record = JSON.parse(res.body) as ProofRecord
    expect(record.ruleId).toBe('SEC-LLM-04')
    expect(record.verifiedBy).toBe('k6')
    expect(record.method).toBe('1200 req/min throttled at 1000 (100% 429 rate)')
    expect(record.verifiedAt).toBeTruthy()
    // verifiedAt should be a valid ISO timestamp set by the server
    expect(() => new Date(record.verifiedAt)).not.toThrow()
  })

  it('stores the record retrievable via GET', async () => {
    const store = makeStore()
    const app = await makeApp(store)

    await app.inject({
      method: 'POST',
      url: '/proof/rule/MODEL-01',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifiedBy: 'litellm-chaos', method: 'test' }),
    })

    const getRes = await app.inject({ method: 'GET', url: '/proof/rule/MODEL-01' })
    expect(getRes.statusCode).toBe(200)
    expect(JSON.parse(getRes.body)).toMatchObject({ ruleId: 'MODEL-01' })
  })

  it('stores optional expiresAt field', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/proof/rule/MEM-01',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verifiedBy: 'presidio',
        method: 'PII injected and verified scrubbed',
        expiresAt: '2027-01-01T00:00:00Z',
      }),
    })
    expect(res.statusCode).toBe(201)
    const record = JSON.parse(res.body) as ProofRecord
    expect(record.expiresAt).toBe('2027-01-01T00:00:00Z')
  })

  it('returns 400 for unknown rule ID', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/proof/rule/UNKNOWN-99',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifiedBy: 'test', method: 'test' }),
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string; validIds: string[] }
    expect(body.error).toContain('Unknown rule ID')
    expect(Array.isArray(body.validIds)).toBe(true)
  })

  it('returns 400 when verifiedBy is missing', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/proof/rule/SEC-LLM-04',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'test' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when method is missing', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/proof/rule/SEC-LLM-04',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifiedBy: 'k6' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('overwrites existing proof record with new submission', async () => {
    const store = makeStore()
    const app = await makeApp(store)

    await app.inject({
      method: 'POST',
      url: '/proof/rule/MODEL-01',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifiedBy: 'first-tool', method: 'first run' }),
    })

    await app.inject({
      method: 'POST',
      url: '/proof/rule/MODEL-01',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifiedBy: 'second-tool', method: 'second run' }),
    })

    expect(store.getAll()).toHaveLength(1)
    expect(store.get('MODEL-01')?.verifiedBy).toBe('second-tool')
  })
})

// ── DELETE /proof/rule/:ruleId ────────────────────────────────────────────────

describe('DELETE /proof/rule/:ruleId', () => {
  it('returns 204 No Content when record is deleted', async () => {
    const store = makeStore()
    store.set({ ruleId: 'SEC-LLM-04', verifiedAt: '', verifiedBy: 'k6', method: 'test' })
    const app = await makeApp(store)
    const res = await app.inject({ method: 'DELETE', url: '/proof/rule/SEC-LLM-04' })
    expect(res.statusCode).toBe(204)
    expect(store.get('SEC-LLM-04')).toBeUndefined()
  })

  it('returns 404 when no record exists', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'DELETE', url: '/proof/rule/SEC-LLM-04' })
    expect(res.statusCode).toBe(404)
  })
})
