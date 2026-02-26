import type { AgentSpecManifest } from '../../schema/manifest.schema.js'
import type { AuditRule, RuleResult } from '../index.js'

export const observabilityRules: AuditRule[] = [
  {
    id: 'OBS-01',
    pack: 'observability',
    title: 'Tracing backend declared',
    description: 'Agents should declare a tracing backend so runs are observable and debuggable',
    severity: 'medium',
    check(manifest: AgentSpecManifest): RuleResult {
      const pass = !!manifest.spec.observability?.tracing?.backend
      return {
        pass,
        message: pass
          ? undefined
          : 'No tracing backend configured — agent runs are unobservable.',
        path: '/spec/observability/tracing/backend',
        recommendation:
          'Add spec.observability.tracing.backend (langfuse, langsmith, agentops, otel)',
      }
    },
  },

  {
    id: 'OBS-02',
    pack: 'observability',
    title: 'Structured logging enabled',
    description: 'Structured logging makes log aggregation and searching reliable',
    severity: 'low',
    check(manifest: AgentSpecManifest): RuleResult {
      const pass = manifest.spec.observability?.logging?.structured !== false
      return {
        pass,
        message: pass ? undefined : 'Structured logging is disabled.',
        path: '/spec/observability/logging/structured',
        recommendation: 'Set spec.observability.logging.structured: true',
      }
    },
  },

  {
    id: 'OBS-03',
    pack: 'observability',
    title: 'Sensitive fields redacted from logs',
    description: 'Log redaction prevents secrets and PII from appearing in log aggregators',
    severity: 'medium',
    check(manifest: AgentSpecManifest): RuleResult {
      const pass = (manifest.spec.observability?.logging?.redactFields?.length ?? 0) > 0
      return {
        pass,
        message: pass
          ? undefined
          : 'No log redaction fields declared — sensitive data may appear in logs.',
        path: '/spec/observability/logging/redactFields',
        recommendation:
          'Add spec.observability.logging.redactFields: [api_key, account_number, ...]',
      }
    },
  },
]
