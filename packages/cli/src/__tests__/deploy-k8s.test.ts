/**
 * Unit tests for the Kubernetes manifest generator.
 *
 * generateK8sManifests() is a pure function: no I/O, no LLM, no network.
 * It takes an AgentSpecManifest and returns a Record<string, string> of
 * k8s YAML files ready to apply with kubectl.
 */

import { describe, expect, it } from 'vitest'
import type { AgentSpecManifest } from '@agentspec/sdk'
import { generateK8sManifests } from '../deploy/k8s.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const minimalManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'my-agent',
    version: '0.1.0',
    description: 'Test agent',
  },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
    },
    prompts: {
      system: 'You are a helpful assistant.',
      hotReload: false,
    },
  },
}

const fullManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'budget-assistant',
    version: '1.2.3',
    description: 'Budget management assistant',
  },
  spec: {
    model: {
      provider: 'openai',
      id: 'gpt-4o',
      apiKey: '$env:OPENAI_API_KEY',
      fallback: {
        provider: 'groq',
        id: 'llama-3.3-70b-versatile',
        apiKey: '$env:GROQ_API_KEY',
      },
    },
    prompts: {
      system: '$file:prompts/system.md',
      hotReload: false,
    },
    api: {
      type: 'rest',
      port: 3000,
      streaming: false,
    },
    requires: {
      envVars: ['OPENAI_API_KEY', 'DATABASE_URL', 'REDIS_URL'],
      services: [
        { type: 'postgres', connection: '$env:DATABASE_URL' },
        { type: 'redis', connection: '$env:REDIS_URL' },
      ],
    },
  },
}

// ── Tests: output file keys ────────────────────────────────────────────────────

describe('generateK8sManifests — output file keys', () => {
  it('returns k8s/deployment.yaml', () => {
    const files = generateK8sManifests(minimalManifest)
    expect(Object.keys(files)).toContain('k8s/deployment.yaml')
  })

  it('returns k8s/service.yaml', () => {
    const files = generateK8sManifests(minimalManifest)
    expect(Object.keys(files)).toContain('k8s/service.yaml')
  })

  it('returns k8s/configmap.yaml', () => {
    const files = generateK8sManifests(minimalManifest)
    expect(Object.keys(files)).toContain('k8s/configmap.yaml')
  })

  it('returns k8s/secret.yaml.example', () => {
    const files = generateK8sManifests(minimalManifest)
    expect(Object.keys(files)).toContain('k8s/secret.yaml.example')
  })
})

// ── Tests: deployment.yaml ─────────────────────────────────────────────────────

describe('generateK8sManifests — deployment.yaml', () => {
  it('contains kind: Deployment', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('kind: Deployment')
  })

  it('uses metadata.name as Deployment name', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('name: my-agent')
  })

  it('uses metadata.name as app label', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('app: my-agent')
  })

  it('includes the agent container', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('name: my-agent')
  })

  it('includes the agentspec-sidecar container', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('name: agentspec-sidecar')
  })

  it('sidecar uses ghcr.io/agentspec/sidecar image', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('ghcr.io/agentspec/sidecar')
  })

  it('defaults to port 8000 when spec.api is not set', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('8000')
  })

  it('uses spec.api.port when set', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(fullManifest)
    expect(yaml).toContain('3000')
  })

  it('sidecar proxy port 4000 is present', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('4000')
  })

  it('sidecar control-plane port 4001 is present', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('4001')
  })

  it('UPSTREAM_URL points to the agent port', () => {
    const { 'k8s/deployment.yaml': yaml } = generateK8sManifests(fullManifest)
    expect(yaml).toContain('UPSTREAM_URL')
    expect(yaml).toContain('3000')
  })
})

// ── Tests: service.yaml ────────────────────────────────────────────────────────

