import { zodToJsonSchema } from 'zod-to-json-schema'
import { ManifestSchema } from '../schema/manifest.schema.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '../../../..')

/**
 * Post-process the generated JSON Schema to add `discriminator` annotations to
 * every `anyOf` whose branches are discriminated by a `properties.type.const`.
 *
 * Without this, the `redhat.vscode-yaml` JSON Schema Language Server validates
 * objects against ALL `anyOf` branches instead of just the matching one, causing
 * false "property not allowed" errors on valid discriminated-union values (e.g.
 * guardrail items). Adding `discriminator` tells the LS to select the correct
 * branch by the `type` field — matching Zod's own `z.discriminatedUnion` behaviour.
 */
function addDiscriminators(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node

  const obj = node as Record<string, unknown>

  // Recursively process child nodes first
  for (const key of Object.keys(obj)) {
    obj[key] = addDiscriminators(obj[key])
  }

  // If this node has an anyOf where every branch has properties.type.const,
  // it is a discriminated union — annotate it so validators pick the right branch.
  if (Array.isArray(obj['anyOf'])) {
    const branches = obj['anyOf'] as unknown[]
    const allDiscriminated = branches.every((branch) => {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return false
      const b = branch as Record<string, unknown>
      const props = b['properties'] as Record<string, unknown> | undefined
      return props?.['type'] && typeof (props['type'] as Record<string, unknown>)['const'] === 'string'
    })
    if (allDiscriminated) {
      obj['discriminator'] = { propertyName: 'type' }
    }
  }

  return obj
}

const raw = zodToJsonSchema(ManifestSchema, {
  name: 'AgentSpec',
  $refStrategy: 'none',
})

const schema = addDiscriminators(raw)

const outDir = resolve(repoRoot, 'schemas/v1')
mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'agent.schema.json'), JSON.stringify(schema, null, 2))
console.log('✓ schemas/v1/agent.schema.json written')
