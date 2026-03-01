/**
 * Unit tests for POST /eval/run endpoint.
 *
 * Covers:
 *  - 400 when dataset name is missing from request body
 *  - 404 when named dataset is not in spec.evaluation.datasets
 *  - 500 when the JSONL file cannot be read (file does not exist)
 *  - Dry-run: correct summary shape (total, passed, failed, dataset, live)
 *  - Dry-run: every case has passed:true and reason contains "dry-run"
 *  - Dry-run: total equals number of JSONL lines
 *  - Live mode: regular case passes when upstream returns 2xx
 *  - Live mode: regular case fails when upstream returns 5xx
 *  - Live mode: guardrail case passes when upstream returns 400
 *  - Live mode: guardrail case fails when upstream returns 200 (expected rejection)
 *  - Live mode: case fails with reason when upstream fetch throws
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { testManifest } from './fixtures.js'

// ── Temp JSONL fixture ────────────────────────────────────────────────────────

let evalDir: string
let evalFile: string

const SEED_CASES = [
  { input: 'What muscles does a squat work?', tags: [] },
  { input: 'How many reps for beginners?', tags: [] },
  { input: 'Show my workout history', tags: ['guardrail:pii'] },
]

beforeAll(() => {
  evalDir = mkdtempSync(join(tmpdir(), 'agentspec-eval-test-'))
  evalFile = join(evalDir, 'workout-qa.jsonl')
  writeFileSync(evalFile, SEED_CASES.map((c) => JSON.stringify(c)).join('\n'), 'utf-8')
})

afterAll(() => {
  rmSync(evalDir, { recursive: true, force: true })
})

// ── Manifest with evaluation datasets ────────────────────────────────────────

function makeEvalManifest(datasetPath: string): AgentSpecManifest {
  return {
    ...testManifest,
    spec: {
      ...testManifest.spec,
      evaluation: {
        framework: 'deepeval',
        datasets: [{ name: 'workout-qa', path: datasetPath }],
      },
    },
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

function evalPost(
  app: Awaited<ReturnType<typeof buildControlPlaneApp>>,
  body: object,
) {
  return app.inject({
    method: 'POST',
    url: '/eval/run',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify(body),
  })
}

// ── Error cases ───────────────────────────────────────────────────────────────

describe('POST /eval/run — error cases', () => {
  it('returns 400 when dataset name is missing', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await evalPost(app, {})
    expect(res.statusCode).toBe(400)
  })

  it('400 body has error message', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await evalPost(app, {})
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toBeTruthy()
  })

  it('returns 404 when named dataset is not declared in spec.evaluation', async () => {
    // manifest has no evaluation section
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'nonexistent' })
    expect(res.statusCode).toBe(404)
  })

  it('404 body mentions the missing dataset name', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'missing-set' })
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toContain('missing-set')
  })

  it('returns 500 when JSONL file does not exist', async () => {
    const manifest = makeEvalManifest('/no/such/path/data.jsonl')
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa' })
    expect(res.statusCode).toBe(500)
  })
})

// ── Dry-run mode ──────────────────────────────────────────────────────────────

describe('POST /eval/run — dry-run (live: false)', () => {
  it('returns 200', async () => {
    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: false })
    expect(res.statusCode).toBe(200)
  })

  it('response has total, passed, failed, dataset, live fields', async () => {
    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: false })
    const body = JSON.parse(res.body) as {
      total: number
      passed: number
      failed: number
      dataset: string
      live: boolean
    }
    expect(typeof body.total).toBe('number')
    expect(typeof body.passed).toBe('number')
    expect(typeof body.failed).toBe('number')
    expect(body.dataset).toBe('workout-qa')
    expect(body.live).toBe(false)
  })

  it('total equals the number of lines in the JSONL file', async () => {
    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: false })
    const body = JSON.parse(res.body) as { total: number }
    expect(body.total).toBe(SEED_CASES.length)
  })

  it('all cases pass in dry-run', async () => {
    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: false })
    const body = JSON.parse(res.body) as { passed: number; failed: number }
    expect(body.failed).toBe(0)
    expect(body.passed).toBe(SEED_CASES.length)
  })

  it('each case reason contains "dry-run"', async () => {
    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: false })
    const body = JSON.parse(res.body) as {
      cases: Array<{ reason: string }>
    }
    for (const c of body.cases) {
      expect(c.reason).toContain('dry-run')
    }
  })

  it('default mode is dry-run when live is omitted', async () => {
    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    // fetch should NOT be called in dry-run
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof global.fetch

    await evalPost(app, { dataset: 'workout-qa' }) // no live field
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── Live mode — regular cases ─────────────────────────────────────────────────

describe('POST /eval/run — live mode, regular cases', () => {
  it('regular case passes when upstream returns 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'Squats work quads, hamstrings, glutes.',
    }) as unknown as typeof global.fetch

    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: true })
    const body = JSON.parse(res.body) as { cases: Array<{ passed: boolean; tags: string[] }> }

    const regularCases = body.cases.filter((c) => !c.tags.some((t) => t.startsWith('guardrail:')))
    expect(regularCases.every((c) => c.passed)).toBe(true)
  })

  it('regular case fails when upstream returns 500', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }) as unknown as typeof global.fetch

    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: true })
    const body = JSON.parse(res.body) as { cases: Array<{ passed: boolean; tags: string[] }> }

    const regularCases = body.cases.filter((c) => !c.tags.some((t) => t.startsWith('guardrail:')))
    expect(regularCases.every((c) => !c.passed)).toBe(true)
  })

  it('failed regular case has a reason field', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }) as unknown as typeof global.fetch

    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: true })
    const body = JSON.parse(res.body) as { cases: Array<{ passed: boolean; reason?: string; tags: string[] }> }

    const failedCases = body.cases.filter((c) =>
      !c.tags.some((t) => t.startsWith('guardrail:')) && !c.passed,
    )
    for (const c of failedCases) {
      expect(c.reason).toBeTruthy()
    }
  })

  it('case fails with reason when upstream fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof global.fetch

    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: true })
    const body = JSON.parse(res.body) as {
      cases: Array<{ passed: boolean; reason?: string; tags: string[] }>
    }

    const regularCases = body.cases.filter((c) => !c.tags.some((t) => t.startsWith('guardrail:')))
    for (const c of regularCases) {
      expect(c.passed).toBe(false)
      expect(c.reason).toBeTruthy()
    }
  })
})

// ── Live mode — guardrail cases ───────────────────────────────────────────────

describe('POST /eval/run — live mode, guardrail cases', () => {
  it('guardrail case passes when upstream rejects with 400', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'GUARDRAIL_REJECTED: PII detected',
    }) as unknown as typeof global.fetch

    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: true })
    const body = JSON.parse(res.body) as {
      cases: Array<{ passed: boolean; tags: string[] }>
    }

    const guardrailCases = body.cases.filter((c) =>
      c.tags.some((t) => t.startsWith('guardrail:')),
    )
    expect(guardrailCases.length).toBeGreaterThan(0)
    expect(guardrailCases.every((c) => c.passed)).toBe(true)
  })

  it('guardrail case passes when upstream body contains GUARDRAIL_REJECTED', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 200,
      text: async () => '{"result":"GUARDRAIL_REJECTED"}',
    }) as unknown as typeof global.fetch

    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: true })
    const body = JSON.parse(res.body) as {
      cases: Array<{ passed: boolean; tags: string[] }>
    }

    const guardrailCases = body.cases.filter((c) =>
      c.tags.some((t) => t.startsWith('guardrail:')),
    )
    expect(guardrailCases.every((c) => c.passed)).toBe(true)
  })

  it('guardrail case fails (and has reason) when upstream returns 200 without rejection', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'Here is your workout history...',
    }) as unknown as typeof global.fetch

    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: true })
    const body = JSON.parse(res.body) as {
      cases: Array<{ passed: boolean; reason?: string; tags: string[] }>
    }

    const guardrailCases = body.cases.filter((c) =>
      c.tags.some((t) => t.startsWith('guardrail:')),
    )
    expect(guardrailCases.length).toBeGreaterThan(0)
    expect(guardrailCases.every((c) => !c.passed)).toBe(true)
    for (const c of guardrailCases) {
      expect(c.reason).toBeTruthy()
    }
  })
})

// ── Summary aggregation ───────────────────────────────────────────────────────

describe('POST /eval/run — summary counts', () => {
  it('passed + failed = total', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }) as unknown as typeof global.fetch

    const manifest = makeEvalManifest(evalFile)
    const app = await buildControlPlaneApp(manifest, new AuditRing())
    const res = await evalPost(app, { dataset: 'workout-qa', live: true })
    const body = JSON.parse(res.body) as { total: number; passed: number; failed: number }
    expect(body.passed + body.failed).toBe(body.total)
  })
})
