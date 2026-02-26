import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import { modelRules } from './rules/model.rules.js'
import { securityRules } from './rules/security.rules.js'
import { memoryRules } from './rules/memory.rules.js'
import { evaluationRules } from './rules/evaluation.rules.js'
import { observabilityRules } from './rules/observability.rules.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type CompliancePack =
  | 'owasp-llm-top10'
  | 'model-resilience'
  | 'memory-hygiene'
  | 'evaluation-coverage'
  | 'observability'

export interface RuleResult {
  pass: boolean
  message?: string
  path?: string
  recommendation?: string
  references?: string[]
}

export interface AuditRule {
  id: string
  pack: CompliancePack
  title: string
  description: string
  severity: RuleSeverity
  check(manifest: AgentSpecManifest): RuleResult
}

export interface AuditViolation {
  ruleId: string
  severity: RuleSeverity
  title: string
  message: string
  path?: string
  recommendation?: string
  references?: string[]
}

export interface AuditReport {
  agentName: string
  timestamp: string
  overallScore: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  categoryScores: Record<string, number>
  violations: AuditViolation[]
  suppressions: SuppressionRecord[]
  passedRules: number
  totalRules: number
  packBreakdown: Record<CompliancePack, { passed: number; total: number }>
}

export interface SuppressionRecord {
  ruleId: string
  reason: string
  approvedBy?: string
  expires?: string
}

export interface AuditOptions {
  /** Run only rules from these packs. Default: all */
  packs?: CompliancePack[]
  /** Include rules from the manifest's compliance.packs. Default: true */
  useManifestPacks?: boolean
}

// ── Severity weights ──────────────────────────────────────────────────────────
const SEVERITY_WEIGHTS: Record<RuleSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
}

// ── All rules registry ────────────────────────────────────────────────────────
const ALL_RULES: AuditRule[] = [
  ...modelRules,
  ...securityRules,
  ...memoryRules,
  ...evaluationRules,
  ...observabilityRules,
]

// ── Grade thresholds ──────────────────────────────────────────────────────────
function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 45) return 'D'
  return 'F'
}

// ── Main audit runner ─────────────────────────────────────────────────────────

export function runAudit(
  manifest: AgentSpecManifest,
  opts: AuditOptions = {},
): AuditReport {
  // Determine which packs to run
  const manifestPacks = manifest.spec.compliance?.packs ?? []
  const activePacks: CompliancePack[] =
    opts.packs ??
    (opts.useManifestPacks !== false && manifestPacks.length > 0
      ? manifestPacks
      : ([...new Set(ALL_RULES.map((r) => r.pack))] as CompliancePack[]))


  // Filter rules by active packs
  const rules = ALL_RULES.filter((r) => activePacks.includes(r.pack))

  // Collect suppressions
  const suppressions: SuppressionRecord[] =
    manifest.spec.compliance?.suppressions?.map((s) => ({
      ruleId: s.rule,
      reason: s.reason,
      approvedBy: s.approvedBy,
      expires: s.expires,
    })) ?? []

  const suppressedIds = new Set(
    suppressions
      .filter((s) => !s.expires || new Date(s.expires) > new Date())
      .map((s) => s.ruleId),
  )

  // Run all rules
  const violations: AuditViolation[] = []
  const packBreakdown: Record<string, { passed: number; total: number }> = {}

  let totalWeight = 0
  let passedWeight = 0

  for (const rule of rules) {
    // Init pack tracking
    if (!packBreakdown[rule.pack]) {
      packBreakdown[rule.pack] = { passed: 0, total: 0 }
    }

    const suppressed = suppressedIds.has(rule.id)
    const weight = SEVERITY_WEIGHTS[rule.severity]

    if (suppressed) {
      // Suppressed rules are excluded from scoring
      packBreakdown[rule.pack]!.total += 1
      packBreakdown[rule.pack]!.passed += 1 // count as pass for scoring purposes
      continue
    }

    const result = rule.check(manifest)
    packBreakdown[rule.pack]!.total += 1

    if (result.pass) {
      packBreakdown[rule.pack]!.passed += 1
      passedWeight += weight
    } else {
      violations.push({
        ruleId: rule.id,
        severity: rule.severity,
        title: rule.title,
        message: result.message ?? `Rule ${rule.id} failed`,
        path: result.path,
        recommendation: result.recommendation,
        references: result.references,
      })
    }

    totalWeight += weight
  }

  const overallScore =
    totalWeight === 0 ? 100 : Math.round((passedWeight / totalWeight) * 100)

  // Category scores (by pack)
  const categoryScores: Record<string, number> = {}
  for (const [pack, { passed, total }] of Object.entries(packBreakdown)) {
    categoryScores[pack] = total === 0 ? 100 : Math.round((passed / total) * 100)
  }

  return {
    agentName: manifest.metadata.name,
    timestamp: new Date().toISOString(),
    overallScore,
    grade: scoreToGrade(overallScore),
    categoryScores,
    violations,
    suppressions,
    passedRules: rules.length - violations.length,
    totalRules: rules.length,
    packBreakdown: packBreakdown as Record<CompliancePack, { passed: number; total: number }>,
  }
}
