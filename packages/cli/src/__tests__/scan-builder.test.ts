/**
 * Tests for scan-builder.ts — slugify() and buildManifestFromDetection().
 *
 * Coverage target: 100% — this is deterministic, business-critical logic.
 */

import { describe, expect, it } from 'vitest'
import { ManifestSchema } from '@agentspec/sdk'
import { slugify, buildManifestFromDetection, type ScanDetection } from '../commands/scan-builder.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal valid detection — model + description only. */
const minimalDetection: ScanDetection = {
  name: 'my-agent',
  description: 'A simple test agent',
  modelProvider: 'openai',
  modelId: 'gpt-4o-mini',
  modelApiKeyEnv: 'OPENAI_API_KEY',
  envVars: ['OPENAI_API_KEY'],
}

/** Fully populated detection — exercises every builder branch. */
const fullDetection: ScanDetection = {
  name: 'budget_bud',
  description: 'A personal finance assistant',
  version: '1.2.0',
  tags: ['finance', 'rag'],
  modelProvider: 'groq',
  modelId: 'llama-3.3-70b-versatile',
  modelApiKeyEnv: 'GROQ_API_KEY',
  modelTemperature: 0.5,
  modelMaxTokens: 8192,
  fallbackProvider: 'openai',
  fallbackModelId: 'gpt-4o-mini',
  fallbackApiKeyEnv: 'OPENAI_API_KEY',
  promptFile: 'app/prompts/system.txt',
  tools: [
    { name: 'create_expense', description: 'Create an expense record', destructive: false, idempotent: true },
    { name: 'get_balance', description: 'Get current balance', readOnly: true },
  ],
  shortTermBackend: 'redis',
  shortTermConnectionEnv: 'REDIS_URL',
  shortTermMaxTurns: 20,
  shortTermTtlSeconds: 3600,
  longTermBackend: 'postgres',
  longTermConnectionStringEnv: 'DATABASE_URL',
  hasPromptInjection: true,
  hasTopicFilter: true,
  blockedTopics: ['politics', 'religion'],
  hasToxicityFilter: true,
  toxicityThreshold: 0.75,
  hasPiiDetector: true,
  hasRestApi: true,
  apiStreaming: true,
  apiAuthType: 'jwt',
  apiPort: 8000,
  tracingBackend: 'langfuse',
  metricsBackend: 'opentelemetry',
  loggingStructured: true,
  envVars: ['GROQ_API_KEY', 'REDIS_URL', 'DATABASE_URL'],
  services: [
    { type: 'postgres', connectionEnv: 'DATABASE_URL' },
    { type: 'redis', connectionEnv: 'REDIS_URL' },
  ],
}

// ── slugify() ─────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('converts underscores to hyphens', () => {
    expect(slugify('create_expense')).toBe('create-expense')
  })

  it('lowercases all characters', () => {
    expect(slugify('BudgetBud')).toBe('budgetbud')
  })

  it('collapses multiple consecutive hyphens', () => {
    expect(slugify('my--agent')).toBe('my-agent')
  })

  it('strips leading hyphens', () => {
    expect(slugify('--leading')).toBe('leading')
  })

  it('converts spaces and special chars to hyphens', () => {
    expect(slugify('hello world!')).toBe('hello-world')
  })
})

// ── buildManifestFromDetection() ─────────────────────────────────────────────

describe('buildManifestFromDetection — top-level structure', () => {
  it('sets apiVersion: "agentspec.io/v1"', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.apiVersion).toBe('agentspec.io/v1')
  })

  it('sets kind: "AgentSpec"', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.kind).toBe('AgentSpec')
  })
})

describe('buildManifestFromDetection — metadata', () => {
  it('slugifies metadata.name', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, name: 'BudgetBud_Agent' })
    expect(result.metadata.name).toBe('budgetbud-agent')
  })

  it('defaults metadata.version to "0.1.0" when not provided', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.metadata.version).toBe('0.1.0')
  })

  it('uses provided version when present', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, version: '2.0.0' })
    expect(result.metadata.version).toBe('2.0.0')
  })

  it('includes tags when provided', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, tags: ['finance'] })
    expect(result.metadata.tags).toEqual(['finance'])
  })

  it('omits tags when not provided', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.metadata.tags).toBeUndefined()
  })
})

