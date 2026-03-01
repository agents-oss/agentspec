/**
 * Unit tests for audit ring, /audit, and /audit/stream endpoints.
 */

import { describe, it, expect } from 'vitest'
import { buildControlPlaneApp } from '../control-plane/index.js'
import { AuditRing, type AuditEntry } from '../audit-ring.js'
import { testManifest } from './fixtures.js'

describe('AuditRing (unit)', () => {
  it('stores pushed entries', () => {
    const ring = new AuditRing(10)
    const entry: AuditEntry = {
      requestId: 'req-001',
      timestamp: new Date().toISOString(),
      method: 'GET',
      path: '/chat',
      statusCode: 200,
    }
    ring.push(entry)
    expect(ring.getAll()).toHaveLength(1)
    expect(ring.getAll()[0]).toEqual(entry)
  })

  it('evicts oldest entry when ring is full (O(1) circular buffer)', () => {
    const ring = new AuditRing(3)
    for (let i = 0; i < 4; i++) {
      ring.push({ requestId: `req-${i}`, timestamp: '', method: 'GET', path: '/' })
    }
    // After 4 pushes into a size-3 ring: req-0 evicted, req-1..req-3 remain
    expect(ring.size).toBe(3)
    expect(ring.findById('req-0')).toBeUndefined()
    expect(ring.findById('req-1')).toBeDefined()
    expect(ring.findById('req-2')).toBeDefined()
    expect(ring.findById('req-3')).toBeDefined()
    // getAll returns entries in insertion order
    const ids = ring.getAll().map((e) => e.requestId)
    expect(ids).toEqual(['req-1', 'req-2', 'req-3'])
  })

  it('findById returns the correct entry', () => {
    const ring = new AuditRing()
    ring.push({ requestId: 'abc', timestamp: '', method: 'POST', path: '/chat' })
    expect(ring.findById('abc')?.path).toBe('/chat')
  })

  it('notifies subscribers on push', () => {
    const ring = new AuditRing()
    const received: AuditEntry[] = []
    ring.subscribe((e) => received.push(e))
    ring.push({ requestId: 'x', timestamp: '', method: 'GET', path: '/' })
    expect(received).toHaveLength(1)
  })

  it('unsubscribe stops notifications', () => {
    const ring = new AuditRing()
    const received: AuditEntry[] = []
    const unsub = ring.subscribe((e) => received.push(e))
    unsub()
    ring.push({ requestId: 'y', timestamp: '', method: 'GET', path: '/' })
    expect(received).toHaveLength(0)
  })
})

describe('GET /audit', () => {
  it('returns 200 with empty array when ring is empty', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    const res = await app.inject({ method: 'GET', url: '/audit' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns entries previously pushed to the ring', async () => {
    const ring = new AuditRing()
    ring.push({
      requestId: 'req-abc',
      timestamp: new Date().toISOString(),
      method: 'POST',
      path: '/v1/chat',
      statusCode: 200,
    })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await app.inject({ method: 'GET', url: '/audit' })
    const entries = JSON.parse(res.body) as AuditEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.requestId).toBe('req-abc')
  })

  it('each entry has requestId, timestamp, method, path', async () => {
    const ring = new AuditRing()
    ring.push({ requestId: 'r1', timestamp: '2026-01-01T00:00:00Z', method: 'GET', path: '/chat' })
    const app = await buildControlPlaneApp(testManifest, ring)
    const res = await app.inject({ method: 'GET', url: '/audit' })
    const entries = JSON.parse(res.body) as AuditEntry[]
    const entry = entries[0]!
    expect(entry.requestId).toBe('r1')
    expect(entry.timestamp).toBeTruthy()
    expect(entry.method).toBe('GET')
    expect(entry.path).toBe('/chat')
  })
})

describe('GET /audit/stream', () => {
  it('sets Content-Type to text/event-stream', async () => {
    const app = await buildControlPlaneApp(testManifest, new AuditRing())
    // SSE is a persistent connection — use a real server + fetch with AbortController
    // so we can check response headers before the stream ends
    await app.listen({ port: 0 })
    const { port } = app.server.address() as { port: number }

    const controller = new AbortController()
    let contentType: string | null = null
    try {
      const res = await fetch(`http://localhost:${port}/audit/stream`, {
        signal: controller.signal,
      })
      contentType = res.headers.get('content-type')
    } catch {
      // AbortError is expected; headers are read before aborting
    } finally {
      controller.abort()
      await app.close()
    }

    expect(contentType).toMatch(/text\/event-stream/)
  })
})
