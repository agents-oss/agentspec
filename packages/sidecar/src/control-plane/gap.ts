import type { FastifyInstance } from 'fastify'
import type { AgentSpecManifest, HealthCheck, Severity } from '@agentspec/sdk'
import { config } from '../config.js'
import type { AuditRing, AuditEntry } from '../audit-ring.js'
import { probeAgent, type AgentProbeResult } from './agent-probe.js'
import { buildOPAInput, queryOPA, opaViolationsToGapIssues } from './opa-client.js'

export interface GapIssue {
  severity: Severity
  property: string
  description: string
  recommendation: string
  /** What kind of evidence supports this issue verdict */
  evidenceLevel: 'declarative' | 'probed' | 'behavioral'
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
  /** Behavioral compliance summary — only present when HeaderReporting or EventPush data is available. */
  behavioral?: {
    sampleSize: number
    compliantRequests: number
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
    // intentionally silent: upstream /health not reachable
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
    // intentionally silent: upstream /capabilities not reachable
  }

  return result
}

/** Extracts the env var name from a $env:VAR_NAME reference, or null. */
function extractEnvVarName(ref: string): string | null {
  const match = ref.match(/^\$env:(.+)$/)
  return match ? (match[1] ?? null) : null
}

/** Merge source issues into target, deduplicating by property. */
function mergeIssues(target: GapIssue[], source: GapIssue[]): void {
  const existingProperties = new Set(target.map((i) => i.property))
  for (const issue of source) {
    if (!existingProperties.has(issue.property)) {
      target.push(issue)
    }
  }
}

/**
 * Filter probe checks by category + 'fail' status and push a GapIssue for each.
 *
 * @param checks - Full check list from the probe report
 * @param category - Category to filter on (e.g. 'env', 'service')
 * @param severity - Severity to assign to each pushed issue
 * @param descriptionPrefix - Default description prefix when check.message is absent
 * @param recommendationDefault - Default recommendation when check.remediation is absent
 * @param issues - Target array to push issues into
 * @param cap - String cap helper from the parent function
 */
function pushFailedProbeChecks(
  checks: HealthCheck[],
  category: string,
  severity: GapIssue['severity'],
  descriptionPrefix: string,
  recommendationDefault: string,
  issues: GapIssue[],
  cap: (s: string | undefined, fallback: string) => string,
): void {
  const failed = checks.filter((c) => c.category === category && c.status === 'fail')
  for (const check of failed) {
    issues.push({
      severity,
      property: check.id.slice(0, 100),
      description: cap(check.message, `${descriptionPrefix}: ${check.id}`),
      recommendation: cap(check.remediation, recommendationDefault),
      evidenceLevel: 'probed',
    })
  }
}

