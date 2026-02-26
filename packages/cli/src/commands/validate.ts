import type { Command } from 'commander'
import chalk from 'chalk'
import { loadManifest } from '@agentspec/sdk'
import { printHeader, printError, printSuccess } from '../utils/output.js'

export function registerValidateCommand(program: Command): void {
  program
    .command('validate <file>')
    .description('Validate an agent.yaml manifest against the schema (no I/O)')
    .option('--json', 'Output as JSON')
    .action(async (file: string, opts: { json?: boolean }) => {
      try {
        const { manifest } = loadManifest(file, { resolve: false })

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                valid: true,
                agentName: manifest.metadata.name,
                version: manifest.metadata.version,
                apiVersion: manifest.apiVersion,
              },
              null,
              2,
            ),
          )
          return
        }

        printHeader('AgentSpec Validate')
        printSuccess(
          `Manifest valid — ${chalk.cyan(manifest.metadata.name)} v${manifest.metadata.version} (agentspec.io/v1)`,
        )
        console.log(chalk.gray(`  Provider : ${manifest.spec.model.provider}/${manifest.spec.model.id}`))
        console.log(chalk.gray(`  Tools    : ${manifest.spec.tools?.length ?? 0}`))
        console.log(chalk.gray(`  MCP      : ${manifest.spec.mcp?.servers?.length ?? 0} servers`))
        console.log(chalk.gray(`  Memory   : ${manifest.spec.memory ? 'configured' : 'none'}`))
        console.log()
      } catch (err) {
        if (opts.json) {
          const message = err instanceof Error ? err.message : String(err)
          console.log(JSON.stringify({ valid: false, error: message }, null, 2))
          process.exit(1)
        }

        printHeader('AgentSpec Validate')
        if (err instanceof Error && err.constructor.name === 'ZodError') {
          printError('Manifest validation failed:')
          // Parse ZodError issues
          const raw = JSON.parse(
            err.message.startsWith('[') ? err.message : JSON.stringify([{ message: err.message }]),
          ) as Array<{ path: unknown[]; message: string }>
          for (const issue of raw) {
            const path = issue.path?.join('.') || 'root'
            console.error(chalk.red(`  • ${path}: ${issue.message}`))
          }
        } else {
          printError(String(err))
        }
        console.log()
        process.exit(1)
      }
    })
}
