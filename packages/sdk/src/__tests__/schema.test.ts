import { describe, it, expect } from 'vitest'
import { ManifestSchema } from '../schema/manifest.schema.js'
import { ZodError } from 'zod'

const minimalManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'test-agent',
    version: '1.0.0',
    description: 'A test agent',
  },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
    },
    prompts: {
      system: '$file:prompts/system.md',
    },
  },
}

describe('ManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    const result = ManifestSchema.safeParse(minimalManifest)
    expect(result.success).toBe(true)
  })

  it('rejects wrong apiVersion', () => {
    const result = ManifestSchema.safeParse({
      ...minimalManifest,
      apiVersion: 'v1',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing metadata.name', () => {
    const result = ManifestSchema.safeParse({
      ...minimalManifest,
      metadata: { version: '1.0.0', description: 'no name' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid semver version', () => {
    const result = ManifestSchema.safeParse({
      ...minimalManifest,
      metadata: { ...minimalManifest.metadata, version: 'v1' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-slug agent name', () => {
    const result = ManifestSchema.safeParse({
      ...minimalManifest,
      metadata: { ...minimalManifest.metadata, name: 'My Agent!' },
    })
    expect(result.success).toBe(false)
  })

  it('accepts a full manifest with all optional fields', () => {
    const full = {
      ...minimalManifest,
      spec: {
        ...minimalManifest.spec,
        model: {
          ...minimalManifest.spec.model,
          parameters: { temperature: 0.3, maxTokens: 500 },
          fallback: {
            provider: 'azure',
            id: 'gpt-4',
            apiKey: '$env:AZURE_OPENAI_API_KEY',
            triggerOn: ['rate_limit', 'timeout'],
            maxRetries: 2,
          },
          costControls: { maxMonthlyUSD: 200, alertAtUSD: 150 },
        },
        tools: [
          {
            name: 'create-expense',
            type: 'function',
            description: 'Create expense',
            module: '$file:tools/expenses.py',
            function: 'create_expense',
            annotations: { readOnlyHint: false, destructiveHint: false },
          },
        ],
        memory: {
          shortTerm: {
            backend: 'redis',
            maxTurns: 20,
            maxTokens: 8000,
            ttlSeconds: 3600,
            connection: '$env:REDIS_URL',
          },
        },
        guardrails: {
          input: [
            {
              type: 'topic-filter',
              blockedTopics: ['illegal_activity'],
              action: 'reject',
              message: 'Not allowed',
            },
          ],
          output: [
            {
              type: 'toxicity-filter',
              threshold: 0.7,
              action: 'reject',
            },
          ],
        },
      },
    }
    const result = ManifestSchema.safeParse(full)
    expect(result.success).toBe(true)
  })
})