/** Build gap issues from live SDK probe data (agent has @agentspec/sdk integrated). */
function buildLiveSdkIssues(
  manifest: AgentSpecManifest,
  probe: AgentProbeResult,
): GapIssue[] {
  const issues: GapIssue[] = []
  const specTools = (manifest.spec.tools ?? []).map((t) => t.name)
  const report = probe.report!

  // Helper: cap strings from untrusted probe data before they enter the LLM prompt
  const cap = (s: string | undefined, fallback: string): string =>
    (s ?? fallback).slice(0, 500)

  // Model API key — live check from probe
  const modelCheck = report.checks.find((c) => c.category === 'model')
  if (modelCheck?.status === 'fail') {
    issues.push({
      severity: 'critical',
      property: 'model.apiKey',
      description: cap(modelCheck.message, 'Model endpoint unreachable'),
      recommendation: cap(
        modelCheck.remediation,
        'Check model API key configuration and provider reachability',
      ),
      evidenceLevel: 'probed',
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
      evidenceLevel: 'probed',
    })
  }

  // Env vars — any failing env checks from probe
  pushFailedProbeChecks(
    report.checks, 'env', 'high',
    'Environment variable check failed',
    'Set the required environment variable',
    issues, cap,
  )

  // Services — any failing service checks from probe
  pushFailedProbeChecks(
    report.checks, 'service', 'high',
    'Service connectivity check failed',
    'Check the service connection string and ensure the service is reachable',
    issues, cap,
  )

  // Tools — declared in manifest but failing in probe
  const failingTools = specTools.filter((name) =>
    report.checks.some((c) => c.id === `tool:${name}` && c.status === 'fail'),
  )
  for (const tool of failingTools) {
    issues.push({
      severity: 'medium',
      property: `tool:${tool}`,
      description: `Tool "${tool}" declared in spec but its handler is not registered in the agent`,
      recommendation: `Ensure tool "${tool}" is registered and its handler is available at runtime`,
      evidenceLevel: 'probed',
    })
  }

  // ── Spec-vs-probe reconciliation ──────────────────────────────────────────
  const probeCheckIds = new Set(report.checks.map((c) => c.id))

  // Model API key env var
  const apiKeyEnvVar = extractEnvVarName(manifest.spec.model.apiKey)
  if (apiKeyEnvVar && !probeCheckIds.has(`env:${apiKeyEnvVar}`)) {
    issues.push({
      severity: 'high',
      property: `env:${apiKeyEnvVar}`,
      description: `Spec declares model.apiKey as $env:${apiKeyEnvVar} but the SDK did not report this check`,
      recommendation: `Ensure AgentSpecReporter is initialised with the correct manifest so it checks env:${apiKeyEnvVar}`,
      evidenceLevel: 'probed',
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
        evidenceLevel: 'probed',
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
        evidenceLevel: 'probed',
      })
    }
  }

  return issues
}

/** Build gap issues from static manifest analysis (no SDK integration). */
function buildStaticFallbackIssues(
  manifest: AgentSpecManifest,
  observed: { hasHealth: boolean; hasCapabilities: boolean; tools: string[] },
): GapIssue[] {
  const issues: GapIssue[] = []
  const specTools = (manifest.spec.tools ?? []).map((t) => t.name)

  const missingTools = specTools.filter(
    (t) => observed.tools.length > 0 && !observed.tools.includes(t),
  )
  for (const tool of missingTools) {
    issues.push({
      severity: 'medium',
      property: 'discoverable',
      description: `Tool "${tool}" declared in spec but not found in /capabilities`,
      recommendation: `Ensure tool "${tool}" is registered and returned by your /capabilities endpoint`,
      evidenceLevel: 'declarative',
    })
  }

  return issues
}

function buildGapMatrix(
  manifest: AgentSpecManifest,
  observed: { hasHealth: boolean; hasCapabilities: boolean; tools: string[] },
  probe: AgentProbeResult,
): GapIssue[] {
  const issues: GapIssue[] = []

  if (!observed.hasHealth) {
    issues.push({
      severity: 'high',
      property: 'healthcheckable',
      description: 'Agent does not expose a /health endpoint',
      recommendation:
        'Add GET /health to your agent server; use agentspec-sidecar to provide it automatically',
      evidenceLevel: 'probed',
    })
  }

  if (!observed.hasCapabilities) {
    issues.push({
      severity: 'medium',
      property: 'discoverable',
      description: 'Agent does not expose /capabilities or /.well-known/agent.json',
      recommendation:
        'The agentspec-sidecar /capabilities endpoint serves this automatically from agent.yaml',
      evidenceLevel: 'probed',
    })
  }

  if (probe.sdkAvailable && probe.report) {
    issues.push(...buildLiveSdkIssues(manifest, probe))
  } else {
    issues.push(...buildStaticFallbackIssues(manifest, observed))
  }

  if (manifest.spec.evaluation?.datasets?.length) {
    issues.push({
      severity: 'low',
      property: 'evaluated',
      description: 'Evaluation datasets declared but not yet run against live agent',
      recommendation: 'Run POST /eval/run with your dataset name to validate live agent behaviour',
      evidenceLevel: 'declarative',
    })
  }

  if (!manifest.spec.guardrails) {
    issues.push({
      severity: 'medium',
      property: 'auditable',
      description: 'No guardrails declared in spec',
      recommendation:
        'Add spec.guardrails with input/output rules to enable PII scrubbing and content filtering',
      evidenceLevel: 'declarative',
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
      // Sanitize LLM output — validate shape before trusting it.
      // Build a lookup map from the original issues to preserve evidenceLevel
      // (LLM output is not trusted for this field).
      const originalByProperty = new Map(issues.map((i) => [i.property, i.evidenceLevel]))
      const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])
      const VALID_EVIDENCE = new Set(['declarative', 'probed', 'behavioral'])
      const sanitized: GapIssue[] = parsed
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null && !Array.isArray(item),
        )
        .map((item) => {
          const property = String(item['property'] ?? '').slice(0, 100)
          // Prefer original evidenceLevel; fall back to LLM value if valid, else 'declarative'
          const llmLevel = String(item['evidenceLevel'] ?? '')
          const evidenceLevel: GapIssue['evidenceLevel'] =
            originalByProperty.get(property) ??
            (VALID_EVIDENCE.has(llmLevel) ? (llmLevel as GapIssue['evidenceLevel']) : 'declarative')
          return {
            severity: VALID_SEVERITIES.has(String(item['severity'] ?? ''))
              ? (String(item['severity']) as GapIssue['severity'])
              : 'low',
            property,
            description: String(item['description'] ?? '').slice(0, 500),
            recommendation: String(item['recommendation'] ?? '').slice(0, 500),
            evidenceLevel,
          }
        })
      return sanitized
    }
  } catch {
    // LLM enrichment failed — returning raw issues as-is
  }

  return issues
}

