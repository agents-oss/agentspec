/**
 * Unit tests for /capabilities and /.well-known/agent.json endpoints.
 */

import { describe, it, expect } from 'vitest'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing } from '../audit-ring.js'
import { testManifest } from './fixtures.js'

interface AgentCard {
  schema_version: string
  name: string
  description: string
  url: string
  capabilities: { streaming: boolean; mcp: boolean }
  tools: Array<{ name: string; description: string }>
  subagents: unknown[]
  compliance_packs: string[]
  agentspec_version: string
}

describe('/capabilities', () => {
  it('returns 200', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/capabilities' })
    expect(res.statusCode).toBe(200)
  })

  it('response has schema_version "1.0"', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/capabilities' })
    const card = JSON.parse(res.body) as AgentCard
    expect(card.schema_version).toBe('1.0')
  })

  it('response name matches manifest metadata.name', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/capabilities' })
    const card = JSON.parse(res.body) as AgentCard
    expect(card.name).toBe('gymcoach')
  })

  it('response has description from manifest', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/capabilities' })
    const card = JSON.parse(res.body) as AgentCard
    expect(card.description).toBe('AI gym coaching assistant')
  })

  it('tools array has all spec.tools entries', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/capabilities' })
    const card = JSON.parse(res.body) as AgentCard
    expect(card.tools).toHaveLength(2)
    expect(card.tools.map((t) => t.name)).toContain('get-workout-history')
    expect(card.tools.map((t) => t.name)).toContain('log-workout')
  })

  it('each tool has name and description', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/capabilities' })
    const card = JSON.parse(res.body) as AgentCard
    for (const tool of card.tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
    }
  })

  it('capabilities.mcp is true', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/capabilities' })
    const card = JSON.parse(res.body) as AgentCard
    expect(card.capabilities.mcp).toBe(true)
  })

  it('agentspec_version field is present', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/capabilities' })
    const card = JSON.parse(res.body) as AgentCard
    expect(card.agentspec_version).toBeTruthy()
  })
})

describe('/.well-known/agent.json', () => {
  it('returns 200', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/.well-known/agent.json' })
    expect(res.statusCode).toBe(200)
  })

  it('returns identical content to /capabilities', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const capRes = await app.inject({ method: 'GET', url: '/capabilities' })
    const wkRes = await app.inject({ method: 'GET', url: '/.well-known/agent.json' })
    expect(JSON.parse(capRes.body)).toEqual(JSON.parse(wkRes.body))
  })
})
