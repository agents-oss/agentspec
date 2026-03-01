/**
 * Unit tests for src/utils/output.ts — formatting helpers and print functions.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  symbols,
  formatSeverity,
  formatGrade,
  formatHealthStatus,
  printHeader,
  printError,
  printSuccess,
} from '../utils/output.js'

// ── symbols ───────────────────────────────────────────────────────────────────

describe('symbols', () => {
  it('exports all expected symbol keys as strings', () => {
    expect(typeof symbols.pass).toBe('string')
    expect(typeof symbols.fail).toBe('string')
    expect(typeof symbols.warn).toBe('string')
    expect(typeof symbols.skip).toBe('string')
    expect(typeof symbols.info).toBe('string')
    expect(typeof symbols.arrow).toBe('string')
  })
})

// ── formatSeverity ────────────────────────────────────────────────────────────

describe('formatSeverity', () => {
  it.each([
    ['critical', 'CRITICAL'],
    ['error', 'error'],
    ['high', 'high'],
    ['medium', 'medium'],
    ['warning', 'warning'],
    ['low', 'low'],
    ['info', 'info'],
  ])('formats severity "%s" to contain "%s"', (sev, expected) => {
    expect(formatSeverity(sev)).toContain(expected)
  })

  it('wraps unknown severity in brackets', () => {
    expect(formatSeverity('custom-sev')).toContain('custom-sev')
    expect(formatSeverity('custom-sev')).toMatch(/\[.+\]/)
  })
})

// ── formatGrade ───────────────────────────────────────────────────────────────

describe('formatGrade', () => {
  it.each(['A', 'B', 'C', 'D', 'F'])('formats grade %s', (grade) => {
    expect(formatGrade(grade)).toContain(grade)
  })

  it('returns the grade for an unknown letter', () => {
    expect(formatGrade('Z')).toBe(chalk_strip('Z') || formatGrade('Z'))
    // Grade 'Z' falls through to the default — must contain 'Z'
    expect(formatGrade('Z')).toContain('Z')
  })
})

// ── formatHealthStatus ────────────────────────────────────────────────────────

describe('formatHealthStatus', () => {
  it.each([
    ['healthy', 'healthy'],
    ['degraded', 'degraded'],
    ['unhealthy', 'unhealthy'],
  ])('formats status "%s" to contain "%s"', (status, expected) => {
    expect(formatHealthStatus(status)).toContain(expected)
  })

  it('returns unknown status unchanged', () => {
    expect(formatHealthStatus('unknown-state')).toBe('unknown-state')
  })
})

// ── printHeader ───────────────────────────────────────────────────────────────

describe('printHeader', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls console.log with the title text', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printHeader('My Test Header')
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('My Test Header')
  })

  it('calls console.log multiple times (header + separator)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printHeader('Test')
    // Expects at least 2 calls: blank line + title + separator
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

// ── printError ────────────────────────────────────────────────────────────────

describe('printError', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls console.error with the message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    printError('Something went wrong')
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('Something went wrong')
  })

  it('includes the ✗ symbol in the error output', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    printError('oops')
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('✗')
  })
})

// ── printSuccess ──────────────────────────────────────────────────────────────

describe('printSuccess', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls console.log with the message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printSuccess('Operation complete')
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('Operation complete')
  })

  it('includes the ✓ symbol in the success output', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    printSuccess('Done!')
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('✓')
  })
})

// ── helper (chalk strips to plain text in NO_COLOR environments) ──────────────

function chalk_strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}
