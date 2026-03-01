import type { FastifyInstance } from 'fastify'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { config } from '../config.js'
import { probeAgent, type AgentProbeResult } from './agent-probe.js'
import { buildOPAInput, queryOPA, opaViolationsToGapIssues } from './opa-client.js'

export interface GapIssue {
  severity: 'critical' | 'high' | 'medium' | 'low'
  property: string
  description: string
  recommendation: string
}

export interface GapReport {
  score: number
  issues: GapIssue[]
  source: 'agent-sdk' | 'manifest-static'
  modelId: string
  observed: {
    hasHealthEndpoint: boolean
    hasCapabilitiesEndpoint: boolean
    upstreamTools: string[]
  }
}

async function probeUpstream(
  upstream: string,
): Promise<{ hasHealth: boolean; hasCapabilities: boolean; tools: string[] }> {
  const result = { hasHealth: false, hasCapabilities: false, tools: [] as string[] }

  try {
    const healthRes = await fetch(`${upstream}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    result.hasHealth = healthRes.ok
  } catch {
    // not reachable
  }

  try {
    const capRes = await fetch(`${upstream}/capabilities`, {
      signal: AbortSignal.timeout(5000),
    })
    if (capRes.ok) {
      result.hasCapabilities = true
      const body = (await capRes.json()) as { tools?: Array<{ name: string }> }
      result.tools = (body.tools ?? []).map((t) => t.name)
    }
  } catch {
    // not reachable
  }

  return result
}

/** Extracts the env var name from a $env:VAR_NAME reference, or null. */
function extractEnvVarName(ref: string): string | null {
  const match = ref.match(/^\$env:(.+)$/)
  return match ? (match[1] ?? null) : null
}

function buildGapMatrix(
  manifest: AgentSpecManifest,
  observed: { hasHealth: boolean; hasCapabilities: boolean; tools: string[] },
  probe: AgentProbeResult,
): GapIssue[] {
  const issues: GapIssue[] = []
  const specTools = (manifest.spec.tools ?? []).map((t) => t.name)

  if (!observed.hasHealth) {
    issues.push({
      severity: 'high',
      property: 'healthcheckable',
      description: 'Agent does not expose a /health endpoint',
      recommendation:
        'Add GET /health to your agent server; use agentspec-sidecar to provide it automatically',
    })
  }

  if (!observed.hasCapabilities) {
    issues.push({
      severity: 'medium',
      property: 'discoverable',
      description: 'Agent does not expose /capabilities or /.well-known/agent.json',
      recommendation:
        'The agentspec-sidecar /capabilities endpoint serves this automatically from agent.yaml',
    })
  }

  if (probe.sdkAvailable && probe.report) {
    // ── Live gap analysis from agent SDK ──────────────────────────────────────

    // Helper: cap strings from untrusted probe data before they enter the LLM prompt
    const cap = (s: string | undefined, fallback: string): string =>
      (s ?? fallback).slice(0, 500)

    // Model API key — live check from probe
    const modelCheck = probe.report.checks.find((c) => c.category === 'model')
    if (modelCheck?.status === 'fail') {
      issues.push({
        severity: 'critical',
        property: 'model.apiKey',
        description: cap(modelCheck.message, 'Model endpoint unreachable'),
        recommendation: cap(
          modelCheck.remediation,
          'Check model API key configuration and provider reachability',
        ),
      })
    } else if (modelCheck?.status === 'skip') {
      issues.push({
        severity: 'high',
        property: 'model.apiKey',
        description: cap(
          modelCheck.message,
          'Model endpoint check was skipped — API key may not be resolved',
        ),
        recommendation: cap(
          modelCheck.remediation,
          'Ensure the model API key environment variable is set and AgentSpecReporter is initialised with the correct manifest',
        ),
      })
    }

    // Env vars — any failing env checks from probe
    const failedEnvs = probe.report.checks.filter(
      (c) => c.category === 'env' && c.status === 'fail',
    )
    for (const env of failedEnvs) {
      issues.push({
        severity: 'high',
        property: env.id.slice(0, 100),
        description: cap(env.message, `Environment variable check failed: ${env.id}`),
        recommendation: cap(
          env.remediation,
          `Set the required environment variable referenced by ${env.id}`,
        ),
      })
    }

    // Services — any failing service checks from probe
    const failedSvcs = probe.report.checks.filter(
      (c) => c.category === 'service' && c.status === 'fail',
    )
    for (const svc of failedSvcs) {
      issues.push({
        severity: 'high',
        property: svc.id.slice(0, 100),
        description: cap(svc.message, `Service connectivity check failed: ${svc.id}`),
        recommendation: cap(
          svc.remediation,
          'Check the service connection string and ensure the service is reachable',
        ),
      })
    }

    // Tools — declared in manifest but failing in probe
    const failingTools = specTools.filter((name) =>
      probe.report!.checks.some((c) => c.id === `tool:${name}` && c.status === 'fail'),
    )
    for (const tool of failingTools) {
      issues.push({
        severity: 'medium',
        property: `tool:${tool}`,
        description: `Tool "${tool}" declared in spec but its handler is not registered in the agent`,
        recommendation: `Ensure tool "${tool}" is registered and its handler is available at runtime`,
      })
    }

    // ── Spec-vs-probe reconciliation ──────────────────────────────────────────
    // A correctly initialised AgentSpecReporter(manifest) auto-derives checks
    // for every item the manifest declares. Missing checks mean the reporter
    // was configured with a different manifest, or skipped a check step.
    const probeCheckIds = new Set(probe.report.checks.map((c) => c.id))

    // Model API key env var
    const apiKeyEnvVar = extractEnvVarName(manifest.spec.model.apiKey)
    if (apiKeyEnvVar && !probeCheckIds.has(`env:${apiKeyEnvVar}`)) {
      issues.push({
        severity: 'high',
        property: `env:${apiKeyEnvVar}`,
        description: `Spec declares model.apiKey as $env:${apiKeyEnvVar} but the SDK did not report this check`,
        recommendation: `Ensure AgentSpecReporter is initialised with the correct manifest so it checks env:${apiKeyEnvVar}`,
      })
    }

    // Declared services
    for (const svc of manifest.spec.requires?.services ?? []) {
      if (!probeCheckIds.has(`service:${svc.type}`)) {
        issues.push({
          severity: 'high',
          property: `service:${svc.type}`,
          description: `Service "${svc.type}" is declared in spec but the SDK did not report a connectivity check`,
          recommendation: `Ensure AgentSpecReporter is initialised with the correct manifest so it checks service:${svc.type}`,
        })
      }
    }

    // Declared tools — absent from probe entirely (failing tools are handled above)
    for (const toolName of specTools) {
      if (!probeCheckIds.has(`tool:${toolName}`)) {
        issues.push({
          severity: 'medium',
          property: `tool:${toolName}`,
          description: `Tool "${toolName}" is declared in spec but the SDK did not report a registration check for it`,
          recommendation: `Ensure AgentSpecReporter is initialised with the correct manifest and all declared tools are registered`,
        })
      }
    }
  } else {
    // ── Static fallback gap analysis ──────────────────────────────────────────
    const missingTools = specTools.filter(
      (t) => observed.tools.length > 0 && !observed.tools.includes(t),
    )
    for (const tool of missingTools) {
      issues.push({
        severity: 'medium',
        property: 'discoverable',
        description: `Tool "${tool}" declared in spec but not found in /capabilities`,
        recommendation: `Ensure tool "${tool}" is registered and returned by your /capabilities endpoint`,
      })
    }
  }

  if (manifest.spec.evaluation?.datasets?.length) {
    issues.push({
      severity: 'low',
      property: 'evaluated',
      description: 'Evaluation datasets declared but not yet run against live agent',
      recommendation: 'Run POST /eval/run with your dataset name to validate live agent behaviour',
    })
  }

  if (!manifest.spec.guardrails) {
    issues.push({
      severity: 'medium',
      property: 'auditable',
      description: 'No guardrails declared in spec',
      recommendation:
        'Add spec.guardrails with input/output rules to enable PII scrubbing and content filtering',
    })
  }

  return issues
}

async function callLlmForGapAnalysis(
  manifest: AgentSpecManifest,
  issues: GapIssue[],
): Promise<GapIssue[]> {
  const apiKey = config.anthropicApiKey
  if (!apiKey) {
    return issues // Return issues as-is without LLM enrichment
  }

  try {
    // Dynamic import to avoid hard dep on Anthropic SDK in environments without it
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const anthropic = new Anthropic({ apiKey })

    const prompt = `You are an AgentSpec compliance auditor. Given the agent manifest and the gap analysis matrix,
provide a concise assessment. Return ONLY a JSON array of issues with fields: severity, property, description, recommendation.
Keep recommendations actionable and specific.

Manifest name: ${manifest.metadata.name}
Tools: ${(manifest.spec.tools ?? []).map((t) => t.name).join(', ')}
Has guardrails: ${!!manifest.spec.guardrails}
Has evaluation: ${!!manifest.spec.evaluation}

Detected issues:
${JSON.stringify(issues, null, 2)}

Return the enriched issues array as JSON only, no prose.`

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })

    const text =
      message.content[0]?.type === 'text' ? message.content[0].text : ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as unknown[]
      // Sanitize LLM output — validate shape before trusting it
      const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])
      const sanitized: GapIssue[] = parsed
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null && !Array.isArray(item),
        )
        .map((item) => ({
          severity: VALID_SEVERITIES.has(String(item['severity'] ?? ''))
            ? (String(item['severity']) as GapIssue['severity'])
            : 'low',
          property: String(item['property'] ?? '').slice(0, 100),
          description: String(item['description'] ?? '').slice(0, 500),
          recommendation: String(item['recommendation'] ?? '').slice(0, 500),
        }))
      return sanitized
    }
  } catch {
    // Fall back to raw issues on any error
  }

  return issues
}

export async function buildGapRoutes(
  app: FastifyInstance,
  manifest: AgentSpecManifest,
): Promise<void> {
  app.get('/gap', async () => {
    const upstream = config.upstreamUrl

    // Probe the agent SDK endpoint and the legacy upstream endpoints in parallel
    const [probe, observed] = await Promise.all([
      probeAgent(upstream),
      probeUpstream(upstream),
    ])

    const rawIssues = buildGapMatrix(manifest, {
      hasHealth: observed.hasHealth,
      hasCapabilities: observed.hasCapabilities,
      tools: observed.tools,
    }, probe)

    // ── OPA integration (additive, fail-open) ──────────────────────────────────
    // When OPA is running as a sidecar (OPA_URL is set), query it for policy
    // violations derived from the manifest declarations. OPA violations are
    // merged into the gap issues list with higher precision than static analysis.
    if (config.opaUrl) {
      try {
        const opaInput = buildOPAInput(manifest, probe, {
          hasHealth: observed.hasHealth,
          hasCapabilities: observed.hasCapabilities,
          tools: observed.tools,
        })
        const opaResult = await queryOPA(config.opaUrl, manifest.metadata.name, opaInput)

        if (!opaResult.opaUnavailable && opaResult.violations.length > 0) {
          const opaIssues = opaViolationsToGapIssues(opaResult.violations)
          // Merge OPA issues — deduplicate by property (OPA may overlap with static)
          const existingProperties = new Set(rawIssues.map((i) => i.property))
          for (const issue of opaIssues) {
            if (!existingProperties.has(issue.property)) {
              rawIssues.push(issue)
            }
          }
        }
      } catch {
        // OPA integration is additive — any error here is non-fatal
      }
    }

    const enrichedIssues = await callLlmForGapAnalysis(manifest, rawIssues)

    // Score: 100 - penalty per severity
    const SEVERITY_PENALTIES: Record<string, number> = {
      critical: 30,
      high: 20,
      medium: 10,
      low: 5,
    }
    const penalty = enrichedIssues.reduce(
      (sum, issue) => sum + (SEVERITY_PENALTIES[issue.severity] ?? 5),
      0,
    )
    const score = Math.max(0, 100 - penalty)

    const modelId = `${manifest.spec.model.provider}/${manifest.spec.model.id}`

    return {
      score,
      issues: enrichedIssues,
      source: probe.sdkAvailable ? 'agent-sdk' : 'manifest-static',
      modelId,
      observed: {
        hasHealthEndpoint: observed.hasHealth,
        hasCapabilitiesEndpoint: observed.hasCapabilities,
        upstreamTools: observed.tools,
      },
    } satisfies GapReport
  })
}
