import type { Command } from 'commander'
import { writeFileSync } from 'node:fs'
import chalk from 'chalk'
import { loadManifest, runAudit, type CompliancePack } from '@agentspec/sdk'
import { formatGrade, formatSeverity, printHeader, printError, scoreColor } from '../utils/output.js'

export function registerAuditCommand(program: Command): void {
  program
    .command('audit <file>')
    .description('Run compliance audit against configured packs')
    .option('--pack <pack>', 'Run a specific compliance pack only')
    .option('--json', 'Output as JSON')
    .option('--output <file>', 'Write report to file')
    .option('--fail-below <score>', 'Exit 1 if score is below this threshold', '0')
    .action(
      async (
        file: string,
        opts: {
          pack?: string
          json?: boolean
          output?: string
          failBelow?: string
        },
      ) => {
        let parsed: Awaited<ReturnType<typeof loadManifest>>
        try {
          parsed = loadManifest(file, { resolve: false })
        } catch (err) {
          printError(`Cannot load manifest: ${String(err)}`)
          process.exit(1)
        }

        const { manifest } = parsed
        const packs = opts.pack
          ? [opts.pack as CompliancePack]
          : undefined

        const report = runAudit(manifest, { packs })

        const outputJson = JSON.stringify(report, null, 2)

        if (opts.output) {
          writeFileSync(opts.output, outputJson, 'utf-8')
          console.log(chalk.green(`  ✓ Report written to ${opts.output}`))
        }

        if (opts.json) {
          console.log(outputJson)
          const threshold = parseInt(opts.failBelow ?? '0', 10)
          if (report.overallScore < threshold) process.exit(1)
          return
        }

        // Human-readable output
        printHeader(`AgentSpec Audit — ${manifest.metadata.name}`)
        console.log(
          `  Score : ${formatGrade(report.grade)} ${chalk.bold(String(report.overallScore))}/100`,
        )
        console.log(
          `  Rules : ${chalk.green(report.passedRules)} passed / ${chalk.red(report.totalRules - report.passedRules)} failed / ${report.totalRules} total`,
        )
        console.log()

        // Category breakdown
        console.log(chalk.bold('  Category Scores'))
        for (const [cat, score] of Object.entries(report.categoryScores)) {
          const bar = progressBar(score)
          const color = scoreColor(score)
          console.log(`    ${chalk.gray(cat.padEnd(24))} ${color(String(score).padStart(3))}% ${bar}`)
        }
        console.log()

        // Violations
        if (report.violations.length === 0) {
          console.log(chalk.green('  ✓ No violations found'))
        } else {
          console.log(chalk.bold(`  Violations (${report.violations.length})`))
          for (const v of report.violations) {
            const badge = evidenceBadge(v.evidenceLevel)
            console.log(
              `\n  ${formatSeverity(v.severity)} ${badge} ${chalk.bold(v.ruleId)} — ${chalk.white(v.title)}`,
            )
            console.log(`    ${chalk.gray(v.message)}`)
            if (v.path) {
              console.log(`    Path: ${chalk.cyan(v.path)}`)
            }
            if (v.recommendation) {
              console.log(`    ${chalk.cyan('→')} ${v.recommendation}`)
            }
            if (v.references?.length) {
              for (const ref of v.references) {
                console.log(`    ${chalk.blue(ref)}`)
              }
            }
          }
        }

        if (report.suppressions.length > 0) {
          console.log()
          console.log(chalk.bold(`  Suppressions (${report.suppressions.length})`))
          for (const s of report.suppressions) {
            console.log(`    ${chalk.gray('–')} ${s.ruleId}: ${s.reason}`)
          }
        }

        // Evidence breakdown footer
        if (report.evidenceBreakdown) {
          console.log()
          console.log(chalk.bold('  Evidence Breakdown'))
          const { declarative, probed, behavioral } = report.evidenceBreakdown
          const dLabel = declarative.total > 0
            ? `${declarative.passed}/${declarative.total}`
            : 'N/A'
          const pLabel = probed.total > 0
            ? `${probed.passed}/${probed.total}`
            : 'N/A  (run `agentspec health <file>` for live checks)'
          const bLabel = behavioral.total > 0
            ? `${behavioral.passed}/${behavioral.total}`
            : 'N/A  (no runtime events — deploy with sdk-langgraph + EventPush)'
          console.log(`    ${chalk.gray('[D]')} Declarative  ${chalk.cyan(dLabel)}  (manifest declarations)`)
          console.log(`    ${chalk.gray('[P]')} Probed        ${chalk.cyan(pLabel)}`)
          console.log(`    ${chalk.gray('[B]')} Behavioral    ${chalk.cyan(bLabel)}`)
        }

        console.log()

        const threshold = parseInt(opts.failBelow ?? '0', 10)
        if (report.overallScore < threshold) {
          console.error(
            chalk.red(
              `  ✗ Score ${report.overallScore} is below threshold ${threshold}`,
            ),
          )
          process.exit(1)
        }
      },
    )
}

function progressBar(score: number): string {
  const width = 20
  const filled = Math.round((score / 100) * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return scoreColor(score)(bar)
}

function evidenceBadge(level: string | undefined): string {
  switch (level) {
    case 'declarative': return chalk.gray('[D]')
    case 'probed':      return chalk.blue('[P]')
    case 'behavioral':  return chalk.magenta('[B]')
    default:            return chalk.gray('[D]')
  }
}