/** Compute guardrail invocation rate gap issues from behavioral audit entries. */
function computeGuardrailGapIssues(
  behavioralEntries: AuditEntry[],
  manifest: AgentSpecManifest,
  sampleSize: number,
): GapIssue[] {
  const issues: GapIssue[] = []
  const declaredInputGuardrails = (manifest.spec.guardrails?.input ?? []).map((g) => g.type)

  for (const guardrailType of declaredInputGuardrails) {
    const invokedCount = behavioralEntries.filter(
      (e) => e.guardrailsInvoked?.includes(guardrailType),
    ).length
    const rate = invokedCount / sampleSize

    if (rate < 1.0) {
      let severity: GapIssue['severity']
      if (rate < 0.5) {
        severity = 'high'
      } else if (rate < 0.8) {
        severity = 'medium'
      } else {
        severity = 'low'
      }

      const pct = Math.round(rate * 100)
      issues.push({
        severity,
        property: `behavioral:guardrail:${guardrailType}`,
        description: `Guardrail "${guardrailType}" was only invoked on ${pct}% of observed requests (${invokedCount}/${sampleSize})`,
        recommendation: `Ensure "${guardrailType}" is wired via GuardrailMiddleware and called on every request. Use the agentspec-langgraph SidecarClient to report behavioral events.`,
        evidenceLevel: 'behavioral',
      })
    }
  }

  return issues
}

/** Compute tool usage gap issues (declared but never called) from behavioral audit entries. */
function computeToolGapIssues(
  behavioralEntries: AuditEntry[],
  manifest: AgentSpecManifest,
  sampleSize: number,
): GapIssue[] {
  const issues: GapIssue[] = []
  const declaredTools = (manifest.spec.tools ?? []).map((t) => t.name)

  for (const toolName of declaredTools) {
    const calledCount = behavioralEntries.filter(
      (e) => e.toolsCalled?.includes(toolName),
    ).length
    if (calledCount === 0) {
      issues.push({
        severity: 'low',
        property: `behavioral:tool:${toolName}`,
        description: `Tool "${toolName}" is declared in spec but was never called in ${sampleSize} observed requests`,
        recommendation: `If the tool is intended to be used, verify it is wired to the agent's tool node. If it is optional, this issue can be ignored.`,
        evidenceLevel: 'behavioral',
      })
    }
  }

  return issues
}

/**
 * Compute gap issues from real behavioral observations in the audit ring.
 *
 * Only considers entries that have behavioral data (guardrailsInvoked !== undefined),
 * i.e., entries enriched by HeaderReporting (agent response headers) or EventPush.
 *
 * If no entries have behavioral data, returns empty issues silently.
 */