describe('generateK8sManifests — service.yaml', () => {
  it('contains kind: Service', () => {
    const { 'k8s/service.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('kind: Service')
  })

  it('uses metadata.name as Service name', () => {
    const { 'k8s/service.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('name: my-agent')
  })

  it('selects pods by app label', () => {
    const { 'k8s/service.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('app: my-agent')
  })

  it('exposes default port 8000 when spec.api not set', () => {
    const { 'k8s/service.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('8000')
  })

  it('exposes spec.api.port when set', () => {
    const { 'k8s/service.yaml': yaml } = generateK8sManifests(fullManifest)
    expect(yaml).toContain('3000')
  })
})

// ── Tests: configmap.yaml ──────────────────────────────────────────────────────

describe('generateK8sManifests — configmap.yaml', () => {
  it('contains kind: ConfigMap', () => {
    const { 'k8s/configmap.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('kind: ConfigMap')
  })

  it('uses metadata.name in ConfigMap name', () => {
    const { 'k8s/configmap.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('my-agent')
  })

  it('includes model provider as non-secret config', () => {
    const { 'k8s/configmap.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('groq')
  })

  it('includes model id as non-secret config', () => {
    const { 'k8s/configmap.yaml': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('llama-3.3-70b-versatile')
  })

  it('does not contain $env: references (no secret leakage)', () => {
    const { 'k8s/configmap.yaml': yaml } = generateK8sManifests(fullManifest)
    expect(yaml).not.toContain('$env:')
  })

  it('does not contain $secret: references', () => {
    const { 'k8s/configmap.yaml': yaml } = generateK8sManifests(fullManifest)
    expect(yaml).not.toContain('$secret:')
  })
})

// ── Tests: secret.yaml.example ─────────────────────────────────────────────────

describe('generateK8sManifests — secret.yaml.example', () => {
  it('contains kind: Secret', () => {
    const { 'k8s/secret.yaml.example': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('kind: Secret')
  })

  it('includes $env: vars from model.apiKey', () => {
    const { 'k8s/secret.yaml.example': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('GROQ_API_KEY')
  })

  it('includes all $env: vars from a full manifest', () => {
    const { 'k8s/secret.yaml.example': yaml } = generateK8sManifests(fullManifest)
    expect(yaml).toContain('OPENAI_API_KEY')
    expect(yaml).toContain('GROQ_API_KEY')
    expect(yaml).toContain('DATABASE_URL')
    expect(yaml).toContain('REDIS_URL')
  })

  it('deduplicates repeated $env: refs (same var mentioned twice → appears once)', () => {
    // GROQ_API_KEY appears in model.fallback.apiKey AND could appear in requires.envVars
    const manifest: AgentSpecManifest = {
      ...fullManifest,
      spec: {
        ...fullManifest.spec,
        requires: { envVars: ['GROQ_API_KEY'] }, // same as fallback apiKey
      },
    }
    const { 'k8s/secret.yaml.example': yaml } = generateK8sManifests(manifest)
    const count = (yaml.match(/GROQ_API_KEY/g) ?? []).length
    expect(count).toBe(1)
  })

  it('has an explanatory comment marking it as a template', () => {
    const { 'k8s/secret.yaml.example': yaml } = generateK8sManifests(minimalManifest)
    // Must explain this is an example / template — not for committing real values
    expect(yaml.toLowerCase()).toMatch(/example|template|do not commit/i)
  })

  it('uses metadata.name in Secret name', () => {
    const { 'k8s/secret.yaml.example': yaml } = generateK8sManifests(minimalManifest)
    expect(yaml).toContain('my-agent')
  })
})

// ── Tests: minimal manifest (edge case) ────────────────────────────────────────

describe('generateK8sManifests — minimal manifest', () => {
  it('does not throw with no spec.api, no spec.requires', () => {
    expect(() => generateK8sManifests(minimalManifest)).not.toThrow()
  })

  it('still generates all 4 files for minimal manifest', () => {
    const files = generateK8sManifests(minimalManifest)
    expect(Object.keys(files).length).toBe(4)
  })
})

// ── Tests: YAML safety ─────────────────────────────────────────────────────────

describe('generateK8sManifests — YAML safety', () => {
  it('throws when metadata.name contains a colon', () => {
    const bad = { ...minimalManifest, metadata: { ...minimalManifest.metadata, name: 'my:agent' } }
    expect(() => generateK8sManifests(bad)).toThrow(/invalid.*name/i)
  })

  it('throws when metadata.name contains a hash character', () => {
    const bad = { ...minimalManifest, metadata: { ...minimalManifest.metadata, name: 'agent#1' } }
    expect(() => generateK8sManifests(bad)).toThrow(/invalid.*name/i)
  })

  it('throws when metadata.name contains uppercase letters', () => {
    const bad = { ...minimalManifest, metadata: { ...minimalManifest.metadata, name: 'MyAgent' } }
    expect(() => generateK8sManifests(bad)).toThrow(/invalid.*name/i)
  })

  it('accepts valid lowercase DNS-label names', () => {
    const good = { ...minimalManifest, metadata: { ...minimalManifest.metadata, name: 'my-agent-v2' } }
    expect(() => generateK8sManifests(good)).not.toThrow()
  })

  it('escapes backslash in configmap double-quoted values', () => {
    const m = { ...minimalManifest, spec: { ...minimalManifest.spec, model: { ...minimalManifest.spec.model, id: 'llama\\special' } } }
    const { 'k8s/configmap.yaml': yaml } = generateK8sManifests(m)
    expect(yaml).toContain('"llama\\\\special"')
  })

  it('escapes double-quote in configmap double-quoted values', () => {
    const m = { ...minimalManifest, spec: { ...minimalManifest.spec, model: { ...minimalManifest.spec.model, id: 'llama"special' } } }
    const { 'k8s/configmap.yaml': yaml } = generateK8sManifests(m)
    expect(yaml).toContain('"llama\\"special"')
  })
})
