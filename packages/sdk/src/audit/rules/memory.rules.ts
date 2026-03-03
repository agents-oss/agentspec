import type { AgentSpecManifest } from '../../schema/manifest.schema.js'
import type { AuditRule, RuleResult } from '../index.js'

export const memoryRules: AuditRule[] = [
  {
    id: 'MEM-01',
    pack: 'memory-hygiene',
    title: 'PII scrub fields declared for long-term memory',
    description:
      'Agents with long-term memory must declare which fields to scrub for PII compliance',
    severity: 'critical',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      if (!manifest.spec.memory?.longTerm) return { pass: true }
      const hasScrub = (manifest.spec.memory.hygiene?.piiScrubFields?.length ?? 0) > 0
      return {
        pass: hasScrub,
        message: hasScrub
          ? undefined
          : 'Long-term memory enabled without PII scrub fields',
        path: '/spec/memory/hygiene/piiScrubFields',
        recommendation:
          'Add spec.memory.hygiene.piiScrubFields: [ssn, credit_card, bank_account]',
        references: [],
      }
    },
  },

  {
    id: 'MEM-02',
    pack: 'memory-hygiene',
    title: 'Retention policy / TTL set for all memory backends',
    description: 'Memory without TTL grows unbounded and increases PII exposure risk',
    severity: 'high',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const mem = manifest.spec.memory
      if (!mem) return { pass: true }

      const stOk = !mem.shortTerm || mem.shortTerm.ttlSeconds !== undefined
      const ltOk = !mem.longTerm || mem.longTerm.ttlDays !== undefined

      const pass = stOk && ltOk
      return {
        pass,
        message: pass
          ? undefined
          : [
              !stOk ? 'Short-term memory has no ttlSeconds' : '',
              !ltOk ? 'Long-term memory has no ttlDays' : '',
            ]
              .filter(Boolean)
              .join('; '),
        path: '/spec/memory',
        recommendation:
          'Set spec.memory.shortTerm.ttlSeconds and spec.memory.longTerm.ttlDays',
        references: [],
      }
    },
  },

  {
    id: 'MEM-03',
    pack: 'memory-hygiene',
    title: 'Audit log enabled for long-term memory',
    description:
      'Audit logging enables compliance investigations and debugging',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      if (!manifest.spec.memory?.longTerm) return { pass: true }
      const hasAuditLog = manifest.spec.memory.hygiene?.auditLog === true
      return {
        pass: hasAuditLog,
        message: hasAuditLog
          ? undefined
          : 'Long-term memory enabled without audit log',
        path: '/spec/memory/hygiene/auditLog',
        recommendation: 'Set spec.memory.hygiene.auditLog: true',
        references: [],
      }
    },
  },

  {
    id: 'MEM-04',
    pack: 'memory-hygiene',
    title: 'Vector store namespace isolated',
    description:
      'Shared vector store namespaces risk data leakage between agents',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      if (!manifest.spec.memory?.vector) return { pass: true }
      const hasNamespace = !!manifest.spec.memory.vector.namespace
      return {
        pass: hasNamespace,
        message: hasNamespace
          ? undefined
          : 'Vector store has no namespace — may share space with other agents',
        path: '/spec/memory/vector/namespace',
        recommendation:
          `Add spec.memory.vector.namespace: "${manifest.metadata.name}"`,
        references: [],
      }
    },
  },

  {
    id: 'MEM-05',
    pack: 'memory-hygiene',
    title: 'Short-term memory max tokens bounded',
    description: 'Unbounded short-term memory can cause token budget overruns',
    severity: 'low',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      if (!manifest.spec.memory?.shortTerm) return { pass: true }
      const hasBound = manifest.spec.memory.shortTerm.maxTokens !== undefined
      return {
        pass: hasBound,
        message: hasBound
          ? undefined
          : 'Short-term memory has no maxTokens bound',
        path: '/spec/memory/shortTerm/maxTokens',
        recommendation: 'Set spec.memory.shortTerm.maxTokens: 8000',
        references: [],
      }
    },
  },
]