describe('buildManifestFromDetection — model', () => {
  it('sets spec.model.id (never model.name)', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.model.id).toBe('gpt-4o-mini')
    expect((result.spec.model as Record<string, unknown>).name).toBeUndefined()
  })

  it('formats spec.model.apiKey as "$env:..." reference', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, modelApiKeyEnv: 'GROQ_API_KEY' })
    expect(result.spec.model.apiKey).toBe('$env:GROQ_API_KEY')
  })

  it('includes model parameters when temperature provided', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, modelTemperature: 0.3 })
    expect(result.spec.model.parameters?.temperature).toBe(0.3)
  })

  it('includes model parameters when maxTokens provided', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, modelMaxTokens: 4096 })
    expect(result.spec.model.parameters?.maxTokens).toBe(4096)
  })

  it('omits model parameters when neither temperature nor maxTokens provided', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.model.parameters).toBeUndefined()
  })
})

describe('buildManifestFromDetection — model fallback', () => {
  const withFallback: ScanDetection = {
    ...minimalDetection,
    fallbackProvider: 'groq',
    fallbackModelId: 'llama-3.3-70b-versatile',
    fallbackApiKeyEnv: 'GROQ_API_KEY',
  }

  it('sets fallback.id field (never fallback.name)', () => {
    const result = buildManifestFromDetection(withFallback)
    expect(result.spec.model.fallback?.id).toBe('llama-3.3-70b-versatile')
    expect((result.spec.model.fallback as Record<string, unknown> | undefined)?.name).toBeUndefined()
  })

  it('sets fallback.triggerOn to [rate_limit, timeout, error_5xx]', () => {
    const result = buildManifestFromDetection(withFallback)
    expect(result.spec.model.fallback?.triggerOn).toEqual(['rate_limit', 'timeout', 'error_5xx'])
  })

  it('formats fallback.apiKey as "$env:..." reference', () => {
    const result = buildManifestFromDetection(withFallback)
    expect(result.spec.model.fallback?.apiKey).toBe('$env:GROQ_API_KEY')
  })

  it('uses modelApiKeyEnv for fallback when fallbackApiKeyEnv not provided', () => {
    const { fallbackApiKeyEnv: _omit, ...noFallbackKeyEnv } = withFallback
    const result = buildManifestFromDetection(noFallbackKeyEnv)
    expect(result.spec.model.fallback?.apiKey).toBe(`$env:${minimalDetection.modelApiKeyEnv}`)
  })

  it('omits fallback when not detected', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.model.fallback).toBeUndefined()
  })
})

describe('buildManifestFromDetection — prompts', () => {
  it('spec.prompts is always present', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.prompts).toBeDefined()
  })

  it('defaults prompts.system to "$file:system.md"', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.prompts.system).toBe('$file:system.md')
  })

  it('uses detected promptFile when provided', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, promptFile: 'app/prompts/system.txt' })
    expect(result.spec.prompts.system).toBe('$file:app/prompts/system.txt')
  })
})

describe('buildManifestFromDetection — tools', () => {
  it('adds type: "function" to each tool automatically', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'search', description: 'Search the web' }],
    })
    expect(result.spec.tools?.[0].type).toBe('function')
  })

  it('slugifies tool names', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'create_expense', description: 'Create expense' }],
    })
    expect(result.spec.tools?.[0].name).toBe('create-expense')
  })

  it('omits tools when none detected', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.tools).toBeUndefined()
  })

  it('maps readOnly to annotations.readOnlyHint', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'get-data', description: 'Read data', readOnly: true }],
    })
    expect(result.spec.tools?.[0].annotations?.readOnlyHint).toBe(true)
  })

  it('maps destructive to annotations.destructiveHint', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'delete-record', description: 'Delete a record', destructive: true }],
    })
    expect(result.spec.tools?.[0].annotations?.destructiveHint).toBe(true)
  })

  it('maps idempotent to annotations.idempotentHint', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'upsert-record', description: 'Upsert record', idempotent: true }],
    })
    expect(result.spec.tools?.[0].annotations?.idempotentHint).toBe(true)
  })

  it('omits annotations when not provided', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'search', description: 'Search' }],
    })
    expect(result.spec.tools?.[0].annotations).toBeUndefined()
  })

  it('prefixes module with $file: when provided', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'create_expense', description: 'Create expense', module: 'app/tools/expense.py' }],
    })
    expect(result.spec.tools?.[0].module).toBe('$file:app/tools/expense.py')
  })

  it('passes function name through as-is', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'create_expense', description: 'Create expense', function: 'create_expense' }],
    })
    expect(result.spec.tools?.[0].function).toBe('create_expense')
  })

  it('omits module and function when not provided', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      tools: [{ name: 'search', description: 'Search' }],
    })
    expect(result.spec.tools?.[0].module).toBeUndefined()
    expect(result.spec.tools?.[0].function).toBeUndefined()
  })
})

