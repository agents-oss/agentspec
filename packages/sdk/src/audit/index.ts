import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import { modelRules } from './rules/model.rules.js'
import { securityRules } from './rules/security.rules.js'
import { memoryRules } from './rules/memory.rules.js'
import { evaluationRules } from './rules/evaluation.rules.js'
import { observabilityRules } from './rules/observability.rules.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
/** Canonical severity type shared across packages. Alias of RuleSeverity. */
export type Severity = RuleSeverity
export type CompliancePack =
  | 'owasp-llm-top10'
  | 'model-resilience'
  | 'memory-hygiene'
  | 'evaluation-coverage'
  | 'observability'

export type EvidenceLevel = 'declarative' | 'probed' | 'behavioral' | 'external'

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
  /** What kind of evidence supports this rule's verdict */
  evidenceLevel: EvidenceLevel
  /**
   * Human-readable name of the external tool that can prove this rule.
   * Defined for 'external' evidence level rules; optional on 'probed'.
   */
  proofTool?: string
  /** URL to integration guide or documentation for the proof tool */
  proofToolUrl?: string
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
  /** What kind of evidence supports this violation */
  evidenceLevel: EvidenceLevel
  /** Proof tool recommendation (for 'external' rules) */
  proofTool?: string
  /** Proof tool URL (for 'external' rules) */
  proofToolUrl?: string
}

export interface EvidenceBreakdown {
  declarative: { passed: number; total: number }
  probed: { passed: number; total: number }
  behavioral: { passed: number; total: number }
  external: { passed: number; total: number }
}

/** A proof record submitted by an external tool to the sidecar's /proof endpoint */
export interface ProofRecord {
  ruleId: string
  verifiedAt: string
  verifiedBy: string
  method: string
  expiresAt?: string
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
  evidenceBreakdown: EvidenceBreakdown
  /**
   * Score based only on proved rules (probed + behavioral + external with proof records).
   * Only present when proofRecords are provided to runAudit (e.g. via --url flag).
   */
  provedScore?: number
  /** Grade corresponding to provedScore */
  provedGrade?: 'A' | 'B' | 'C' | 'D' | 'F'
  /** Number of 'external' rules that pass declaratively but lack a proof record */
  pendingProofCount?: number
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
  /**
   * Proof records fetched from the sidecar's GET /proof endpoint.
   * When provided, provedScore and pendingProofCount are computed.
   */
  proofRecords?: ProofRecord[]
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

/** Set of all valid audit rule IDs — single source of truth for validation. */
export const AUDIT_RULE_IDS: ReadonlySet<string> = new Set(ALL_RULES.map((r) => r.id))

/** Type guard: returns true if `r` is a structurally valid ProofRecord. */
export function isProofRecord(r: unknown): r is ProofRecord {
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof (r as Record<string, unknown>)['ruleId'] === 'string' &&
    typeof (r as Record<string, unknown>)['verifiedBy'] === 'string' &&
    typeof (r as Record<string, unknown>)['method'] === 'string'
  )
}

// ── Grade thresholds ──────────────────────────────────────────────────────────
export function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 45) return 'D'
  return 'F'
}

// ── Internal interfaces ───────────────────────────────────────────────────────

interface ScoringResult {
  violations: AuditViolation[]
  packBreakdown: Record<string, { passed: number; total: number }>
  evidenceBreakdown: EvidenceBreakdown
  totalWeight: number
  overallScore: number
  categoryScores: Record<string, number>
}

interface ProvedResult {
  provedScore: number
  provedGrade: 'A' | 'B' | 'C' | 'D' | 'F'
  pendingProofCount: number
}

// ── Private helpers ───────────────────────────────────────────────────────────

function resolveActiveRules(manifest: AgentSpecManifest, opts: AuditOptions): AuditRule[] {
  const manifestPacks = manifest.spec.compliance?.packs ?? []
  const activePacks: CompliancePack[] =
    opts.packs ??
    (opts.useManifestPacks !== false && manifestPacks.length > 0
      ? manifestPacks
      : ([...new Set(ALL_RULES.map((r) => r.pack))] as CompliancePack[]))
  return ALL_RULES.filter((r) => activePacks.includes(r.pack))
}

function collectSuppressions(manifest: AgentSpecManifest): {
  suppressions: SuppressionRecord[]
  suppressedIds: Set<string>
} {
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

  return { suppressions, suppressedIds }
}

function executeRuleChecks(
  rules: AuditRule[],
  manifest: AgentSpecManifest,
  suppressedIds: Set<string>,
): Map<string, RuleResult> {
  const ruleResults = new Map<string, RuleResult>()
  for (const rule of rules) {
    ruleResults.set(
      rule.id,
      suppressedIds.has(rule.id) ? { pass: true } : rule.check(manifest),
    )
  }
  return ruleResults
}

