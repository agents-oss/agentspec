import type { Migration } from './index.js'

/**
 * Migrates manifests from agentspec/v1alpha1 (pre-release) to agentspec.io/v1 (stable).
 *
 * Changes:
 * - apiVersion: agentspec/v1alpha1 → agentspec.io/v1
 * - kind defaults to 'AgentSpec' if missing
 */
export const v1alpha1ToV1: Migration = {
  from: 'agentspec/v1alpha1',
  to: 'agentspec.io/v1',

  migrate(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      ...raw,
      apiVersion: 'agentspec.io/v1',
      kind: raw.kind ?? 'AgentSpec',
    }
  },
}
