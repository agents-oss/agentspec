/**
 * Unit tests for sidecar config validation helpers.
 *
 * TDD — tests written before implementation.
 * Tests requirePositiveInt() exported from config.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requirePositiveInt } from '../config.js'

describe('requirePositiveInt', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the fallback when the env var is not set', () => {
    vi.stubEnv('AUDIT_RING_SIZE', undefined as unknown as string)
    expect(requirePositiveInt('AUDIT_RING_SIZE', 1000)).toBe(1000)
  })

  it('parses and returns a valid positive integer', () => {
    vi.stubEnv('AUDIT_RING_SIZE', '500')
    expect(requirePositiveInt('AUDIT_RING_SIZE', 1000)).toBe(500)
  })

  it('parses the minimum valid value of 1', () => {
    vi.stubEnv('AUDIT_RING_SIZE', '1')
    expect(requirePositiveInt('AUDIT_RING_SIZE', 1000)).toBe(1)
  })

  it('throws when value is a non-numeric string (NaN)', () => {
    vi.stubEnv('AUDIT_RING_SIZE', 'abc')
    expect(() => requirePositiveInt('AUDIT_RING_SIZE', 1000)).toThrow(/AUDIT_RING_SIZE/)
  })

  it('throws when value is 0', () => {
    vi.stubEnv('AUDIT_RING_SIZE', '0')
    expect(() => requirePositiveInt('AUDIT_RING_SIZE', 1000)).toThrow(/AUDIT_RING_SIZE/)
  })

  it('throws when value is negative', () => {
    vi.stubEnv('AUDIT_RING_SIZE', '-5')
    expect(() => requirePositiveInt('AUDIT_RING_SIZE', 1000)).toThrow(/AUDIT_RING_SIZE/)
  })

  it('throws when value is a float', () => {
    vi.stubEnv('AUDIT_RING_SIZE', '1.5')
    expect(() => requirePositiveInt('AUDIT_RING_SIZE', 1000)).toThrow(/AUDIT_RING_SIZE/)
  })

  it('error message includes the env var name and the invalid value', () => {
    vi.stubEnv('AUDIT_RING_SIZE', '-99')
    expect(() => requirePositiveInt('AUDIT_RING_SIZE', 1000)).toThrow(/-99/)
  })
})
