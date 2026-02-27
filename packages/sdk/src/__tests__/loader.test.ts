import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  loadManifest,
  tryLoadManifest,
  migrateManifest,
  isLatestVersion,
  detectVersion,
  LATEST_API_VERSION,
} from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const repoRoot = resolve(__dirname, '../../../..')
const exampleManifest = resolve(repoRoot, 'examples/budgetbud/agent.yaml')

// ── loadManifest ───────────────────────────────────────────────────────────────

describe('loadManifest()', () => {
  it('loads and validates the budgetbud example manifest', () => {
    const result = loadManifest(exampleManifest)
    expect(result.manifest.apiVersion).toBe('agentspec.io/v1')
    expect(result.manifest.kind).toBe('AgentSpec')
    expect(result.manifest.metadata.name).toBeTruthy()
    expect(result.filePath).toBe(exampleManifest)
    expect(result.raw).toContain('apiVersion')
  })

  it('returns manifest with spec.model populated', () => {
    const { manifest } = loadManifest(exampleManifest)
    expect(manifest.spec.model.provider).toBeTruthy()
    expect(manifest.spec.model.id).toBeTruthy()
  })

  it('throws an error with the file path when file does not exist', () => {
    expect(() => loadManifest('/nonexistent/agent.yaml')).toThrow(
      /Cannot read manifest/,
    )
  })

  it('throws with the missing file path in the error message', () => {
    const missingPath = '/totally/missing/agent.yaml'
    expect(() => loadManifest(missingPath)).toThrow(missingPath)
  })
})

describe('tryLoadManifest()', () => {
  it('returns { ok: true, data } for a valid file', () => {
    const result = tryLoadManifest(exampleManifest)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.manifest.apiVersion).toBe('agentspec.io/v1')
    }
  })

  it('returns { ok: false, error } for a missing file', () => {
    const result = tryLoadManifest('/nonexistent/agent.yaml')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error)
    }
  })
})

// ── isLatestVersion ────────────────────────────────────────────────────────────

describe('isLatestVersion()', () => {
  it('returns true for the current latest apiVersion', () => {
    expect(isLatestVersion({ apiVersion: 'agentspec.io/v1' })).toBe(true)
  })

  it('returns false for a legacy apiVersion', () => {
    expect(isLatestVersion({ apiVersion: 'agentspec/v1alpha1' })).toBe(false)
  })

  it('returns false for an unknown apiVersion', () => {
    expect(isLatestVersion({ apiVersion: 'unknown/v99' })).toBe(false)
  })

  it('returns false when apiVersion is missing', () => {
    expect(isLatestVersion({})).toBe(false)
  })
})

// ── detectVersion ──────────────────────────────────────────────────────────────

describe('detectVersion()', () => {
  it('returns the apiVersion from the manifest', () => {
    expect(detectVersion({ apiVersion: 'agentspec.io/v1' })).toBe('agentspec.io/v1')
  })

  it('returns the legacy version correctly', () => {
    expect(detectVersion({ apiVersion: 'agentspec/v1alpha1' })).toBe('agentspec/v1alpha1')
  })

  it('returns "unknown" when apiVersion is missing', () => {
    expect(detectVersion({})).toBe('unknown')
  })
})

// ── migrateManifest ────────────────────────────────────────────────────────────

describe('migrateManifest()', () => {
  it('migrates agentspec/v1alpha1 to agentspec.io/v1', () => {
    const input = {
      apiVersion: 'agentspec/v1alpha1',
      metadata: { name: 'test' },
    }
    const { result, migrationsApplied } = migrateManifest(input)
    expect(result.apiVersion).toBe('agentspec.io/v1')
    expect(migrationsApplied).toHaveLength(1)
    expect(migrationsApplied[0]).toContain('agentspec/v1alpha1')
  })

  it('adds default kind: AgentSpec when kind is missing during migration', () => {
    const input = { apiVersion: 'agentspec/v1alpha1' }
    const { result } = migrateManifest(input)
    expect(result.kind).toBe('AgentSpec')
  })

  it('preserves existing kind when present during migration', () => {
    const input = { apiVersion: 'agentspec/v1alpha1', kind: 'AgentSpec' }
    const { result } = migrateManifest(input)
    expect(result.kind).toBe('AgentSpec')
  })

  it('returns the manifest unchanged when already at latest version', () => {
    const input = {
      apiVersion: 'agentspec.io/v1',
      kind: 'AgentSpec',
      metadata: { name: 'test' },
    }
    const { result, migrationsApplied } = migrateManifest(input)
    expect(result.apiVersion).toBe('agentspec.io/v1')
    expect(migrationsApplied).toHaveLength(0)
  })

  it('preserves all non-version fields during migration', () => {
    const input = {
      apiVersion: 'agentspec/v1alpha1',
      metadata: { name: 'my-agent', version: '2.0.0' },
      spec: { model: { provider: 'openai' } },
    }
    const { result } = migrateManifest(input)
    expect((result.metadata as Record<string, unknown>).name).toBe('my-agent')
    expect((result.spec as Record<string, unknown>).model).toEqual({ provider: 'openai' })
  })
})

// ── LATEST_API_VERSION constant ────────────────────────────────────────────────

describe('LATEST_API_VERSION', () => {
  it('is agentspec.io/v1', () => {
    expect(LATEST_API_VERSION).toBe('agentspec.io/v1')
  })
})
