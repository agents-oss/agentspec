import type { AgentSpecManifest } from '../../schema/manifest.schema.js'
import type { AuditRule, RuleResult } from '../index.js'

export const evaluationRules: AuditRule[] = [
  {
    id: 'EVAL-01',
    pack: 'evaluation-coverage',
    title: 'Evaluation dataset declared',
    description: 'At least one evaluation dataset is required for quality assurance',
    severity: 'medium',
    evidenceLevel: 'probed',
    proofTool: 'agentspec health',
    proofToolUrl: 'https://agentspec.io/docs/reference/cli#agentspec-health',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasDataset = (manifest.spec.evaluation?.datasets?.length ?? 0) > 0
      return {
        pass: hasDataset,
        message: hasDataset ? undefined : 'No evaluation datasets declared',
        path: '/spec/evaluation/datasets',
        recommendation:
          'Add spec.evaluation.datasets with at least one .jsonl dataset',
        references: [],
      }
    },
  },

  {
    id: 'EVAL-02',
    pack: 'evaluation-coverage',
    title: 'CI gate enabled',
    description: 'Evaluation CI gate prevents regressions from reaching production',
    severity: 'medium',
    evidenceLevel: 'probed',
    proofTool: 'agentspec health',
    proofToolUrl: 'https://agentspec.io/docs/reference/cli#agentspec-health',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasCiGate = manifest.spec.evaluation?.ciGate === true
      return {
        pass: hasCiGate,
        message: hasCiGate ? undefined : 'Evaluation CI gate is not enabled',
        path: '/spec/evaluation/ciGate',
        recommendation: 'Set spec.evaluation.ciGate: true',
        references: [],
      }
    },
  },

  {
    id: 'EVAL-03',
    pack: 'evaluation-coverage',
    title: 'Hallucination metric threshold configured',
    description: 'A hallucination threshold below 0.1 is required for production agents',
    severity: 'medium',
    evidenceLevel: 'probed',
    proofTool: 'agentspec health',
    proofToolUrl: 'https://agentspec.io/docs/reference/cli#agentspec-health',
    check(manifest: AgentSpecManifest): RuleResult {
      const metrics = manifest.spec.evaluation?.metrics ?? []
      const hasHallucinationMetric = metrics.includes('hallucination')
      const threshold = manifest.spec.evaluation?.thresholds?.['hallucination']
      const pass = hasHallucinationMetric && threshold !== undefined
      return {
        pass,
        message: pass
          ? undefined
          : !hasHallucinationMetric
            ? 'hallucination metric not in spec.evaluation.metrics'
            : 'No hallucination threshold configured',
        path: '/spec/evaluation/thresholds/hallucination',
        recommendation:
          'Add hallucination to spec.evaluation.metrics and set spec.evaluation.thresholds.hallucination: 0.05',
        references: [],
      }
    },
  },
]
