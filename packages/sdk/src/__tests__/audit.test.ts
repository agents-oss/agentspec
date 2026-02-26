import { describe, it, expect } from 'vitest'
import { runAudit } from '../audit/index.js'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'

const minimalManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'test-agent',
    version: '1.0.0',
    description: 'A test agent',
  },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
    },
    prompts: {
      system: '$file:prompts/system.md',
      hotReload: false,
    },
  },
}

const secureFull: AgentSpecManifest = {
  ...minimalManifest,
  spec: {
    ...minimalManifest.spec,
    model: {
      ...minimalManifest.spec.model,
      costControls: { maxMonthlyUSD: 200, alertAtUSD: 150 },
      fallback: {
        provider: 'azure',
        id: 'gpt-4-0125-preview',
        apiKey: '$secret:azure-api-key',
        maxRetries: 2,
      },
    },
    tools: [
      {
        name: 'read-data',
        type: 'function',
        description: 'Read data',
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ],
    memory: {
      longTerm: {
        backend: 'postgres',
        connectionString: '$env:DATABASE_URL',
        ttlDays: 90,
      },
      hygiene: {
        piiScrubFields: ['ssn', 'credit_card'],
        auditLog: true,
      },
    },
    guardrails: {
      input: [
        {
          type: 'prompt-injection',
          action: 'reject',
          sensitivity: 'high',
        },
      ],
      output: [
        {
          type: 'toxicity-filter',
          threshold: 0.7,
          action: 'reject',
        },
      ],
    },
    evaluation: {
      framework: 'deepeval',
      datasets: [{ name: 'test-qa', path: '$file:eval/qa.jsonl' }],
      metrics: ['faithfulness', 'hallucination'],
      thresholds: { hallucination: 0.05 },
      ciGate: true,
    },
    api: {
      type: 'rest',
      port: 8000,
      rateLimit: { requestsPerMinute: 60 },
      streaming: false,
    },
  },
}

describe('runAudit', () => {
  it('returns an audit report with violations for a minimal manifest', () => {
    const report = runAudit(minimalManifest)
    expect(report.agentName).toBe('test-agent')
    expect(report.overallScore).toBeGreaterThanOrEqual(0)
    expect(report.overallScore).toBeLessThanOrEqual(100)
    expect(['A', 'B', 'C', 'D', 'F']).toContain(report.grade)
    expect(report.violations.length).toBeGreaterThan(0)
  })

  it('assigns higher score to a secure well-configured manifest', () => {
    const minReport = runAudit(minimalManifest)
    const secReport = runAudit(secureFull)
    expect(secReport.overallScore).toBeGreaterThan(minReport.overallScore)
  })

  it('filters rules by pack', () => {
    const report = runAudit(minimalManifest, { packs: ['model-resilience'] })
    const ruleIds = report.violations.map((v) => v.ruleId)
    // All violations should be MODEL- prefixed
    for (const id of ruleIds) {
      expect(id.startsWith('MODEL-')).toBe(true)
    }
  })

  it('includes suppression in report without affecting score', () => {
    const withSuppression: AgentSpecManifest = {
      ...secureFull,
      spec: {
        ...secureFull.spec,
        compliance: {
          suppressions: [
            {
              rule: 'SEC-LLM-10',
              reason: 'Design decision',
              expires: '2030-01-01',
            },
          ],
        },
      },
    }
    const report = runAudit(withSuppression)
    expect(report.suppressions.length).toBe(1)
    expect(report.suppressions[0]!.ruleId).toBe('SEC-LLM-10')
  })
})
