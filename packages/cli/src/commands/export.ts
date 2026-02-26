import type { Command } from 'commander'
import chalk from 'chalk'
import { loadManifest, type AgentSpecManifest } from '@agentspec/sdk'
import { printHeader, printError } from '../utils/output.js'

export function registerExportCommand(program: Command): void {
  program
    .command('export <file>')
    .description('Export manifest to other formats (agentcard, agents-md-block)')
    .requiredOption('--format <fmt>', 'Export format: agentcard|agents-md-block')
    .action(async (file: string, opts: { format: string }) => {
      let parsed: Awaited<ReturnType<typeof loadManifest>>
      try {
        parsed = loadManifest(file, { resolve: false })
      } catch (err) {
        printError(`Cannot load manifest: ${String(err)}`)
        process.exit(1)
      }

      const { manifest } = parsed

      switch (opts.format) {
        case 'agentcard': {
          const card = toAgentCard(manifest)
          console.log(JSON.stringify(card, null, 2))
          break
        }
        case 'agents-md-block': {
          const block = toAgentsMdBlock(manifest)
          console.log(block)
          break
        }
        default:
          printError(`Unknown format: ${opts.format}. Use: agentcard|agents-md-block`)
          process.exit(1)
      }
    })
}

/** Export as Google A2A/AgentCard format */
function toAgentCard(manifest: AgentSpecManifest): object {
  return {
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    version: manifest.metadata.version,
    url: manifest.spec.api
      ? `http://localhost:${manifest.spec.api.port ?? 8000}${manifest.spec.api.pathPrefix ?? '/api/v1'}`
      : undefined,
    capabilities: {
      streaming: manifest.spec.api?.streaming ?? false,
      pushNotifications: false,
      stateTransitionHistory: !!manifest.spec.memory?.longTerm,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: manifest.spec.skills?.map((s) => ({
      id: s.id,
      name: s.id,
      description: '',
      tags: manifest.metadata.tags ?? [],
      examples: [],
    })) ?? [],
    provider: {
      organization: manifest.metadata.author ?? 'Unknown',
    },
    agentSpec: {
      apiVersion: manifest.apiVersion,
      manifestRef: 'agent.yaml',
    },
  }
}

/** Export as AGENTS.md reference block */
function toAgentsMdBlock(manifest: AgentSpecManifest): string {
  return `## Agent Manifest

This project uses [AgentSpec](https://agentspec.io) for agent configuration.

| Field | Value |
|-------|-------|
| **Name** | ${manifest.metadata.name} |
| **Version** | ${manifest.metadata.version} |
| **Model** | ${manifest.spec.model.provider}/${manifest.spec.model.id} |
| **Manifest** | [agent.yaml](./agent.yaml) |

See [agent.yaml](./agent.yaml) for the full manifest.

\`\`\`bash
# Check runtime dependencies
npx agentspec health agent.yaml

# Run compliance audit
npx agentspec audit agent.yaml

# Generate framework code
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
\`\`\`
`
}
