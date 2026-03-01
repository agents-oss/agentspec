import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentSpecManifest } from '@agentspec/sdk'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'test-agent',
    version: '1.0.0',
    description: 'Test agent',
  },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
    },
    prompts: {
      system: '$file:prompts/system.md',
    },
  },
}

// ── Mock @anthropic-ai/sdk before dynamic imports ─────────────────────────────

const mockCreate = vi.fn()
const mockStream = vi.fn()
const MockAnthropic = vi.fn().mockImplementation(() => ({
  messages: { create: mockCreate, stream: mockStream },
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: MockAnthropic,
}))

// ── Streaming helpers ─────────────────────────────────────────────────────────

// Produces an async iterable of content_block_delta events, matching the
// MessageStream async iterator API used by client.messages.stream().
function makeMockEventStream(jsonContent: object): AsyncIterable<object> {
  const text = `\`\`\`json\n${JSON.stringify(jsonContent)}\n\`\`\``
  // Split into a few chunks to simulate real streaming
  const chunks = [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))]
  return (async function* () {
    for (const chunk of chunks) {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } }
    }
  })()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClaudeResponse(jsonContent: object | string): object {
  const text = typeof jsonContent === 'string'
    ? jsonContent
    : `\`\`\`json\n${JSON.stringify(jsonContent)}\n\`\`\``

  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 200 },
  }
}

// ── context-builder tests ─────────────────────────────────────────────────────

