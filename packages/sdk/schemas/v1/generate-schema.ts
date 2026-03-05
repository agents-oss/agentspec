/**
 * Script: generate-schema.ts
 * Exports the AgentSpec manifest Zod schema to JSON Schema for IDE autocomplete.
 *
 * Usage: npx tsx schemas/v1/generate-schema.ts
 */

import { writeFileSync } from 'node:fs'
import { exportJsonSchema } from '../../packages/sdk/src/schema/json-schema.js'

const schema = exportJsonSchema()
const json = JSON.stringify(schema, null, 2)

writeFileSync('./schemas/v1/agent.schema.json', json, 'utf-8')
console.log('✓ JSON Schema written to schemas/v1/agent.schema.json')
console.log('  Add to your IDE settings for agent.yaml autocomplete.')