describe('buildManifestFromDetection — memory', () => {
  it('builds shortTerm for redis with connection', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      shortTermBackend: 'redis',
      shortTermConnectionEnv: 'REDIS_URL',
    })
    expect(result.spec.memory?.shortTerm?.backend).toBe('redis')
    expect(result.spec.memory?.shortTerm?.connection).toBe('$env:REDIS_URL')
  })

  it('omits connection for in-memory backend', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      shortTermBackend: 'in-memory',
    })
    expect(result.spec.memory?.shortTerm?.backend).toBe('in-memory')
    expect(result.spec.memory?.shortTerm?.connection).toBeUndefined()
  })

  it('builds longTerm for postgres with connectionString', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      longTermBackend: 'postgres',
      longTermConnectionStringEnv: 'DATABASE_URL',
    })
    expect(result.spec.memory?.longTerm?.backend).toBe('postgres')
    expect(result.spec.memory?.longTerm?.connectionString).toBe('$env:DATABASE_URL')
  })

  it('omits memory when neither shortTerm nor longTerm detected', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.memory).toBeUndefined()
  })

  it('includes shortTerm maxTurns and ttlSeconds when provided', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      shortTermBackend: 'redis',
      shortTermConnectionEnv: 'REDIS_URL',
      shortTermMaxTurns: 20,
      shortTermTtlSeconds: 3600,
    })
    expect(result.spec.memory?.shortTerm?.maxTurns).toBe(20)
    expect(result.spec.memory?.shortTerm?.ttlSeconds).toBe(3600)
  })
})

describe('buildManifestFromDetection — guardrails', () => {
  it('builds input guardrail array with prompt-injection entry', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, hasPromptInjection: true })
    expect(result.spec.guardrails?.input).toEqual(
      expect.arrayContaining([{ type: 'prompt-injection', action: 'reject' }]),
    )
  })

  it('builds output guardrail array with toxicity-filter entry', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      hasToxicityFilter: true,
      toxicityThreshold: 0.7,
    })
    expect(result.spec.guardrails?.output).toEqual(
      expect.arrayContaining([{ type: 'toxicity-filter', threshold: 0.7, action: 'reject' }]),
    )
  })

  it('defaults toxicityThreshold to 0.8 when not specified', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, hasToxicityFilter: true })
    expect(result.spec.guardrails?.output?.[0]).toMatchObject({ threshold: 0.8 })
  })

  it('omits guardrails when none detected', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.guardrails).toBeUndefined()
  })
})

describe('buildManifestFromDetection — requires', () => {
  it('uses requires.envVars (never requires.env)', () => {
    const result = buildManifestFromDetection(minimalDetection)
    expect(result.spec.requires?.envVars).toEqual(['OPENAI_API_KEY'])
    expect((result.spec.requires as Record<string, unknown> | undefined)?.env).toBeUndefined()
  })

  it('builds services with connection as "$env:..." reference', () => {
    const result = buildManifestFromDetection({
      ...minimalDetection,
      services: [{ type: 'postgres', connectionEnv: 'DATABASE_URL' }],
    })
    expect(result.spec.requires?.services).toEqual([
      { type: 'postgres', connection: '$env:DATABASE_URL' },
    ])
  })

  it('omits requires when envVars is empty and no services detected', () => {
    const result = buildManifestFromDetection({ ...minimalDetection, envVars: [] })
    expect(result.spec.requires).toBeUndefined()
  })
})

describe('buildManifestFromDetection — schema validation', () => {
  it('fully-populated detection produces a schema-valid manifest', () => {
    const result = buildManifestFromDetection(fullDetection)
    const parsed = ManifestSchema.safeParse(result)
    if (!parsed.success) {
      // Print errors for easier debugging when this test fails
      console.error(parsed.error.errors)
    }
    expect(parsed.success).toBe(true)
  })

  it('minimal detection (model only) produces a schema-valid manifest', () => {
    const result = buildManifestFromDetection(minimalDetection)
    const parsed = ManifestSchema.safeParse(result)
    if (!parsed.success) {
      console.error(parsed.error.errors)
    }
    expect(parsed.success).toBe(true)
  })
})
