/**
 * `agentspec diff <from> <to>`
 *
 * Deterministic, no-LLM comparison of two agent.yaml manifests.
 * Annotates each change with severity and compliance score impact,
 * then prints a human-readable drift report (or --json for CI).
 *
 * Exit codes:
 *   0  — no drift (or drift present but --exit-code not set)
 *   1  — drift detected AND --exit-code flag is set
 */

import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import yaml from 'js-yaml'
import { DIFF_SCORE_TABLE, scoreToGrade } from '../utils/diff-score.js'
import type { DiffScoreEntry } from '../utils/diff-score.js'

// Re-export so tests can import from commands/diff.js
export { scoreToGrade }

// ── Public types ──────────────────────────────────────────────────────────────

export interface DiffChange {
  type: 'added' | 'removed' | 'changed'
  property: string
  severity: DiffScoreEntry['severity']
  scoreImpact: number
  description: string
  from?: unknown
  to?: unknown
}

export interface DiffResult {
  from: string
  to: string
  scoreFrom: number
  scoreTo: number
  gradeFrom: string
  gradeTo: string
  netScoreChange: number
  changes: DiffChange[]
}

// ── Core diff logic ───────────────────────────────────────────────────────────

/** Keys that must never be traversed to prevent prototype pollution. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Flatten a nested object to dot-notation paths.
 *
 * Arrays are flattened with their index, e.g.  spec.tools.0.name
 *
 * Security: skips __proto__ / constructor / prototype keys to prevent
 * prototype pollution when processing untrusted YAML input.
 */
function flattenObject(obj: unknown, prefix = ''): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object') {
    return { [prefix]: obj }
  }

  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // [M2] Skip dangerous keys
    if (DANGEROUS_KEYS.has(key)) continue
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, fullKey))
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        result[fullKey] = value
      } else {
        value.forEach((item, idx) => {
          const itemKey = `${fullKey}.${idx}`
          if (item !== null && typeof item === 'object') {
            Object.assign(result, flattenObject(item, itemKey))
          } else {
            result[itemKey] = item
          }
        })
      }
    } else {
      result[fullKey] = value
    }
  }

  return result
}

/**
 * Look up the closest matching key in DIFF_SCORE_TABLE for a given dot path.
 *
 * Tries exact match first, then progressively shorter prefixes.
 * Falls back to a sensible default based on change type.
 */
function lookupScore(
  property: string,
  changeType: 'added' | 'removed' | 'changed',
): DiffScoreEntry {
  // Exact match
  if (DIFF_SCORE_TABLE[property]) return DIFF_SCORE_TABLE[property]

  // Check parent paths
  const parts = property.split('.')
  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = parts.slice(0, i).join('.')
    if (DIFF_SCORE_TABLE[candidate]) return DIFF_SCORE_TABLE[candidate]
  }

  // additions: always LOW/0; removals/changes: LOW/-2 for unknown
  if (changeType === 'added') {
    return { severity: 'LOW', scoreImpact: 0, description: `New field added: ${property}` }
  }
  return {
    severity: 'LOW',
    scoreImpact: -2,
    description: `Field ${changeType}: ${property}`,
  }
}

/**
 * Compute diff between two parsed manifest objects.
 *
 * Returns an array of DiffChange objects, one per changed property.
 * Pure function — no I/O.
 */
export function computeDiff(from: unknown, to: unknown): DiffChange[] {
  const flatFrom = flattenObject(from)
  const flatTo = flattenObject(to)

  const changes: DiffChange[] = []
  const allKeys = new Set([...Object.keys(flatFrom), ...Object.keys(flatTo)])

  for (const key of allKeys) {
    const inFrom = Object.prototype.hasOwnProperty.call(flatFrom, key)
    const inTo = Object.prototype.hasOwnProperty.call(flatTo, key)

    if (inFrom && !inTo) {
      // Removed
      const entry = lookupScore(key, 'removed')
      changes.push({
        type: 'removed',
        property: key,
        severity: entry.severity,
        scoreImpact: entry.scoreImpact,
        description: entry.description,
        from: flatFrom[key],
      })
    } else if (!inFrom && inTo) {
      // Added — check if it's a tool
      const isTool = key.startsWith('spec.tools.')
      const entry = isTool
        ? DIFF_SCORE_TABLE['spec.tools[+]']
        : lookupScore(key, 'added')
      changes.push({
        type: 'added',
        property: key,
        severity: entry.severity,
        scoreImpact: entry.scoreImpact,
        description: entry.description,
        to: flatTo[key],
      })
    } else if (JSON.stringify(flatFrom[key]) !== JSON.stringify(flatTo[key])) {
      // Changed
      const entry = lookupScore(key, 'changed')
      changes.push({
        type: 'changed',
        property: key,
        severity: entry.severity,
        scoreImpact: entry.scoreImpact,
        description: entry.description,
        from: flatFrom[key],
        to: flatTo[key],
      })
    }
  }

  return changes
}

