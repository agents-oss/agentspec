import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import chalk from 'chalk'
import yaml from 'js-yaml'
import {
  migrateManifest,
  detectVersion,
  isLatestVersion,
  LATEST_API_VERSION,
} from '@agentspec/sdk'
import { printHeader, printSuccess, printError } from '../utils/output.js'

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate <file>')
    .description('Migrate an agent.yaml manifest to the latest schema version')
    .option('--dry-run', 'Show what would change without writing files')
    .option('-o, --output <file>', 'Write migrated manifest to a different file')
    .action(async (file: string, opts: { dryRun?: boolean; output?: string }) => {
      printHeader('AgentSpec Migrate')

      const absPath = resolve(file)
      let raw: string
      try {
        raw = readFileSync(absPath, 'utf-8')
      } catch (err) {
        printError(`Cannot read manifest: ${absPath}\n  ${String(err)}`)
        process.exit(1)
      }

      let parsed: Record<string, unknown>
      try {
        parsed = yaml.load(raw) as Record<string, unknown>
      } catch (err) {
        printError(`Invalid YAML: ${String(err)}`)
        process.exit(1)
      }

      const fromVersion = detectVersion(parsed)
      console.log(chalk.gray(`  File     : ${absPath}`))
      console.log(chalk.gray(`  Version  : ${fromVersion}`))
      console.log()

      if (isLatestVersion(parsed)) {
        printSuccess(`Already at latest version (${LATEST_API_VERSION}) — no migration needed.`)
        return
      }

      const { result, migrationsApplied } = migrateManifest(parsed)

      if (migrationsApplied.length === 0) {
        console.log(chalk.yellow(`  ⚠  No migration path found from ${fromVersion} to ${LATEST_API_VERSION}.`))
        console.log(chalk.gray('     Manual update may be required.'))
        console.log()
        process.exit(1)
      }

      console.log(chalk.cyan('  Migrations applied:'))
      for (const m of migrationsApplied) {
        console.log(chalk.gray(`    • ${m}`))
      }
      console.log()

      const migratedYaml = yaml.dump(result, { lineWidth: 120 })

      if (opts.dryRun) {
        console.log(chalk.cyan('  --- Migrated manifest (dry-run) ---'))
        console.log(chalk.gray(migratedYaml))
        console.log(chalk.yellow('  Dry run — no files written.'))
        console.log()
        return
      }

      const outputPath = opts.output ? resolve(opts.output) : absPath
      try {
        writeFileSync(outputPath, migratedYaml, 'utf-8')
      } catch (err) {
        printError(`Cannot write output: ${outputPath}\n  ${String(err)}`)
        process.exit(1)
      }

      printSuccess(`Migrated to ${LATEST_API_VERSION} — written to ${outputPath}`)
    })
}
