import type { Command } from 'commander'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import chalk from 'chalk'
import { loadManifest, generateAdapter, listAdapters } from '@agentspec/sdk'
import { printHeader, printError, printSuccess } from '../utils/output.js'

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate <file>')
    .description('Generate framework-specific agent code from a manifest')
    .requiredOption('--framework <fw>', 'Target framework (langgraph, crewai, mastra, autogen)')
    .option('--output <dir>', 'Output directory', './generated')
    .option('--dry-run', 'Print generated files without writing them')
    .action(
      async (
        file: string,
        opts: { framework: string; output: string; dryRun?: boolean },
      ) => {
        let parsed: Awaited<ReturnType<typeof loadManifest>>
        try {
          parsed = loadManifest(file, { resolve: false })
        } catch (err) {
          printError(`Cannot load manifest: ${String(err)}`)
          process.exit(1)
        }

        printHeader(`AgentSpec Generate — ${opts.framework}`)

        let generated: Awaited<ReturnType<typeof generateAdapter>>
        try {
          generated = generateAdapter(parsed.manifest, opts.framework)
        } catch (err) {
          const available = listAdapters()
          printError(String(err))
          if (available.length === 0) {
            console.error(
              chalk.yellow(
                '  No adapters registered. Install one:\n' +
                  '    npm install @agentspec/adapter-langgraph',
              ),
            )
          }
          process.exit(1)
        }

        if (opts.dryRun) {
          console.log(chalk.bold('  Files to be generated:'))
          for (const [filename, content] of Object.entries(generated.files)) {
            console.log()
            console.log(chalk.cyan(`  ── ${filename} ──`))
            console.log(content.split('\n').map((l) => `    ${l}`).join('\n'))
          }
          console.log()
          return
        }

        const outDir = resolve(opts.output)
        mkdirSync(outDir, { recursive: true })
        const safeOutDir = outDir.endsWith(sep) ? outDir : outDir + sep

        for (const [filename, content] of Object.entries(generated.files)) {
          const outPath = resolve(outDir, filename)
          // Directory traversal guard: generated filenames must stay within outDir
          if (!outPath.startsWith(safeOutDir) && outPath !== outDir) {
            printError(`Rejected generated filename "${filename}" — path traversal detected`)
            process.exit(1)
          }
          writeFileSync(outPath, content, 'utf-8')
          console.log(`  ${chalk.green('✓')} ${filename}`)
        }

        console.log()
        if (generated.installCommands.length > 0) {
          console.log(chalk.bold('  Install commands:'))
          for (const cmd of generated.installCommands) {
            console.log(`    ${chalk.gray('$')} ${chalk.cyan(cmd)}`)
          }
          console.log()
        }

        if (generated.envVars.length > 0) {
          console.log(chalk.bold('  Required env vars:'))
          for (const v of generated.envVars) {
            console.log(`    ${chalk.gray(v)}`)
          }
          console.log()
        }

        printSuccess(`Generated ${Object.keys(generated.files).length} files in ${opts.output}`)
      },
    )
}
