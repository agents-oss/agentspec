import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { FastifyInstance } from 'fastify'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { config } from '../config.js'

interface EvalCase {
  input: string
  expected_output?: string
  tags?: string[]
  [key: string]: unknown
}

interface EvalResult {
  caseIndex: number
  input: string
  tags: string[]
  passed: boolean
  reason?: string
  responseExcerpt?: string
}

interface EvalRunRequest {
  dataset: string
  live?: boolean
}

async function readJsonl(filePath: string): Promise<EvalCase[]> {
  return new Promise((resolve, reject) => {
    const cases: EvalCase[] = []
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed) {
        try {
          cases.push(JSON.parse(trimmed) as EvalCase)
        } catch {
          // skip malformed lines
        }
      }
    })
    rl.on('close', () => resolve(cases))
    rl.on('error', reject)
  })
}

export async function buildEvalRoutes(
  app: FastifyInstance,
  manifest: AgentSpecManifest,
): Promise<void> {
  app.post<{ Body: EvalRunRequest }>('/eval/run', async (req, reply) => {
    const { dataset, live = false } = req.body ?? {}

    if (!dataset) {
      reply.status(400)
      return { error: 'dataset name is required' }
    }

    const datasetConfig = manifest.spec.evaluation?.datasets?.find(
      (d) => d.name === dataset,
    )

    if (!datasetConfig) {
      reply.status(404)
      return {
        error: `Dataset "${dataset}" not found in spec.evaluation.datasets`,
      }
    }

    let cases: EvalCase[]
    try {
      cases = await readJsonl(datasetConfig.path)
    } catch (err) {
      reply.status(500)
      return {
        error: `Failed to read dataset file: ${datasetConfig.path}`,
        detail: String(err),
      }
    }

    const results: EvalResult[] = []

    for (let i = 0; i < cases.length; i++) {
      const evalCase = cases[i]!
      const tags: string[] = Array.isArray(evalCase.tags) ? evalCase.tags : []

      if (!live) {
        // Dry-run: report all cases as skipped
        results.push({
          caseIndex: i,
          input: evalCase.input,
          tags,
          passed: true,
          reason: 'dry-run (live: false)',
        })
        continue
      }

      // Live mode: POST to upstream chat endpoint
      try {
        const upstream = config.upstreamUrl
        const chatPath = manifest.spec.api?.chatEndpoint?.path ?? '/v1/chat'
        const res = await fetch(`${upstream}${chatPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: evalCase.input }),
          signal: AbortSignal.timeout(30_000),
        })

        const body = await res.text()
        const isGuardrailCase = tags.some((t) => t.startsWith('guardrail:'))

        let passed: boolean
        let reason: string | undefined

        if (isGuardrailCase) {
          passed =
            res.status === 400 ||
            res.status === 422 ||
            body.includes('GUARDRAIL_REJECTED') ||
            body.toLowerCase().includes('reject')
          reason = passed ? undefined : 'Expected guardrail rejection, got pass'
        } else {
          passed = res.status < 400
          reason = passed ? undefined : `Upstream returned ${res.status}`
        }

        results.push({
          caseIndex: i,
          input: evalCase.input,
          tags,
          passed,
          reason,
          responseExcerpt: body.slice(0, 200),
        })
      } catch (err) {
        results.push({
          caseIndex: i,
          input: evalCase.input,
          tags,
          passed: false,
          reason: `Request failed: ${String(err)}`,
        })
      }
    }

    const passed = results.filter((r) => r.passed).length
    const failed = results.filter((r) => !r.passed).length

    return {
      total: cases.length,
      passed,
      failed,
      dataset,
      live,
      cases: results,
    }
  })
}
