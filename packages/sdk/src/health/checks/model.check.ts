import type { AgentSpecModel } from '../../schema/manifest.schema.js'
import type { HealthCheck } from '../index.js'

const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  azure: 'https://management.azure.com',
  google: 'https://generativelanguage.googleapis.com',
  mistral: 'https://api.mistral.ai/v1/models',
  cohere: 'https://api.cohere.ai/v1',
  together: 'https://api.together.xyz/v1/models',
  fireworks: 'https://api.fireworks.ai/inference/v1/models',
}

async function checkModelEndpoint(
  provider: string,
  apiKey: string,
  timeoutMs = 5000,
): Promise<{ reachable: boolean; latencyMs?: number; error?: string }> {
  const url = PROVIDER_ENDPOINTS[provider.toLowerCase()]
  if (!url) {
    return {
      reachable: true, // Unknown provider — assume reachable, can't check
    }
  }

  const start = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
    if (provider.toLowerCase() === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      delete headers['Authorization']
    }

    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    const latencyMs = Date.now() - start

    // 200 or 401 means the endpoint is reachable (401 = bad key, but server is up)
    return {
      reachable: res.status !== 0,
      latencyMs,
      error: res.status >= 500 ? `HTTP ${res.status}` : undefined,
    }
  } catch (err) {
    const latencyMs = Date.now() - start
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return {
      reachable: false,
      latencyMs,
      error: isTimeout ? 'Request timed out' : String(err),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function runModelChecks(model: AgentSpecModel): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = []

  // Resolve the api key (it may already be resolved or raw $env:)
  const apiKey = model.apiKey.startsWith('$') ? '' : model.apiKey

  if (apiKey) {
    const { reachable, latencyMs, error } = await checkModelEndpoint(model.provider, apiKey)
    checks.push({
      id: `model:${model.provider}/${model.id}`,
      category: 'model',
      status: reachable ? 'pass' : 'fail',
      severity: 'error',
      latencyMs,
      message: reachable
        ? undefined
        : `Model endpoint for ${model.provider} is unreachable: ${error}`,
      remediation: reachable
        ? undefined
        : `Check that ${model.apiKey} is set and the ${model.provider} API is reachable`,
    })
  } else {
    // API key is unresolved — env check will catch it
    checks.push({
      id: `model:${model.provider}/${model.id}`,
      category: 'model',
      status: 'skip',
      severity: 'error',
      message: `Cannot check model endpoint: API key reference not resolved (${model.apiKey})`,
    })
  }

  // Check fallback model
  if (model.fallback) {
    const fallbackKey = model.fallback.apiKey.startsWith('$') ? '' : model.fallback.apiKey
    if (fallbackKey) {
      const { reachable, latencyMs, error } = await checkModelEndpoint(
        model.fallback.provider,
        fallbackKey,
      )
      checks.push({
        id: `model-fallback:${model.fallback.provider}/${model.fallback.id}`,
        category: 'model-fallback',
        status: reachable ? 'pass' : 'fail',
        severity: 'warning',
        latencyMs,
        message: reachable
          ? undefined
          : `Fallback model endpoint unreachable: ${error}`,
        remediation: reachable
          ? undefined
          : `Check that ${model.fallback.apiKey} is set and ${model.fallback.provider} API is reachable`,
      })
    } else {
      checks.push({
        id: `model-fallback:${model.fallback.provider}/${model.fallback.id}`,
        category: 'model-fallback',
        status: 'skip',
        severity: 'warning',
        message: `Cannot check fallback model: API key not resolved (${model.fallback.apiKey})`,
      })
    }
  }

  return checks
}
