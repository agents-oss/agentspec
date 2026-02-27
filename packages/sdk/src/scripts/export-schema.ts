import { zodToJsonSchema } from 'zod-to-json-schema'
import { ManifestSchema } from '../schema/manifest.schema.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '../../../..')

const schema = zodToJsonSchema(ManifestSchema, {
  name: 'AgentSpec',
  $refStrategy: 'none',
})

const outDir = resolve(repoRoot, 'schemas/v1')
mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'agent.schema.json'), JSON.stringify(schema, null, 2))
console.log('✓ schemas/v1/agent.schema.json written')
