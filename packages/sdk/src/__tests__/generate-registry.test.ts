/**
 * Unit tests for generate/index.ts — framework adapter registry.
 *
 * The registry (_registry Map) is module-level state. Each test file gets its
 * own module instance in Vitest (isolateModules default), so the registry
 * starts empty for this file. Within the file, tests accumulate registrations —
 * we use unique framework names per test to avoid inter-test collisions.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import {
  registerAdapter,
  getAdapter,
  listAdapters,
  generateAdapter,
  type FrameworkAdapter,
  type GeneratedAgent,
} from '../generate/index.js'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: { name: 'test-agent', version: '1.0.0', description: 'test' },
  spec: {
    model: { provider: 'groq', id: 'llama', apiKey: '$env:API_KEY' },
    prompts: { system: 'You are helpful.', hotReload: false },
  },
}

const makeAdapter = (framework: string, overrides: Partial<FrameworkAdapter> = {}): FrameworkAdapter => ({
  framework,
  version: '1.0.0',
  generate: () => ({
    framework,
    files: { [`${framework}-agent.py`]: `# ${framework} agent` },
    installCommands: [`pip install ${framework}`],
    envVars: [`${framework.toUpperCase()}_API_KEY`],
    readme: `# ${framework} Agent`,
  }),
  ...overrides,
})

// ── getAdapter ─────────────────────────────────────────────────────────────────

describe('getAdapter', () => {
  it('returns undefined for unregistered framework', () => {
    const result = getAdapter('nonexistent-framework-xyz-abc')
    expect(result).toBeUndefined()
  })

  it('returns the adapter after it is registered', () => {
    const adapter = makeAdapter('getadapter-test-fw')
    registerAdapter(adapter)
    expect(getAdapter('getadapter-test-fw')).toBe(adapter)
  })

  it('is case-insensitive for lookup', () => {
    const adapter = makeAdapter('CaseSensitiveFW')
    registerAdapter(adapter)
    expect(getAdapter('casesensitivefw')).toBe(adapter)
    expect(getAdapter('CASESENSITIVEFW')).toBe(adapter)
    expect(getAdapter('CaseSensitiveFW')).toBe(adapter)
  })

  it('stores adapter under lowercase key regardless of declared framework name', () => {
    const adapter = makeAdapter('MixedCaseFramework')
    registerAdapter(adapter)
    // After registration, the registry key is lowercase
    expect(getAdapter('mixedcaseframework')).toBe(adapter)
  })
})

// ── registerAdapter ───────────────────────────────────────────────────────────

describe('registerAdapter', () => {
  it('overwrites previous registration for same framework', () => {
    const adapter1 = makeAdapter('overwrite-fw', { version: '1.0.0' })
    const adapter2 = makeAdapter('overwrite-fw', { version: '2.0.0' })
    registerAdapter(adapter1)
    registerAdapter(adapter2)
    const found = getAdapter('overwrite-fw')
    expect(found).toBe(adapter2)
    expect(found!.version).toBe('2.0.0')
  })

  it('can register multiple distinct frameworks', () => {
    registerAdapter(makeAdapter('fw-alpha'))
    registerAdapter(makeAdapter('fw-beta'))
    expect(getAdapter('fw-alpha')).toBeDefined()
    expect(getAdapter('fw-beta')).toBeDefined()
  })
})

// ── listAdapters ──────────────────────────────────────────────────────────────

describe('listAdapters', () => {
  beforeAll(() => {
    // Register known adapters for list tests
    registerAdapter(makeAdapter('list-fw-one'))
    registerAdapter(makeAdapter('list-fw-two'))
  })

  it('returns an array containing registered frameworks', () => {
    const names = listAdapters()
    expect(names).toContain('list-fw-one')
    expect(names).toContain('list-fw-two')
  })

  it('returns lowercase framework names', () => {
    registerAdapter(makeAdapter('UpperListFW'))
    const names = listAdapters()
    expect(names).toContain('upperlistfw')
    expect(names).not.toContain('UpperListFW')
  })

  it('returns an array (not a Map or Set)', () => {
    const names = listAdapters()
    expect(Array.isArray(names)).toBe(true)
  })
})

// ── generateAdapter ───────────────────────────────────────────────────────────

describe('generateAdapter', () => {
  it('throws when framework is not registered', () => {
    expect(() => generateAdapter(testManifest, 'totally-unregistered-xyz-123')).toThrow(
      'No adapter registered for framework: totally-unregistered-xyz-123',
    )
  })

  it('error message includes install hint', () => {
    try {
      generateAdapter(testManifest, 'unregistered-fw-hint-test')
    } catch (err) {
      expect((err as Error).message).toContain('Install an adapter package')
    }
  })

  it('error message includes "none" when listing available adapters is empty-ish', () => {
    // The error always shows available adapters — we just check the message is formed
    try {
      generateAdapter(testManifest, 'undefined-fw-list-check')
    } catch (err) {
      expect((err as Error).message).toContain('Available:')
    }
  })

  it('calls adapter.generate with manifest and no options by default', () => {
    const mockGenerate = vi.fn().mockReturnValue({
      framework: 'gen-fw',
      files: { 'agent.py': 'code' },
      installCommands: [],
      envVars: [],
      readme: '# Gen',
    } satisfies GeneratedAgent)

    registerAdapter({ framework: 'gen-fw', version: '1.0.0', generate: mockGenerate })

    generateAdapter(testManifest, 'gen-fw')

    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(mockGenerate).toHaveBeenCalledWith(testManifest, undefined)
  })

  it('passes options to adapter.generate', () => {
    const mockGenerate = vi.fn().mockReturnValue({
      framework: 'opts-fw',
      files: {},
      installCommands: [],
      envVars: [],
      readme: '',
    } satisfies GeneratedAgent)

    registerAdapter({ framework: 'opts-fw', version: '1.0.0', generate: mockGenerate })

    const options = { streaming: true, temperature: 0.7 }
    generateAdapter(testManifest, 'opts-fw', options)

    expect(mockGenerate).toHaveBeenCalledWith(testManifest, options)
  })

  it('returns the GeneratedAgent from adapter.generate', () => {
    const expected: GeneratedAgent = {
      framework: 'return-fw',
      files: { 'main.py': 'print("hello")' },
      installCommands: ['pip install langchain'],
      envVars: ['LANGCHAIN_API_KEY'],
      readme: '# Return FW Agent',
    }

    registerAdapter({
      framework: 'return-fw',
      version: '1.0.0',
      generate: () => expected,
    })

    const result = generateAdapter(testManifest, 'return-fw')

    expect(result).toBe(expected)
    expect(result.files).toEqual({ 'main.py': 'print("hello")' })
    expect(result.installCommands).toEqual(['pip install langchain'])
  })

  it('is case-insensitive for framework name lookup', () => {
    const mockGenerate = vi.fn().mockReturnValue({
      framework: 'icase-fw',
      files: {},
      installCommands: [],
      envVars: [],
      readme: '',
    } satisfies GeneratedAgent)

    registerAdapter({ framework: 'icase-fw', version: '1.0.0', generate: mockGenerate })

    // Call with uppercase — should still find the adapter
    generateAdapter(testManifest, 'ICASE-FW')

    expect(mockGenerate).toHaveBeenCalledOnce()
  })
})
