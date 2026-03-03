/**
 * Per-property compliance impact table for `agentspec diff`.
 *
 * Each key is a dot-notation path pattern that maps to severity, score delta,
 * and a human-readable description used in the diff report.
 *
 * scoreImpact is always ≤ 0 for removals (compliance loss) and 0 for additions
 * (new capabilities are flagged for review but not penalised automatically).
 */

export interface DiffScoreEntry {
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'
  scoreImpact: number
  description: string
}

export const DIFF_SCORE_TABLE: Record<string, DiffScoreEntry> = {
  // ── Guardrails ─────────────────────────────────────────────────────────────
  'spec.guardrails.content_filter': {
    severity: 'HIGH',
    scoreImpact: -15,
    description: 'Content filtering removed — user input reaches model unfiltered',
  },
  'spec.guardrails.rate_limit': {
    severity: 'HIGH',
    scoreImpact: -10,
    description: 'Rate limiting removed — DoS risk increased',
  },
  'spec.guardrails.output_validator': {
    severity: 'HIGH',
    scoreImpact: -10,
    description: 'Output validation removed — model responses are unchecked',
  },
  'spec.guardrails.pii_scrubber': {
    severity: 'HIGH',
    scoreImpact: -12,
    description: 'PII scrubbing removed — sensitive data may leak in outputs',
  },

  // ── Model ──────────────────────────────────────────────────────────────────
  'spec.model.apiKey': {
    severity: 'HIGH',
    scoreImpact: -12,
    description: 'Model API key reference removed — agent will fail to authenticate',
  },
  'spec.model.name': {
    severity: 'MEDIUM',
    scoreImpact: -5,
    description: 'Model changed — re-evaluate compliance for new model',
  },
  'spec.model.provider': {
    severity: 'MEDIUM',
    scoreImpact: -8,
    description: 'Model provider changed — verify guardrails apply to new provider',
  },
  'spec.model.fallback': {
    severity: 'MEDIUM',
    scoreImpact: -5,
    description: 'Fallback model removed — no resilience on primary model failure',
  },

  // ── Evaluation ─────────────────────────────────────────────────────────────
  'spec.eval.hooks': {
    severity: 'MEDIUM',
    scoreImpact: -8,
    description: 'Eval hooks removed — regression detection disabled',
  },
  'spec.eval.datasets': {
    severity: 'MEDIUM',
    scoreImpact: -5,
    description: 'Eval datasets removed — coverage reduced',
  },

  // ── Memory ─────────────────────────────────────────────────────────────────
  'spec.memory.pii_scrub': {
    severity: 'HIGH',
    scoreImpact: -10,
    description: 'Memory PII scrubbing removed — stored data may contain PII',
  },
  'spec.memory.ttl': {
    severity: 'LOW',
    scoreImpact: -3,
    description: 'Memory TTL removed — data retained indefinitely',
  },

  // ── Tools (additions) ──────────────────────────────────────────────────────
  'spec.tools[+]': {
    severity: 'LOW',
    scoreImpact: 0,
    description: 'New tool added — verify it does not expose sensitive data',
  },

  // ── Observability ──────────────────────────────────────────────────────────
  'spec.observability.metrics': {
    severity: 'LOW',
    scoreImpact: -3,
    description: 'Metrics collection removed — visibility reduced',
  },
  'spec.observability.tracing': {
    severity: 'LOW',
    scoreImpact: -3,
    description: 'Tracing removed — debugging capability reduced',
  },
}

// Re-export the canonical scoreToGrade from the SDK — single source of truth
export { scoreToGrade } from '@agentspec/sdk'
