import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveCluster } from '../cluster-config.js'

describe('resolveCluster', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...origEnv }
  })

  it('returns explicit args when provided', () => {
    const result = resolveCluster({ controlPlaneUrl: 'http://explicit:8080', adminKey: 'key-1' })
    expect(result).toEqual({ controlPlaneUrl: 'http://explicit:8080', adminKey: 'key-1' })
  })

  it('falls back to env vars when args are undefined', () => {
    process.env['AGENTSPEC_CONTROL_PLANE_URL'] = 'http://env:8080'
    process.env['AGENTSPEC_ADMIN_KEY'] = 'env-key'

    const result = resolveCluster({})
    expect(result).toEqual({ controlPlaneUrl: 'http://env:8080', adminKey: 'env-key' })
  })

  it('explicit args override env vars', () => {
    process.env['AGENTSPEC_CONTROL_PLANE_URL'] = 'http://env:8080'
    process.env['AGENTSPEC_ADMIN_KEY'] = 'env-key'

    const result = resolveCluster({ controlPlaneUrl: 'http://override:9090', adminKey: 'override-key' })
    expect(result).toEqual({ controlPlaneUrl: 'http://override:9090', adminKey: 'override-key' })
  })

  it('returns undefined when neither args nor env are set', () => {
    delete process.env['AGENTSPEC_CONTROL_PLANE_URL']
    delete process.env['AGENTSPEC_ADMIN_KEY']

    const result = resolveCluster({})
    expect(result).toEqual({ controlPlaneUrl: undefined, adminKey: undefined })
  })

  it('partial override — controlPlaneUrl from arg, adminKey from env', () => {
    process.env['AGENTSPEC_ADMIN_KEY'] = 'env-key'

    const result = resolveCluster({ controlPlaneUrl: 'http://explicit:8080' })
    expect(result).toEqual({ controlPlaneUrl: 'http://explicit:8080', adminKey: 'env-key' })
  })
})