describe('buildContext()', () => {
  let buildContext: (opts: { manifest: AgentSpecManifest; contextFiles?: string[] }) => string

  beforeEach(async () => {
    const mod = await import('../context-builder.js')
    buildContext = mod.buildContext
  })

  it('includes manifest as JSON code block', () => {
    const ctx = buildContext({ manifest: baseManifest })
    expect(ctx).toContain('```json')
    expect(ctx).toContain('"name": "test-agent"')
  })

  it('includes the manifest section header', () => {
    const ctx = buildContext({ manifest: baseManifest })
    expect(ctx).toContain('## Agent Manifest')
  })

  it('serialises all manifest fields', () => {
    const ctx = buildContext({ manifest: baseManifest })
    expect(ctx).toContain('"apiVersion": "agentspec.io/v1"')
    expect(ctx).toContain('"provider": "groq"')
  })

  it('silently skips missing context files', () => {
    expect(() =>
      buildContext({ manifest: baseManifest, contextFiles: ['/nonexistent/file.py'] }),
    ).not.toThrow()
  })

  it('does not include a context file section when files list is empty', () => {
    const ctx = buildContext({ manifest: baseManifest, contextFiles: [] })
    expect(ctx).not.toContain('## Context File:')
  })

  it('auto-resolves $file: module refs when manifestDir is provided', () => {
    const dir = join(tmpdir(), `agentspec-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const toolFile = join(dir, 'tool_implementations.py')
    writeFileSync(toolFile, 'def log_workout(exercises: list[str]) -> str: ...', 'utf-8')

    const manifestWithFileTool: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        tools: [
          {
            name: 'log-workout',
            description: 'Log a workout',
            module: '$file:tool_implementations.py',
          } as unknown as AgentSpecManifest['spec']['tools'][0],
        ],
      },
    }

    try {
      const ctx = buildContext({ manifest: manifestWithFileTool, manifestDir: dir })
      expect(ctx).toContain('## Context File:')
      expect(ctx).toContain('log_workout')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not auto-resolve $file: refs when manifestDir is not provided', () => {
    const manifestWithFileTool: AgentSpecManifest = {
      ...baseManifest,
      spec: {
        ...baseManifest.spec,
        tools: [
          {
            name: 'log-workout',
            description: 'Log a workout',
            module: '$file:tool_implementations.py',
          } as unknown as AgentSpecManifest['spec']['tools'][0],
        ],
      },
    }
    const ctx = buildContext({ manifest: manifestWithFileTool })
    expect(ctx).not.toContain('## Context File:')
  })
})

// ── listFrameworks() tests ────────────────────────────────────────────────────

describe('listFrameworks()', () => {
  let listFrameworks: () => string[]

  beforeEach(async () => {
    const mod = await import('../index.js')
    listFrameworks = mod.listFrameworks
  })

  it('returns an array that includes langgraph', () => {
    expect(listFrameworks()).toContain('langgraph')
  })

  it('returns an array that includes crewai', () => {
    expect(listFrameworks()).toContain('crewai')
  })

  it('returns an array that includes mastra', () => {
    expect(listFrameworks()).toContain('mastra')
  })

  it('returns at least 3 frameworks', () => {
    expect(listFrameworks().length).toBeGreaterThanOrEqual(3)
  })

  it('does not include "guidelines" in the list', () => {
    expect(listFrameworks()).not.toContain('guidelines')
  })

  it('returns an array that includes helm', () => {
    expect(listFrameworks()).toContain('helm')
  })
})

// ── loadSkill / guidelines prepend tests ──────────────────────────────────────

describe('loadSkill() guidelines prepend', () => {
  let generateWithClaude: (
    manifest: AgentSpecManifest,
    opts: { framework: string },
  ) => Promise<unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key'
    const mod = await import('../index.js')
    generateWithClaude = mod.generateWithClaude
  })

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('system prompt contains guidelines content (Universal Guidelines)', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
    )
    await generateWithClaude(baseManifest, { framework: 'langgraph' })
    const call = mockCreate.mock.calls[0]![0]
    // guidelines.md contains "Universal Guidelines"
    expect(call.system).toContain('Universal Guidelines')
  })

  it('system prompt contains both guidelines and framework-specific content', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
    )
    await generateWithClaude(baseManifest, { framework: 'langgraph' })
    const call = mockCreate.mock.calls[0]![0]
    // Both guidelines and langgraph.md content should be present
    expect(call.system).toContain('Universal Guidelines')
    expect(call.system).toContain('LangGraph')
  })
})

// ── generateWithClaude() tests ────────────────────────────────────────────────

describe('generateWithClaude()', () => {
  let generateWithClaude: (
    manifest: AgentSpecManifest,
    opts: { framework: string; model?: string; contextFiles?: string[] },
  ) => Promise<import('@agentspec/sdk').GeneratedAgent>

  const savedKey = process.env['ANTHROPIC_API_KEY']

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../index.js')
    generateWithClaude = mod.generateWithClaude
  })

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env['ANTHROPIC_API_KEY']
    } else {
      process.env['ANTHROPIC_API_KEY'] = savedKey
    }
  })

  describe('API key validation', () => {
    it('throws a helpful error when ANTHROPIC_API_KEY is not set', async () => {
      delete process.env['ANTHROPIC_API_KEY']
      await expect(
        generateWithClaude(baseManifest, { framework: 'langgraph' }),
      ).rejects.toThrow('ANTHROPIC_API_KEY')
    })

    it('error message tells user to set the key', async () => {
      delete process.env['ANTHROPIC_API_KEY']
      await expect(
        generateWithClaude(baseManifest, { framework: 'langgraph' }),
      ).rejects.toThrow('ANTHROPIC_API_KEY is not set')
    })

    it('error message mentions console.anthropic.com', async () => {
      delete process.env['ANTHROPIC_API_KEY']
      await expect(
        generateWithClaude(baseManifest, { framework: 'langgraph' }),
      ).rejects.toThrow('console.anthropic.com')
    })
  })

  describe('Framework validation', () => {
    beforeEach(() => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key'
    })

    it('throws for an unknown framework', async () => {
      await expect(
        generateWithClaude(baseManifest, { framework: 'unknown-fw' }),
      ).rejects.toThrow('not supported. Available:')
    })

    it('throws with available frameworks listed', async () => {
      await expect(
        generateWithClaude(baseManifest, { framework: 'unknown-fw' }),
      ).rejects.toThrow('langgraph')
    })
  })

  describe('ANTHROPIC_MODEL', () => {
    const savedModel = process.env['ANTHROPIC_MODEL']

    beforeEach(() => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key'
    })

    afterEach(() => {
      if (savedModel === undefined) {
        delete process.env['ANTHROPIC_MODEL']
      } else {
        process.env['ANTHROPIC_MODEL'] = savedModel
      }
    })

    it('uses ANTHROPIC_MODEL env var when options.model is not set', async () => {
      process.env['ANTHROPIC_MODEL'] = 'claude-sonnet-4-6'
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph' })
      const call = mockCreate.mock.calls[0]![0]
      expect(call.model).toBe('claude-sonnet-4-6')
    })

    it('options.model takes priority over ANTHROPIC_MODEL env var', async () => {
      process.env['ANTHROPIC_MODEL'] = 'claude-sonnet-4-6'
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph', model: 'claude-haiku-4-5-20251001' })
      const call = mockCreate.mock.calls[0]![0]
      expect(call.model).toBe('claude-haiku-4-5-20251001')
    })

    it('falls back to claude-opus-4-6 when neither options.model nor ANTHROPIC_MODEL is set', async () => {
      delete process.env['ANTHROPIC_MODEL']
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph' })
      const call = mockCreate.mock.calls[0]![0]
      expect(call.model).toBe('claude-opus-4-6')
    })
  })

  describe('ANTHROPIC_BASE_URL', () => {
    const savedBaseURL = process.env['ANTHROPIC_BASE_URL']

    beforeEach(() => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key'
    })

    afterEach(() => {
      if (savedBaseURL === undefined) {
        delete process.env['ANTHROPIC_BASE_URL']
      } else {
        process.env['ANTHROPIC_BASE_URL'] = savedBaseURL
      }
    })

    it('passes baseURL to Anthropic client when ANTHROPIC_BASE_URL is set', async () => {
      process.env['ANTHROPIC_BASE_URL'] = 'https://my-proxy.example.com'
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph' })
      const constructorCall = MockAnthropic.mock.calls[MockAnthropic.mock.calls.length - 1]![0]
      expect(constructorCall.baseURL).toBe('https://my-proxy.example.com')
    })

    it('does not set baseURL when ANTHROPIC_BASE_URL is not set', async () => {
      delete process.env['ANTHROPIC_BASE_URL']
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph' })
      const constructorCall = MockAnthropic.mock.calls[MockAnthropic.mock.calls.length - 1]![0]
      expect(constructorCall.baseURL).toBeUndefined()
    })
  })

  describe('Claude API invocation', () => {
    beforeEach(() => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key'
    })

    it('calls Anthropic messages.create with the manifest JSON in content', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# generated' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph' })
      expect(mockCreate).toHaveBeenCalledOnce()
      const call = mockCreate.mock.calls[0]![0]
      const userContent = JSON.stringify(call.messages[0].content)
      expect(userContent).toContain('test-agent')
    })

    it('uses claude-opus-4-6 as the default model', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph' })
      const call = mockCreate.mock.calls[0]![0]
      expect(call.model).toBe('claude-opus-4-6')
    })

    it('passes the langgraph skill as system prompt containing AgentSpec', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph' })
      const call = mockCreate.mock.calls[0]![0]
      expect(call.system).toContain('AgentSpec')
    })

    it('passes crewai skill as system prompt when framework is crewai', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'crew.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'crewai' })
      const call = mockCreate.mock.calls[0]![0]
      // crewai.md contains 'CrewAI' keyword
      expect(call.system).toContain('CrewAI')
    })

    it('passes mastra skill as system prompt when framework is mastra', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'src/agent.ts': '// x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'mastra' })
      const call = mockCreate.mock.calls[0]![0]
      // mastra.md contains 'Mastra' keyword
      expect(call.system).toContain('Mastra')
    })

    it('passes helm skill as system prompt when framework is helm', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'Chart.yaml': 'apiVersion: v2' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'helm' })
      const call = mockCreate.mock.calls[0]![0]
      // helm.md must mention Helm
      expect(call.system).toContain('Helm')
    })

    it('respects a custom model override', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      await generateWithClaude(baseManifest, { framework: 'langgraph', model: 'claude-haiku-4-5-20251001' })
      const call = mockCreate.mock.calls[0]![0]
      expect(call.model).toBe('claude-haiku-4-5-20251001')
    })
  })

  describe('Response parsing', () => {
    beforeEach(() => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key'
    })

    it('returns a GeneratedAgent with files from Claude JSON response', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({
          files: { 'agent.py': '# hello', 'requirements.txt': 'langgraph' },
          installCommands: ['pip install -r requirements.txt'],
          envVars: ['GROQ_API_KEY'],
        }),
      )
      const result = await generateWithClaude(baseManifest, { framework: 'langgraph' })
      expect(result.files['agent.py']).toBe('# hello')
      expect(result.files['requirements.txt']).toBe('langgraph')
      expect(result.installCommands).toContain('pip install -r requirements.txt')
      expect(result.envVars).toContain('GROQ_API_KEY')
    })

    it('sets framework on the returned GeneratedAgent', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '' }, installCommands: [], envVars: [] }),
      )
      const result = await generateWithClaude(baseManifest, { framework: 'langgraph' })
      expect(result.framework).toBe('langgraph')
    })

    it('handles optional installCommands and envVars with defaults', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ files: { 'agent.py': '# minimal' } }),
      )
      const result = await generateWithClaude(baseManifest, { framework: 'langgraph' })
      expect(result.installCommands).toEqual([])
      expect(result.envVars).toEqual([])
    })

    it('throws a helpful error when Claude returns non-JSON response', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Sorry, I cannot help with that.' }],
      })
      await expect(
        generateWithClaude(baseManifest, { framework: 'langgraph' }),
      ).rejects.toThrow('valid JSON')
    })

    it('throws when Claude JSON is missing the files field', async () => {
      mockCreate.mockResolvedValue(
        makeClaudeResponse({ installCommands: [], envVars: [] }),
      )
      await expect(
        generateWithClaude(baseManifest, { framework: 'langgraph' }),
      ).rejects.toThrow('files')
    })

    it('also parses raw JSON without code fence', async () => {
      const rawJson = JSON.stringify({ files: { 'agent.py': '# raw' }, installCommands: [], envVars: [] })
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: rawJson }],
      })
      const result = await generateWithClaude(baseManifest, { framework: 'langgraph' })
      expect(result.files['agent.py']).toBe('# raw')
    })

    it('parses correctly when generated code contains backtick sequences inside the fence', async () => {
      // Simulate Claude embedding Python code with triple backticks in the JSON string,
      // which breaks a naive non-greedy fence regex but must still parse correctly.
      const payload = {
        files: { 'agent.py': 'code with ```python\nblock\n``` inside' },
        installCommands: [],
        envVars: [],
      }
      const fencedText = '```json\n' + JSON.stringify(payload) + '\n```'
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: fencedText }],
      })
      const result = await generateWithClaude(baseManifest, { framework: 'langgraph' })
      expect(result.files['agent.py']).toContain('```python')
    })
  })

  describe('Streaming (onProgress)', () => {
    beforeEach(() => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key'
      vi.clearAllMocks()
    })

    it('uses streaming path when onProgress is provided', async () => {
      mockStream.mockReturnValue(
        makeMockEventStream({ files: { 'agent.py': '# streamed' }, installCommands: [], envVars: [] }),
      )
      const result = await generateWithClaude(baseManifest, {
        framework: 'langgraph',
        onProgress: () => {},
      })
      expect(mockStream).toHaveBeenCalledOnce()
      expect(mockCreate).not.toHaveBeenCalled()
      expect(result.files['agent.py']).toBe('# streamed')
    })

    it('calls onProgress with increasing outputChars', async () => {
      mockStream.mockReturnValue(
        makeMockEventStream({ files: { 'agent.py': '# x' }, installCommands: [], envVars: [] }),
      )
      const counts: number[] = []
      await generateWithClaude(baseManifest, {
        framework: 'langgraph',
        onProgress: ({ outputChars }) => counts.push(outputChars),
      })
      expect(counts.length).toBeGreaterThanOrEqual(2)
      expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]!)
    })
  })
})
