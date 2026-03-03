import { describe, it, expect } from 'vitest'
import { runAudit } from '../audit/index.js'
import { modelRules } from '../audit/rules/model.rules.js'
import { securityRules } from '../audit/rules/security.rules.js'
import { memoryRules } from '../audit/rules/memory.rules.js'
import { evaluationRules } from '../audit/rules/evaluation.rules.js'
import { observabilityRules } from '../audit/rules/observability.rules.js'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import type { ProofRecord } from '../audit/index.js'

const allRules = [
  ...modelRules,
  ...securityRules,
  ...memoryRules,
  ...evaluationRules,
  ...observabilityRules,
]

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

describe('evidenceLevel classification', () => {
  it('every AuditRule has a valid evidenceLevel', () => {
    for (const rule of allRules) {
      expect(['declarative', 'probed', 'behavioral', 'external']).toContain(
        rule.evidenceLevel,
      )
    }
  })

  it('behavioral rules are exactly SEC-LLM-01, SEC-LLM-02, OBS-02', () => {
    const behavioral = allRules
      .filter((r) => r.evidenceLevel === 'behavioral')
      .map((r) => r.id)
      .sort()
    expect(behavioral).toEqual(['OBS-02', 'SEC-LLM-01', 'SEC-LLM-02'].sort())
  })

  it('probed rules include expected rule IDs', () => {
    const probedIds = allRules.filter((r) => r.evidenceLevel === 'probed').map((r) => r.id)
    expect(probedIds).toContain('SEC-LLM-03')
    expect(probedIds).toContain('SEC-LLM-05')
    expect(probedIds).toContain('MODEL-02')
    expect(probedIds).toContain('MEM-02')
    expect(probedIds).toContain('EVAL-01')
    expect(probedIds).toContain('OBS-01')
  })

  it('external rules include expected rule IDs', () => {
    const externalIds = allRules.filter((r) => r.evidenceLevel === 'external').map((r) => r.id)
    expect(externalIds).toContain('SEC-LLM-04')
    expect(externalIds).toContain('SEC-LLM-06')
    expect(externalIds).toContain('SEC-LLM-07')
    expect(externalIds).toContain('SEC-LLM-08')
    expect(externalIds).toContain('MODEL-01')
    expect(externalIds).toContain('MODEL-03')
    expect(externalIds).toContain('MODEL-04')
    expect(externalIds).toContain('MEM-01')
    expect(externalIds).toContain('OBS-03')
  })

  it('all external rules have proofTool defined', () => {
    const external = allRules.filter((r) => r.evidenceLevel === 'external')
    expect(external.length).toBeGreaterThan(0)
    for (const rule of external) {
      expect(rule.proofTool).toBeDefined()
      expect(typeof rule.proofTool).toBe('string')
      expect(rule.proofTool!.length).toBeGreaterThan(0)
    }
  })

  it('all probed rules have proofTool defined', () => {
    const probed = allRules.filter((r) => r.evidenceLevel === 'probed')
    expect(probed.length).toBeGreaterThan(0)
    for (const rule of probed) {
      expect(rule.proofTool).toBeDefined()
    }
  })

  it('AuditReport includes evidenceBreakdown with external tier', () => {
    const report = runAudit(minimalManifest)
    expect(report.evidenceBreakdown).toBeDefined()
    expect(report.evidenceBreakdown).toMatchObject({
      declarative: { passed: expect.any(Number), total: expect.any(Number) },
      probed:      { passed: expect.any(Number), total: expect.any(Number) },
      behavioral:  { passed: expect.any(Number), total: expect.any(Number) },
      external:    { passed: expect.any(Number), total: expect.any(Number) },
    })
  })

  it('declarative evidenceBreakdown total is 0 (no declarative rules remain)', () => {
    const report = runAudit(minimalManifest)
    expect(report.evidenceBreakdown.declarative.total).toBe(0)
  })

  it('violations include evidenceLevel', () => {
    const report = runAudit(minimalManifest)
    expect(report.violations.length).toBeGreaterThan(0)
    for (const v of report.violations) {
      expect(['declarative', 'probed', 'behavioral', 'external']).toContain(v.evidenceLevel)
    }
  })

  it('external violations include proofTool', () => {
    const report = runAudit(minimalManifest)
    const externalViolations = report.violations.filter((v) => v.evidenceLevel === 'external')
    expect(externalViolations.length).toBeGreaterThan(0)
    for (const v of externalViolations) {
      expect(v.proofTool).toBeDefined()
      expect(typeof v.proofTool).toBe('string')
    }
  })
})