function computeScoring(
  rules: AuditRule[],
  ruleResults: Map<string, RuleResult>,
  suppressedIds: Set<string>,
): ScoringResult {
  const violations: AuditViolation[] = []
  const packBreakdown: Record<string, { passed: number; total: number }> = {}
  const evidenceBreakdown: EvidenceBreakdown = {
    declarative: { passed: 0, total: 0 },
    probed:      { passed: 0, total: 0 },
    behavioral:  { passed: 0, total: 0 },
    external:    { passed: 0, total: 0 },
  }

  let totalWeight = 0
  let passedWeight = 0

  for (const rule of rules) {
    if (!packBreakdown[rule.pack]) {
      packBreakdown[rule.pack] = { passed: 0, total: 0 }
    }

    const suppressed = suppressedIds.has(rule.id)
    const weight = SEVERITY_WEIGHTS[rule.severity]
    const result = ruleResults.get(rule.id)!
    const tier = evidenceBreakdown[rule.evidenceLevel]

    packBreakdown[rule.pack]!.total += 1
    tier.total += 1

    if (suppressed) {
      packBreakdown[rule.pack]!.passed += 1
      tier.passed += 1
      continue
    }

    if (result.pass) {
      packBreakdown[rule.pack]!.passed += 1
      tier.passed += 1
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
        evidenceLevel: rule.evidenceLevel,
        proofTool: rule.proofTool,
        proofToolUrl: rule.proofToolUrl,
      })
    }

    totalWeight += weight
  }

  const overallScore =
    totalWeight === 0 ? 100 : Math.round((passedWeight / totalWeight) * 100)

  const categoryScores: Record<string, number> = {}
  for (const [pack, { passed, total }] of Object.entries(packBreakdown)) {
    categoryScores[pack] = total === 0 ? 100 : Math.round((passed / total) * 100)
  }

  return { violations, packBreakdown, evidenceBreakdown, totalWeight, overallScore, categoryScores }
}

function computeProvedScore(
  rules: AuditRule[],
  ruleResults: Map<string, RuleResult>,
  suppressedIds: Set<string>,
  totalWeight: number,
  proofRecords: ProofRecord[],
): ProvedResult {
  const now = new Date()
  const proofSet = new Set(
    proofRecords
      .filter((r) => !r.expiresAt || new Date(r.expiresAt) > now)
      .map((r) => r.ruleId),
  )

  let provedPassedWeight = 0
  for (const rule of rules) {
    if (suppressedIds.has(rule.id)) continue
    const result = ruleResults.get(rule.id)!
    const weight = SEVERITY_WEIGHTS[rule.severity]

    const isProved =
      (rule.evidenceLevel === 'probed' && result.pass) ||
      (rule.evidenceLevel === 'behavioral' && result.pass) ||
      (rule.evidenceLevel === 'external' && proofSet.has(rule.id))

    if (isProved) provedPassedWeight += weight
  }

  const provedScore =
    totalWeight === 0 ? 100 : Math.round((provedPassedWeight / totalWeight) * 100)

  const pendingProofCount = rules.filter(
    (r) =>
      r.evidenceLevel === 'external' &&
      !suppressedIds.has(r.id) &&
      ruleResults.get(r.id)!.pass &&
      !proofSet.has(r.id),
  ).length

  return { provedScore, provedGrade: scoreToGrade(provedScore), pendingProofCount }
}

// ── Main audit runner ─────────────────────────────────────────────────────────

export function runAudit(
  manifest: AgentSpecManifest,
  opts: AuditOptions = {},
): AuditReport {
  const rules                           = resolveActiveRules(manifest, opts)
  const { suppressions, suppressedIds } = collectSuppressions(manifest)
  const ruleResults                     = executeRuleChecks(rules, manifest, suppressedIds)
  const { violations, packBreakdown,
          evidenceBreakdown, totalWeight,
          overallScore, categoryScores } = computeScoring(rules, ruleResults, suppressedIds)

  const proved = opts.proofRecords !== undefined
    ? computeProvedScore(rules, ruleResults, suppressedIds, totalWeight, opts.proofRecords)
    : {}

  return {
    agentName:     manifest.metadata.name,
    timestamp:     new Date().toISOString(),
    overallScore,
    grade:         scoreToGrade(overallScore),
    categoryScores,
    violations,
    suppressions,
    passedRules:   rules.length - violations.length,
    totalRules:    rules.length,
    packBreakdown: packBreakdown as Record<CompliancePack, { passed: number; total: number }>,
    evidenceBreakdown,
    ...proved,
  }
}
