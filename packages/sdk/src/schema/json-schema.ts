import { zodToJsonSchema } from 'zod-to-json-schema'
import { ManifestSchema } from './manifest.schema.js'

/**
 * Export the AgentSpec manifest as a JSON Schema.
 * Used for IDE autocompletion and editor validation.
 */
export function exportJsonSchema(): object {
  return zodToJsonSchema(ManifestSchema, {
    name: 'AgentSpecManifest',
    $refStrategy: 'none',
  })
}
