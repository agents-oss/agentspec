/**
 * Deterministic manifest builder for `agentspec scan`.
 *
 * Design: Claude detects raw facts about the source code (ScanDetection JSON).
 * This module turns those facts into a valid AgentSpecManifest — pure TypeScript,
 * zero LLM involvement, compile-time schema correctness guaranteed by the types.
 *
 * Thin orchestrator + named helpers pattern (see CLAUDE.md).
 */

import type {
  AgentSpecManifest,
  AgentSpecCompliance,
} from '@agentspec/sdk'

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * The raw facts Claude detects from source code.
 * All string values are unprocessed (slugify is TypeScript's job).
 * Omit unknown fields rather than guessing.
 */
export interface ScanDetection {
  name: string                    // raw agent name — builder will slugify
  description: string
  version?: string                // semver default "0.1.0"
  tags?: string[]
  modelProvider: string
  modelId: string
  modelApiKeyEnv: string
  modelTemperature?: number
  modelMaxTokens?: number
  fallbackProvider?: string
  fallbackModelId?: string
  fallbackApiKeyEnv?: string
  promptFile?: string             // e.g. "app/prompts/system.txt"
  tools?: Array<{
    name: string                  // raw — builder will slugify
    description: string
    module?: string               // raw file path, e.g. "app/tools/expense.py" — builder adds $file:
    function?: string             // callable name, e.g. "create_expense"
    readOnly?: boolean
    destructive?: boolean
    idempotent?: boolean
  }>
  shortTermBackend?: 'redis' | 'in-memory' | 'sqlite'
  shortTermConnectionEnv?: string
  shortTermMaxTurns?: number
  shortTermTtlSeconds?: number
  longTermBackend?: 'postgres' | 'sqlite' | 'mongodb'
  longTermConnectionStringEnv?: string
  hasPromptInjection?: boolean
  hasTopicFilter?: boolean
  blockedTopics?: string[]
  hasToxicityFilter?: boolean
  toxicityThreshold?: number
  hasPiiDetector?: boolean
  hasRestApi?: boolean
  apiStreaming?: boolean
  apiAuthType?: 'jwt' | 'apikey' | 'oauth2' | 'none'
  apiPort?: number
  tracingBackend?: 'langfuse' | 'langsmith' | 'agentops' | 'otel' | 'honeycomb' | 'datadog'
  metricsBackend?: 'opentelemetry' | 'prometheus' | 'datadog'
  loggingStructured?: boolean
  envVars: string[]
  services?: Array<{
    type: 'postgres' | 'redis' | 'mysql' | 'mongodb' | 'elasticsearch'
    connectionEnv: string
  }>
}

// ── Private helpers ────────────────────────────────────────────────────────────

function buildMetadata(d: ScanDetection): AgentSpecManifest['metadata'] {
  return {
    name: slugify(d.name),
    version: d.version ?? '0.1.0',
    description: d.description,
    ...(d.tags?.length ? { tags: d.tags } : {}),
  }
}

function buildModel(d: ScanDetection): AgentSpecManifest['spec']['model'] {
  const model: AgentSpecManifest['spec']['model'] = {
    provider: d.modelProvider,
    id: d.modelId,
    apiKey: `$env:${d.modelApiKeyEnv}`,
  }

  if (d.modelTemperature !== undefined || d.modelMaxTokens !== undefined) {
    model.parameters = {
      ...(d.modelTemperature !== undefined ? { temperature: d.modelTemperature } : {}),
      ...(d.modelMaxTokens !== undefined ? { maxTokens: d.modelMaxTokens } : {}),
    }
  }

  if (d.fallbackProvider && d.fallbackModelId) {
    model.fallback = {
      provider: d.fallbackProvider,
      id: d.fallbackModelId,
      apiKey: `$env:${d.fallbackApiKeyEnv ?? d.modelApiKeyEnv}`,
      triggerOn: ['rate_limit', 'timeout', 'error_5xx'],
    }
  }

  return model
}

function buildPrompts(d: ScanDetection): AgentSpecManifest['spec']['prompts'] {
  return {
    system: d.promptFile ? `$file:${d.promptFile}` : '$file:system.md',
  }
}

function buildTools(d: ScanDetection): AgentSpecManifest['spec']['tools'] {
  if (!d.tools?.length) return undefined
  return d.tools.map(t => ({
    name: slugify(t.name),
    type: 'function' as const,
    description: t.description,
    ...(t.module ? { module: `$file:${t.module}` } : {}),
    ...(t.function ? { function: t.function } : {}),
    ...(t.readOnly !== undefined || t.destructive !== undefined || t.idempotent !== undefined
      ? {
          annotations: {
            ...(t.readOnly !== undefined ? { readOnlyHint: t.readOnly } : {}),
            ...(t.destructive !== undefined ? { destructiveHint: t.destructive } : {}),
            ...(t.idempotent !== undefined ? { idempotentHint: t.idempotent } : {}),
          },
        }
      : {}),
  }))
}

function buildMemory(d: ScanDetection): AgentSpecManifest['spec']['memory'] {
  const memory: AgentSpecManifest['spec']['memory'] = {}
  let hasAny = false

  if (d.shortTermBackend) {
    hasAny = true
    const shortTerm: NonNullable<AgentSpecManifest['spec']['memory']>['shortTerm'] = {
      backend: d.shortTermBackend,
      ...(d.shortTermMaxTurns !== undefined ? { maxTurns: d.shortTermMaxTurns } : {}),
      ...(d.shortTermTtlSeconds !== undefined ? { ttlSeconds: d.shortTermTtlSeconds } : {}),
    }
    // Only include connection for backends that require a connection string
    if (d.shortTermBackend !== 'in-memory' && d.shortTermConnectionEnv) {
      shortTerm.connection = `$env:${d.shortTermConnectionEnv}`
    }
    memory.shortTerm = shortTerm
  }

  if (d.longTermBackend && d.longTermConnectionStringEnv) {
    hasAny = true
    memory.longTerm = {
      backend: d.longTermBackend,
      connectionString: `$env:${d.longTermConnectionStringEnv}`,
    }
  }

  return hasAny ? memory : undefined
}

function buildGuardrails(d: ScanDetection): AgentSpecManifest['spec']['guardrails'] {
  const input: NonNullable<AgentSpecManifest['spec']['guardrails']>['input'] = []
  const output: NonNullable<AgentSpecManifest['spec']['guardrails']>['output'] = []

  if (d.hasPromptInjection) {
    input.push({ type: 'prompt-injection', action: 'reject' })
  }
  if (d.hasTopicFilter && d.blockedTopics?.length) {
    input.push({ type: 'topic-filter', blockedTopics: d.blockedTopics, action: 'reject' })
  }
  if (d.hasPiiDetector) {
    input.push({ type: 'pii-detector', action: 'scrub' })
  }

  if (d.hasToxicityFilter) {
    output.push({
      type: 'toxicity-filter',
      threshold: d.toxicityThreshold ?? 0.8,
      action: 'reject',
    })
  }

  if (!input.length && !output.length) return undefined

  return {
    ...(input.length ? { input } : {}),
    ...(output.length ? { output } : {}),
  }
}

function buildApi(d: ScanDetection): AgentSpecManifest['spec']['api'] {
  if (!d.hasRestApi) return undefined
  return {
    type: 'rest',
    ...(d.apiPort !== undefined ? { port: d.apiPort } : {}),
    ...(d.apiAuthType ? { auth: { type: d.apiAuthType } } : {}),
    streaming: d.apiStreaming ?? false,
  }
}

function buildObservability(d: ScanDetection): AgentSpecManifest['spec']['observability'] {
  const hasTracing = !!d.tracingBackend
  const hasMetrics = !!d.metricsBackend
  const hasLogging = d.loggingStructured !== undefined

  if (!hasTracing && !hasMetrics && !hasLogging) return undefined

  return {
    ...(hasTracing
      ? { tracing: { backend: d.tracingBackend!, sampleRate: 1.0 } }
      : {}),
    ...(hasMetrics
      ? { metrics: { backend: d.metricsBackend!, serviceName: slugify(d.name) } }
      : {}),
    ...(hasLogging
      ? { logging: { structured: d.loggingStructured ?? true } }
      : {}),
  }
}

function buildCompliance(): AgentSpecCompliance {
  return {
    packs: ['owasp-llm-top10', 'model-resilience', 'memory-hygiene'],
  }
}

function buildRequires(d: ScanDetection): AgentSpecManifest['spec']['requires'] {
  const hasEnvVars = d.envVars.length > 0
  const hasServices = !!d.services?.length

  if (!hasEnvVars && !hasServices) return undefined

  return {
    ...(hasEnvVars ? { envVars: d.envVars } : {}),
    ...(hasServices
      ? {
          services: d.services!.map(s => ({
            type: s.type,
            connection: `$env:${s.connectionEnv}`,
          })),
        }
      : {}),
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert a string to a lowercase slug: `a-z`, `0-9`, hyphens only.
 * Underscores, spaces, and special chars become hyphens; multiple consecutive
 * hyphens are collapsed; leading/trailing hyphens are stripped.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // non-alphanumeric → hyphen
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-+|-+$/g, '')       // strip leading/trailing hyphens
}

/**
 * Build a valid AgentSpecManifest from a ScanDetection object.
 *
 * This is deterministic and schema-correct — Claude never touches YAML,
 * TypeScript enforces all field names and value constraints at compile time.
 */
export function buildManifestFromDetection(d: ScanDetection): AgentSpecManifest {
  return {
    apiVersion: 'agentspec.io/v1',
    kind: 'AgentSpec',
    metadata: buildMetadata(d),
    spec: {
      model: buildModel(d),
      prompts: buildPrompts(d),
      tools: buildTools(d),
      memory: buildMemory(d),
      guardrails: buildGuardrails(d),
      api: buildApi(d),
      observability: buildObservability(d),
      compliance: buildCompliance(),
      requires: buildRequires(d),
    },
  }
}
