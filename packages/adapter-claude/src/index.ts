/**
 * @agentspec/adapter-claude
 *
 * Agentic code generation using Claude API.
 * Claude receives the full manifest JSON + a framework-specific skill file as system prompt and
 * generates production-ready code covering all manifest fields.
 *
 * Requires: ANTHROPIC_API_KEY environment variable.
 *
 * Usage:
 *   import { generateWithClaude, listFrameworks } from '@agentspec/adapter-claude'
 *   const result = await generateWithClaude(manifest, { framework: 'langgraph' })
 *   const frameworks = listFrameworks() // ['crewai', 'langgraph', 'mastra']
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentSpecManifest, GeneratedAgent } from '@agentspec/sdk'
import { buildContext } from './context-builder.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(__dirname, 'skills')

/**
 * Returns the list of supported framework names (based on .md files in skills/).
 * Excludes guidelines.md which is a universal base layer, not a framework.
 */
export function listFrameworks(): string[] {
  return readdirSync(skillsDir)
    .filter((f) => f.endsWith('.md') && f !== 'guidelines.md')
    .map((f) => f.slice(0, -3))
    .sort()
}

/**
 * Load the skill file for a given framework, prepended with universal guidelines.
 * Throws a descriptive error if the framework is not supported.
 */
function loadSkill(framework: string): string {
  const available = listFrameworks()
  if (!available.includes(framework)) {
    throw new Error(
      `Framework '${framework}' is not supported. Available: ${available.join(', ')}`,
    )
  }
  const guidelinesPath = join(skillsDir, 'guidelines.md')
  let guidelines = ''
  try {
    guidelines = readFileSync(guidelinesPath, 'utf-8') + '\n\n---\n\n'
  } catch {
    // guidelines.md is optional — skip if missing
  }
  return guidelines + readFileSync(join(skillsDir, `${framework}.md`), 'utf-8')
}

/**
 * Guard ANTHROPIC_API_KEY and return a configured Anthropic client.
 * Throws with a remediation message if the key is missing.
 */
function initClaudeClient(): Anthropic {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. AgentSpec generates code using Claude.\n' +
        'Get a key at https://console.anthropic.com and add it to your environment.',
    )
  }
  const baseURL = process.env['ANTHROPIC_BASE_URL']
  return new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })
}

/** System prompt used exclusively by repairYaml — knows AgentSpec v1 schema rules. */
const REPAIR_SYSTEM_PROMPT =
  `You are an AgentSpec v1 YAML schema fixer.\n` +
  `Fix the agent.yaml provided by the user so it complies with the AgentSpec v1 schema.\n` +
  `Return ONLY a JSON object with this exact shape (no other text):\n` +
  `{"files":{"agent.yaml":"<corrected YAML>"},"installCommands":[],"envVars":[]}\n\n` +
  `## AgentSpec v1 schema rules (enforce all of these):\n` +
  `- Top-level keys: apiVersion: "agentspec.io/v1", kind: "AgentSpec"\n` +
  `- metadata: name (slug a-z0-9-), version (semver), description\n` +
  `- spec.model: provider, id (never "name"), apiKey: "$env:VAR"\n` +
  `- spec.model.fallback: provider, id, apiKey, triggerOn (array of strings)\n` +
  `- spec.tools[]: name (slug), type: "function", description\n` +
  `- spec.memory.shortTerm.backend: "redis" | "in-memory" | "sqlite"\n` +
  `- spec.memory.longTerm.backend: "postgres" | "sqlite" | "mongodb"\n` +
  `- spec.guardrails.input: array of guardrail objects (not a scalar)\n` +
  `- spec.guardrails.output: array of guardrail objects (not a scalar)\n` +
  `- spec.requires.envVars: array of strings (key is "envVars", not "env")\n` +
  `- spec.requires.services[]: {type, connection: "$env:VAR"}`

export interface GenerationProgress {
  /** Cumulative output characters received so far during streaming. */
  outputChars: number
}

export interface ClaudeAdapterOptions {
  /** Target framework (e.g. 'langgraph', 'crewai', 'mastra'). */
  framework: string
  /** Claude model ID. Defaults to claude-opus-4-6. */
  model?: string
  /** Optional source files to append to the user message for richer context. */
  contextFiles?: string[]
  /**
   * Base directory of the manifest file. When provided, $file: references in
   * spec.tools[].module are automatically resolved and included as context files.
   */
  manifestDir?: string
  /**
   * Called on each streamed chunk with cumulative char count.
   * When provided, generation uses the streaming API so the caller can show
   * a live progress indicator. Omit to use a single blocking request.
   */
  onProgress?: (progress: GenerationProgress) => void
}

/**
 * Generate agent code using Claude API.
 *
 * Throws if ANTHROPIC_API_KEY is not set (with a helpful remediation message).
 * Throws if the framework is not supported.
 * Throws if Claude does not return a parseable JSON response.
 */
