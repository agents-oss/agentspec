import type { AgentSpecManifest } from '../../schema/manifest.schema.js'
import type { AuditRule, RuleResult } from '../index.js'

export const modelRules: AuditRule[] = [
  {
    id: 'MODEL-01',
    pack: 'model-resilience',
    title: 'Model fallback declared',
    description: 'A fallback model should be configured to handle rate limits and errors',
    severity: 'high',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasFallback = !!manifest.spec.model.fallback
      return {
        pass: hasFallback,
        message: hasFallback
          ? undefined
          : 'No fallback model declared. Configure spec.model.fallback',
        path: '/spec/model/fallback',
        recommendation: 'Add a fallback model with triggerOn: [rate_limit, timeout, error_5xx]',
        references: [],
      }
    },
  },

  {
    id: 'MODEL-02',
    pack: 'model-resilience',
    title: 'Model version pinned',
    description: 'Model ID should not use "latest" — pin a specific version for reproducibility',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const id = manifest.spec.model.id
      const isLatest = id === 'latest' || id.endsWith(':latest')
      return {
        pass: !isLatest,
        message: isLatest
          ? `Model ID "${id}" uses "latest" — this is not reproducible`
          : undefined,
        path: '/spec/model/id',
        recommendation: 'Pin a specific model version, e.g. "llama-3.3-70b-versatile" or "gpt-4-0125-preview"',
        references: [],
      }
    },
  },

  {
    id: 'MODEL-03',
    pack: 'model-resilience',
    title: 'Cost controls declared',
    description: 'Monthly cost limits prevent unexpected API bills',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasCostControls = !!manifest.spec.model.costControls?.maxMonthlyUSD
      return {
        pass: hasCostControls,
        message: hasCostControls
          ? undefined
          : 'No cost controls declared. Configure spec.model.costControls',
        path: '/spec/model/costControls',
        recommendation: 'Add costControls.maxMonthlyUSD and costControls.alertAtUSD',
        references: [],
      }
    },
  },

  {
    id: 'MODEL-04',
    pack: 'model-resilience',
    title: 'Fallback retry strategy configured',
    description: 'Fallback should have maxRetries to avoid infinite loops',
    severity: 'low',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      if (!manifest.spec.model.fallback) return { pass: true }
      const hasRetries = manifest.spec.model.fallback.maxRetries !== undefined
      return {
        pass: hasRetries,
        message: hasRetries
          ? undefined
          : 'Fallback model has no maxRetries configured',
        path: '/spec/model/fallback/maxRetries',
        recommendation: 'Add maxRetries: 2 to spec.model.fallback',
        references: [],
      }
    },
  },
]
