import type { Command } from 'commander'
import { writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import chalk from 'chalk'
import * as p from '@clack/prompts'
import { printHeader } from '../utils/output.js'

export function registerInitCommand(program: Command): void {
  program
    .command('init [dir]')
    .description('Interactive wizard to create a new agent.yaml manifest')
    .option('--yes', 'Skip prompts, create a minimal manifest')
    .action(async (dir: string = '.', opts: { yes?: boolean }) => {
      const outDir = resolve(dir)
      const outFile = join(outDir, 'agent.yaml')

      printHeader('AgentSpec Init')

      if (existsSync(outFile) && !opts.yes) {
        const overwrite = await p.confirm({
          message: `agent.yaml already exists at ${outFile}. Overwrite?`,
          initialValue: false,
        })
        if (!overwrite || p.isCancel(overwrite)) {
          p.cancel('Init cancelled.')
          return
        }
      }

      let name = 'my-agent'
      let description = 'An AI agent'
      let version = '0.1.0'
      let provider = 'openai'
      let modelId = 'gpt-4o-mini'
      let includeMemory = false
      let includeGuardrails = true
      let includeEval = false

      if (!opts.yes) {
        p.intro(chalk.cyan('Creating your agent.yaml'))

        const answers = await p.group(
          {
            name: () =>
              p.text({
                message: 'Agent name (slug)',
                placeholder: 'my-agent',
                validate: (v) =>
                  /^[a-z0-9-]+$/.test(v) ? undefined : 'Must be lowercase slug (a-z, 0-9, -)',
              }),
            description: () =>
              p.text({
                message: 'Description',
                placeholder: 'An AI agent that...',
              }),
            version: () =>
              p.text({
                message: 'Version',
                placeholder: '0.1.0',
                initialValue: '0.1.0',
              }),
            provider: () =>
              p.select({
                message: 'Model provider',
                options: [
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'groq', label: 'Groq' },
                  { value: 'google', label: 'Google' },
                  { value: 'mistral', label: 'Mistral' },
                  { value: 'azure', label: 'Azure OpenAI' },
                ],
              }),
            modelId: () =>
              p.text({
                message: 'Model ID',
                placeholder: 'gpt-4o-mini',
              }),
            includeMemory: () =>
              p.confirm({
                message: 'Include memory configuration?',
                initialValue: false,
              }),
            includeGuardrails: () =>
              p.confirm({
                message: 'Include guardrails?',
                initialValue: true,
              }),
            includeEval: () =>
              p.confirm({
                message: 'Include evaluation configuration?',
                initialValue: false,
              }),
          },
          {
            onCancel: () => {
              p.cancel('Init cancelled.')
              process.exit(0)
            },
          },
        )

        name = String(answers.name || 'my-agent')
        description = String(answers.description || 'An AI agent')
        version = String(answers.version || '0.1.0')
        provider = String(answers.provider || 'openai')
        modelId = String(answers.modelId || 'gpt-4o-mini')
        includeMemory = Boolean(answers.includeMemory)
        includeGuardrails = Boolean(answers.includeGuardrails)
        includeEval = Boolean(answers.includeEval)
      }

      const apiKeyEnv = `${provider.toUpperCase()}_API_KEY`

      const yaml = generateManifest({
        name,
        description,
        version,
        provider,
        modelId,
        apiKeyEnv,
        includeMemory,
        includeGuardrails,
        includeEval,
      })

      writeFileSync(outFile, yaml, 'utf-8')

      if (!opts.yes) p.outro(chalk.green(`✓ Created ${outFile}`))
      else console.log(chalk.green(`\n  ✓ Created ${outFile}\n`))

      console.log(chalk.gray('  Next steps:'))
      console.log(chalk.gray(`    1. Edit ${outFile} to customize your agent`))
      console.log(chalk.gray(`    2. Run: npx agentspec validate agent.yaml`))
      console.log(chalk.gray(`    3. Run: npx agentspec health agent.yaml`))
      console.log(chalk.gray(`    4. Run: npx agentspec audit agent.yaml`))
      console.log()
    })
}

function generateManifest(opts: {
  name: string
  description: string
  version: string
  provider: string
  modelId: string
  apiKeyEnv: string
  includeMemory: boolean
  includeGuardrails: boolean
  includeEval: boolean
}): string {
  const sections: string[] = [
    `apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: ${opts.name}
  version: ${opts.version}
  description: "${opts.description}"
  tags: []
  author: ""
  license: MIT

spec:
  # ── MODEL ──────────────────────────────────────────────────────────────────
  model:
    provider: ${opts.provider}
    id: ${opts.modelId}
    apiKey: $env:${opts.apiKeyEnv}
    parameters:
      temperature: 0.7
      maxTokens: 2000
    # Uncomment to add fallback:
    # fallback:
    #   provider: openai
    #   id: gpt-4o-mini
    #   apiKey: $env:OPENAI_API_KEY
    #   triggerOn: [rate_limit, timeout, error_5xx]
    #   maxRetries: 2

  # ── PROMPTS ────────────────────────────────────────────────────────────────
  prompts:
    system: $file:prompts/system.md
    fallback: "I'm experiencing difficulties. Please try again."
    hotReload: false

  # ── TOOLS (optional) ───────────────────────────────────────────────────────
  # tools:
  #   - name: my-tool
  #     type: function
  #     description: "Description of what this tool does"
  #     module: $file:tools/my_tool.py
  #     function: my_tool_function
  #     annotations:
  #       readOnlyHint: true
  #       destructiveHint: false`,
  ]

  if (opts.includeMemory) {
    sections.push(`
  # ── MEMORY ─────────────────────────────────────────────────────────────────
  memory:
    shortTerm:
      backend: in-memory
      maxTurns: 20
      maxTokens: 8000
    hygiene:
      piiScrubFields: []
      auditLog: false`)
  }

  if (opts.includeGuardrails) {
    sections.push(`
  # ── GUARDRAILS ─────────────────────────────────────────────────────────────
  guardrails:
    input:
      - type: prompt-injection
        action: reject
        sensitivity: high
    output:
      - type: toxicity-filter
        threshold: 0.7
        action: reject`)
  }

  if (opts.includeEval) {
    sections.push(`
  # ── EVALUATION ─────────────────────────────────────────────────────────────
  evaluation:
    framework: deepeval
    datasets:
      - name: qa-test
        path: $file:eval/datasets/qa.jsonl
    metrics:
      - faithfulness
      - hallucination
    thresholds:
      hallucination: 0.05
    ciGate: false`)
  }

  sections.push(`
  # ── COMPLIANCE ─────────────────────────────────────────────────────────────
  compliance:
    packs:
      - owasp-llm-top10
      - model-resilience
      - memory-hygiene

  # ── RUNTIME REQUIREMENTS ───────────────────────────────────────────────────
  requires:
    envVars:
      - ${opts.apiKeyEnv}
`)

  return sections.join('\n')
}