// ── Output formatters ─────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<string, string> = {
  HIGH: '\x1b[31m',   // red
  MEDIUM: '\x1b[33m', // yellow
  LOW: '\x1b[36m',    // cyan
  INFO: '\x1b[37m',   // white
}
const RESET = '\x1b[0m'

function printHumanReport(result: DiffResult): void {
  const bar = '═'.repeat(54)
  console.log(`\nagentspec diff — compliance drift analysis`)
  console.log(bar)
  console.log(`  Comparing: ${result.from} → ${result.to}`)

  if (result.changes.length === 0) {
    console.log(`\n  No compliance drift detected.\n`)
    console.log(bar)
    return
  }

  console.log()
  for (const c of result.changes) {
    const typeLabel = c.type.toUpperCase().padEnd(8)
    const impactStr = c.scoreImpact === 0 ? '+0' : String(c.scoreImpact)
    const color = SEVERITY_COLOR[c.severity] ?? ''
    console.log(
      `  ${typeLabel} ${c.property.padEnd(38)} [${impactStr} score]  ` +
      `${color}${c.severity}${RESET}`
    )
    console.log(`           ${c.description}`)
    console.log()
  }

  const netStr = result.netScoreChange >= 0
    ? `+${result.netScoreChange}`
    : String(result.netScoreChange)

  console.log(
    `  Net score change:  ${netStr}` +
    `  (${result.scoreFrom} → ${result.scoreTo},` +
    ` ${result.gradeFrom} → ${result.gradeTo})`
  )
  if (result.netScoreChange < 0) {
    const highChanges = result.changes.filter(c => c.severity === 'HIGH')
    if (highChanges.length > 0) {
      console.log(`\n  Recommendation: restore ${highChanges[0].property} before deploying`)
    }
  }
  console.log(bar)
}

function printJsonReport(result: DiffResult): void {
  console.log(JSON.stringify(result, null, 2))
}

// ── Commander registration ─────────────────────────────────────────────────────

export function registerDiffCommand(program: Command): void {
  program
    .command('diff <from> <to>')
    .description('Detect compliance drift between two agent.yaml manifests')
    .option('--json', 'Output machine-readable JSON')
    .option('--exit-code', 'Exit with code 1 if drift is detected')
    .action(async (fromPath: string, toPath: string, opts: { json?: boolean; exitCode?: boolean }) => {
      let fromRaw: unknown
      let toRaw: unknown

      try {
        // [M1] Explicit JSON_SCHEMA prevents custom type instantiation
        fromRaw = yaml.load(readFileSync(fromPath, 'utf-8'), { schema: yaml.JSON_SCHEMA })
        toRaw = yaml.load(readFileSync(toPath, 'utf-8'), { schema: yaml.JSON_SCHEMA })
      } catch (err) {
        console.error(`Error loading manifests: ${(err as Error).message}`)
        process.exit(1)
      }

      const changes = computeDiff(fromRaw, toRaw)
      const netScoreChange = changes.reduce((sum, c) => sum + c.scoreImpact, 0)
      // [H4] scoreFrom is a relative baseline of 100 (perfect starting score).
      // This measures drift magnitude, not absolute compliance.
      // Run `agentspec audit` on each file for absolute scores.
      const scoreFrom = 100
      const scoreTo = Math.max(0, scoreFrom + netScoreChange)

      const result: DiffResult = {
        from: fromPath,
        to: toPath,
        scoreFrom,
        scoreTo,
        gradeFrom: scoreToGrade(scoreFrom),
        gradeTo: scoreToGrade(scoreTo),
        netScoreChange,
        changes,
      }

      if (opts.json) {
        printJsonReport(result)
      } else {
        printHumanReport(result)
      }

      if (opts.exitCode && changes.length > 0) {
        process.exit(1)
      }
    })
}
