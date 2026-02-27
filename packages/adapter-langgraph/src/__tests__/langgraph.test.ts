import { describe, it, expect, beforeAll } from 'vitest'
import type { AgentSpecManifest } from '@agentspec/sdk'

// Side-effect import registers the adapter
import '@agentspec/adapter-langgraph'
import { generateAdapter } from '@agentspec/sdk'

// ── Minimal manifest fixture ───────────────────────────────────────────────────

const baseManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'test-agent',
    version: '1.0.0',
    description: 'Test agent for adapter tests',
  },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
    },
    prompts: {
      system: '$file:prompts/system.md',
      hotReload: false,
    },
    tools: [
      {
        name: 'search-web',
        type: 'function',
        description: 'Search the web',
        function: 'search_web',
      },
    ],
  },
}

const redisManifest: AgentSpecManifest = {
  ...baseManifest,
  spec: {
    ...baseManifest.spec,
    memory: {
      shortTerm: {
        backend: 'redis',
        connection: '$env:REDIS_URL',
        maxTokens: 4000,
        ttlSeconds: 3600,
      },
    },
  },
}

const inMemoryManifest: AgentSpecManifest = {
  ...baseManifest,
  spec: {
    ...baseManifest.spec,
    memory: {
      shortTerm: {
        backend: 'in-memory',
        maxTokens: 4000,
      },
    },
  },
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LangGraph adapter — generate()', () => {
  describe('output files', () => {
    it('returns agent.py, requirements.txt, and .env.example', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.files).toHaveProperty('agent.py')
      expect(result.files).toHaveProperty('requirements.txt')
      expect(result.files).toHaveProperty('.env.example')
    })

    it('returns framework name "langgraph"', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.framework).toBe('langgraph')
    })

    it('includes installCommands', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.installCommands.length).toBeGreaterThan(0)
    })
  })

  describe('agent.py — model provider', () => {
    it('imports langchain_groq for groq provider', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.files['agent.py']).toContain('langchain_groq')
    })

    it('imports langchain_openai for openai provider', () => {
      const openaiManifest: AgentSpecManifest = {
        ...baseManifest,
        spec: {
          ...baseManifest.spec,
          model: { ...baseManifest.spec.model, provider: 'openai', id: 'gpt-4o' },
        },
      }
      const result = generateAdapter(openaiManifest, 'langgraph')
      expect(result.files['agent.py']).toContain('langchain_openai')
    })
  })

  describe('agent.py — tools', () => {
    it('references the tool function name', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.files['agent.py']).toContain('search_web')
    })
  })

  describe('requirements.txt', () => {
    it('includes langgraph', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.files['requirements.txt']).toContain('langgraph')
    })

    it('includes the provider package for groq', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.files['requirements.txt']).toContain('langchain-groq')
    })
  })

  describe('.env.example', () => {
    it('contains the API key env var name', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.files['.env.example']).toContain('GROQ_API_KEY')
    })
  })

  describe('agent.py — memory backend', () => {
    it('uses RedisSaver when shortTerm.backend is redis', () => {
      const result = generateAdapter(redisManifest, 'langgraph')
      expect(result.files['agent.py']).toContain('RedisSaver')
    })

    it('uses MemorySaver when shortTerm.backend is in-memory', () => {
      const result = generateAdapter(inMemoryManifest, 'langgraph')
      expect(result.files['agent.py']).toContain('MemorySaver')
    })

    it('does not include memory imports when no memory configured', () => {
      const result = generateAdapter(baseManifest, 'langgraph')
      expect(result.files['agent.py']).not.toContain('RedisSaver')
      expect(result.files['agent.py']).not.toContain('MemorySaver')
    })
  })

  describe('agent.py — guardrails', () => {
    it('imports guardrails when spec.guardrails is set', () => {
      const guardedManifest: AgentSpecManifest = {
        ...baseManifest,
        spec: {
          ...baseManifest.spec,
          guardrails: {
            input: [{ type: 'prompt-injection', action: 'reject' }],
          },
        },
      }
      const result = generateAdapter(guardedManifest, 'langgraph')
      expect(result.files['agent.py']).toContain('run_input_guardrails')
      expect(result.files).toHaveProperty('guardrails.py')
    })
  })

  describe('optional outputs', () => {
    it('includes Dockerfile when includeDockerfile: true', () => {
      const result = generateAdapter(baseManifest, 'langgraph', { includeDockerfile: true })
      expect(result.files).toHaveProperty('Dockerfile')
    })

    it('includes server.py when includeApiServer: true', () => {
      const result = generateAdapter(baseManifest, 'langgraph', { includeApiServer: true })
      expect(result.files).toHaveProperty('server.py')
    })
  })
})
