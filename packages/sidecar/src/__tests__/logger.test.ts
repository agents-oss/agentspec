/**
 * Unit tests for the structured JSON logger.
 *
 * TDD — tests written first (RED), then logger.ts implemented (GREEN).
 * Verifies that each log method writes valid JSON to stdout/stderr.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { log } from '../logger.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('log.info', () => {
  it('writes to stdout', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    log.info('test message')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('output is valid JSON', () => {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      captured = String(s)
      return true
    })
    log.info('test message')
    expect(() => JSON.parse(captured)).not.toThrow()
  })

  it('parsed JSON has level: "info"', () => {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      captured = String(s)
      return true
    })
    log.info('test message')
    const parsed = JSON.parse(captured) as { level: string }
    expect(parsed.level).toBe('info')
  })

  it('parsed JSON has msg field matching the message', () => {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      captured = String(s)
      return true
    })
    log.info('proxy started')
    const parsed = JSON.parse(captured) as { msg: string }
    expect(parsed.msg).toBe('proxy started')
  })

  it('parsed JSON has ts field as ISO timestamp string', () => {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      captured = String(s)
      return true
    })
    log.info('test')
    const parsed = JSON.parse(captured) as { ts: string }
    expect(typeof parsed.ts).toBe('string')
    expect(() => new Date(parsed.ts)).not.toThrow()
    expect(new Date(parsed.ts).getFullYear()).toBeGreaterThan(2020)
  })

  it('merges extra fields from the second argument', () => {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      captured = String(s)
      return true
    })
    log.info('started', { port: 4000, host: '0.0.0.0' })
    const parsed = JSON.parse(captured) as { port: number; host: string }
    expect(parsed.port).toBe(4000)
    expect(parsed.host).toBe('0.0.0.0')
  })
})

describe('log.error', () => {
  it('writes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    log.error('something failed')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('parsed JSON has level: "error"', () => {
    let captured = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      captured = String(s)
      return true
    })
    log.error('something failed')
    const parsed = JSON.parse(captured) as { level: string }
    expect(parsed.level).toBe('error')
  })
})