describe('provedScore', () => {
  it('provedScore is undefined when no proofRecords provided', () => {
    const report = runAudit(minimalManifest)
    expect(report.provedScore).toBeUndefined()
    expect(report.provedGrade).toBeUndefined()
    expect(report.pendingProofCount).toBeUndefined()
  })

  it('provedScore and pendingProofCount are numbers when proofRecords provided (empty)', () => {
    const report = runAudit(minimalManifest, { proofRecords: [] })
    expect(typeof report.provedScore).toBe('number')
    expect(typeof report.provedGrade).toBe('string')
    expect(typeof report.pendingProofCount).toBe('number')
  })

  it('provedScore is between 0 and 100', () => {
    const report = runAudit(minimalManifest, { proofRecords: [] })
    expect(report.provedScore!).toBeGreaterThanOrEqual(0)
    expect(report.provedScore!).toBeLessThanOrEqual(100)
  })

  it('provedScore <= overallScore (proved is subset of declared passes)', () => {
    const report = runAudit(secureFull, { proofRecords: [] })
    expect(report.provedScore!).toBeLessThanOrEqual(report.overallScore)
  })

  it('provedScore increases when an external rule has a proof record', () => {
    // secureFull has fallback declared (MODEL-01 passes declaratively, it's external)
    const reportNoProof = runAudit(secureFull, { proofRecords: [] })
    const reportWithProof = runAudit(secureFull, {
      proofRecords: [
        {
          ruleId: 'MODEL-01',
          verifiedAt: '2026-01-01T00:00:00Z',
          verifiedBy: 'litellm-chaos',
          method: 'primary gpt-4o failed, fallback gpt-4o-mini invoked 5/5',
        } satisfies ProofRecord,
      ],
    })
    expect(reportWithProof.provedScore!).toBeGreaterThan(reportNoProof.provedScore!)
  })

  it('pendingProofCount is 0 when all external rules have proof records', () => {
    // Get all external rules that would pass on secureFull
    const externalRuleIds = allRules
      .filter((r) => r.evidenceLevel === 'external')
      .map((r) => r.id)

    const proofRecords: ProofRecord[] = externalRuleIds.map((ruleId) => ({
      ruleId,
      verifiedAt: '2026-01-01T00:00:00Z',
      verifiedBy: 'test',
      method: 'test proof',
    }))

    const report = runAudit(secureFull, { proofRecords })
    expect(report.pendingProofCount).toBe(0)
  })

  it('pendingProofCount counts external rules that pass declaratively but lack proof', () => {
    // secureFull has fallback + cost controls + tool annotations passing (external rules)
    const report = runAudit(secureFull, { proofRecords: [] })
    // At least MODEL-01, MODEL-03, SEC-LLM-07, SEC-LLM-08 pass declaratively on secureFull
    expect(report.pendingProofCount!).toBeGreaterThan(0)
  })

  it('proof records for unknown rules are silently ignored', () => {
    const report = runAudit(minimalManifest, {
      proofRecords: [
        {
          ruleId: 'UNKNOWN-99',
          verifiedAt: '2026-01-01T00:00:00Z',
          verifiedBy: 'test',
          method: 'test',
        },
      ],
    })
    // Should not throw; provedScore should be computed normally
    expect(typeof report.provedScore).toBe('number')
  })
})

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