export async function generateWithClaude(
  manifest: AgentSpecManifest,
  options: ClaudeAdapterOptions,
): Promise<GeneratedAgent> {
  const client = initClaudeClient()
  const skillMd = loadSkill(options.framework)

  const context = buildContext({
    manifest,
    contextFiles: options.contextFiles,
    manifestDir: options.manifestDir,
  })
  const model = options.model ?? process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-4-6'

  const requestParams = {
    model,
    max_tokens: 32768,
    system: skillMd,
    messages: [{ role: 'user' as const, content: context }],
  }

  let text: string

  if (options.onProgress) {
    // Streaming path — yields chunks so the caller can show live progress.
    let accumulated = ''
    for await (const event of client.messages.stream(requestParams)) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        accumulated += event.delta.text
        options.onProgress({ outputChars: accumulated.length })
      }
    }
    text = accumulated
  } else {
    // Blocking path — single request, no progress callbacks.
    const response = await client.messages.create(requestParams)
    text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
  }

  return extractGeneratedAgent(text, options.framework)
}

// ── YAML repair ──────────────────────────────────────────────────────────────

export interface RepairOptions {
  /** Claude model ID. Defaults to claude-opus-4-6. */
  model?: string
}

/**
 * Ask Claude to fix an agent.yaml string that failed schema validation.
 *
 * Reuses the scan skill as the system prompt (it carries full schema knowledge).
 * Returns the repaired YAML string, ready to be re-validated by the caller.
 *
 * Throws if ANTHROPIC_API_KEY is not set or Claude does not return a parseable response.
 */
export async function repairYaml(
  yamlStr: string,
  validationErrors: string,
  options: RepairOptions = {},
): Promise<string> {
  const client = initClaudeClient()
  const model = options.model ?? process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-4-6'

  const userMessage =
    `The following agent.yaml failed AgentSpec v1 schema validation.\n` +
    `Fix ALL the errors listed below and return the corrected file in the same JSON format.\n\n` +
    `## Current (invalid) YAML:\n\`\`\`yaml\n${yamlStr}\n\`\`\`\n\n` +
    `## Validation errors:\n\`\`\`\n${validationErrors}\n\`\`\`\n\n` +
    `Return ONLY a JSON object (no other text):\n` +
    `\`\`\`json\n{"files":{"agent.yaml":"<corrected YAML>"},"installCommands":[],"envVars":[]}\n\`\`\``

  const response = await client.messages.create({
    model,
    max_tokens: 16384,
    system: REPAIR_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: userMessage }],
  })

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')

  const result = extractGeneratedAgent(text, 'scan')
  const fixed = result.files['agent.yaml']
  if (!fixed) throw new Error('Claude did not return agent.yaml in repair response.')
  return fixed
}

// ── Response parsing ──────────────────────────────────────────────────────────

interface ClaudeGenerationResult {
  files: Record<string, string>
  installCommands?: string[]
  envVars?: string[]
}

function extractGeneratedAgent(text: string, framework: string): GeneratedAgent {
  // Build candidates in priority order and return the first one that parses
  // correctly. Multiple strategies are needed because:
  //
  //   1. Claude may return bare JSON (no fence).
  //   2. Claude may wrap in ```json … ``` but the generated code inside the
  //      JSON string values can contain backtick sequences that fool a naive
  //      non-greedy regex — so we use lastIndexOf('\n```') as the close marker.
  //   3. As a last resort, pull the outermost {...} from the text.
  const candidates: string[] = []

  const trimmed = text.trim()

  // Strategy 1: bare JSON
  if (trimmed.startsWith('{')) {
    candidates.push(trimmed)
  }

  // Strategy 2: ```json fence — close at the last newline+``` to survive
  //             backtick sequences embedded inside generated code strings.
  const fenceOpen = text.indexOf('```json')
  if (fenceOpen !== -1) {
    const contentStart = text.indexOf('\n', fenceOpen) + 1
    const fenceClose = text.lastIndexOf('\n```')
    if (fenceClose > contentStart) {
      candidates.push(text.slice(contentStart, fenceClose))
    }
  }

  // Strategy 3: greedy brace match
  const braceMatch = text.match(/(\{[\s\S]*\})/)
  if (braceMatch?.[1]) candidates.push(braceMatch[1])

  let parsedAny = false
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    parsedAny = true
    if (!parsed || typeof parsed !== 'object' || !('files' in parsed)) continue

    const result = parsed as ClaudeGenerationResult
    return {
      framework,
      files: result.files,
      installCommands: result.installCommands ?? [],
      envVars: result.envVars ?? [],
      readme: result.files['README.md'] ?? '',
    }
  }

  if (parsedAny) {
    throw new Error('Claude response JSON is missing the required "files" field.')
  }

  throw new Error(
    `Claude did not return a valid JSON response.\n\nReceived:\n${text.slice(0, 500)}`,
  )
}