export function computeBehavioralGap(
  auditRing: AuditRing,
  manifest: AgentSpecManifest,
  lookback = 100,
): { issues: GapIssue[]; behavioralScore: number; sampleSize: number; compliantRequests: number } {
  const allEntries = auditRing.getAll()
  // Take the most recent `lookback` entries that have behavioral data
  const behavioralEntries = allEntries
    .slice(-lookback)
    .filter((e) => e.guardrailsInvoked !== undefined || e.toolsCalled !== undefined)

  const sampleSize = behavioralEntries.length
  const compliantRequests = behavioralEntries.filter(
    (e) => e.behavioralCompliant === true,
  ).length

  if (sampleSize === 0) {
    return { issues: [], behavioralScore: 100, sampleSize: 0, compliantRequests: 0 }
  }

  const issues: GapIssue[] = [
    ...computeGuardrailGapIssues(behavioralEntries, manifest, sampleSize),
    ...computeToolGapIssues(behavioralEntries, manifest, sampleSize),
  ]

  // ── OPA violations from audit ring ──────────────────────────────────────────
  const opaViolatingEntries = behavioralEntries.filter(
    (e) => e.behavioralCompliant === false && (e.opaViolations?.length ?? 0) > 0,
  )
  if (opaViolatingEntries.length > 0) {
    const allViolations = new Set<string>()
    for (const e of opaViolatingEntries) {
      for (const v of e.opaViolations ?? []) {
        allViolations.add(v)
      }
    }
    issues.push(...opaViolationsToGapIssues([...allViolations]))
  }

  // Behavioral score: penalise by non-compliant rate
  const nonCompliantWithOPA = opaViolatingEntries.length
  const behavioralScore = Math.max(
    0,
    100 - Math.round((nonCompliantWithOPA / sampleSize) * 100),
  )

  return { issues, behavioralScore, sampleSize, compliantRequests }
}

export async function buildGapRoutes(
  app: FastifyInstance,
  manifest: AgentSpecManifest,
  auditRing: AuditRing,
): Promise<void> {
  app.get('/gap', async () => {
    const upstream = config.upstreamUrl

    // Probe the agent SDK endpoint and the legacy upstream endpoints in parallel
    const [probe, observed] = await Promise.all([
      probeAgent(upstream),
      probeUpstream(upstream),
    ])

    const rawIssues = buildGapMatrix(manifest, observed, probe)

    // ── OPA integration (additive, fail-open) ──────────────────────────────────
    // When OPA is running as a sidecar (OPA_URL is set), query it for policy
    // violations derived from the manifest declarations. OPA violations are
    // merged into the gap issues list with higher precision than static analysis.
    if (config.opaUrl) {
      try {
        const opaInput = buildOPAInput(manifest, probe, observed)
        const opaResult = await queryOPA(config.opaUrl, manifest.metadata.name, opaInput)

        if (!opaResult.opaUnavailable && opaResult.violations.length > 0) {
          mergeIssues(rawIssues, opaViolationsToGapIssues(opaResult.violations))
        }
      } catch {
        // OPA integration is additive — any error here is non-fatal
      }
    }

    // ── Behavioral gap analysis from audit ring (HeaderReporting / EventPush) ─
    const behavioralResult = computeBehavioralGap(auditRing, manifest)
    if (behavioralResult.issues.length > 0) {
      mergeIssues(rawIssues, behavioralResult.issues)
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

    const response: GapReport = {
      score,
      issues: enrichedIssues,
      source: probe.sdkAvailable ? 'agent-sdk' : 'manifest-static',
      modelId,
      observed: {
        hasHealthEndpoint: observed.hasHealth,
        hasCapabilitiesEndpoint: observed.hasCapabilities,
        upstreamTools: observed.tools,
      },
    }

    // Include behavioral summary only when sample data is available
    if (behavioralResult.sampleSize > 0) {
      response.behavioral = {
        sampleSize: behavioralResult.sampleSize,
        compliantRequests: behavioralResult.compliantRequests,
      }
    }

    return response
  })
}
