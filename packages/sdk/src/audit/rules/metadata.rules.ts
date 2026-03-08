import type { AgentSpecManifest } from '../../schema/manifest.schema.js'
import type { AuditRule, RuleResult } from '../index.js'

export const metadataRules: AuditRule[] = [
  {
    id: 'META-01',
    pack: 'metadata-quality',
    title: 'Agent description declared',
    description: 'Agents should have a non-empty description for fleet discovery and documentation',
    severity: 'low',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const desc = manifest.metadata.description
      const pass = typeof desc === 'string' && desc.trim().length > 0
      return {
        pass,
        message: pass
          ? undefined
          : 'No description declared in metadata. Agents without descriptions are hard to discover in a fleet.',
        path: '/metadata/description',
        recommendation:
          'Add a concise metadata.description explaining what the agent does',
        references: [],
      }
    },
  },

  {
    id: 'META-02',
    pack: 'metadata-quality',
    title: 'Model temperature is production-safe',
    description: 'Temperature above 1.5 causes unpredictable outputs that are unsuitable for production',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const temperature = manifest.spec.model.parameters?.temperature
      if (temperature === undefined) return { pass: true }
      const pass = temperature <= 1.5
      return {
        pass,
        message: pass
          ? undefined
          : `Model temperature is ${temperature} — values above 1.5 produce unreliable outputs in production.`,
        path: '/spec/model/parameters/temperature',
        recommendation:
          'Set spec.model.parameters.temperature to 1.0 or lower for production agents',
        references: [],
      }
    },
  },
]
