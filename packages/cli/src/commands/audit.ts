import type { Command } from 'commander'
import { writeFileSync } from 'node:fs'
import chalk from 'chalk'
import { loadManifest, runAudit, type CompliancePack, type ProofRecord, type EvidenceLevel, isProofRecord } from '@agentspec/sdk'
import { formatGrade, formatSeverity, printHeader, printError, scoreColor } from '../utils/output.js'

export function registerAuditCommand(program: Command): void {
  program
    .command('audit <file>')
    .description('Run compliance audit against configured packs')
    .option('--pack <pack>', 'Run a specific compliance pack only')
    .option('--url <url>', 'Sidecar URL to fetch proof records (e.g. http://localhost:4001)')
    .option('--json', 'Output as JSON')
    .option('--output <file>', 'Write report to file')
    .option('--fail-below <score>', 'Exit 1 if score is below this threshold', '0')
    .action(
      async (
        file: string,
        opts: {
          pack?: string
          url?: string
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

        // Fetch proof records from sidecar if --url is provided
        let proofRecords: ProofRecord[] | undefined
        if (opts.url) {
          // Validate URL before attempting a network call
          try {
            new URL(opts.url)
          } catch {
            printError(`Invalid URL: ${opts.url}`)
            process.exit(1)
          }

          try {
            const proofUrl = `${opts.url.replace(/\/$/, '')}/proof`
            const res = await fetch(proofUrl, {
              headers: { Accept: 'application/json' },
              signal: AbortSignal.timeout(5000),
            })
            if (res.ok) {
              const data: unknown = await res.json()
              if (!Array.isArray(data)) {
                process.stderr.write(
                  chalk.yellow(`  ⚠ Unexpected proof response from ${proofUrl} — expected array, got ${typeof data}\n`),
                )
              } else {
                proofRecords = data.filter(isProofRecord)
              }
            } else {
              process.stderr.write(
                chalk.yellow(`  ⚠ Could not fetch proof records from ${proofUrl} (${res.status}) — showing declared score only\n`),
              )
            }
          } catch (err) {
            process.stderr.write(
              chalk.yellow(`  ⚠ Could not reach sidecar at ${opts.url} — showing declared score only\n`),
            )
          }
        }

        const report = runAudit(manifest, { packs, proofRecords })

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

        // Dual score display when provedScore is available
        if (report.provedScore !== undefined) {
          console.log(
            `  Declared score : ${formatGrade(report.grade)} ${chalk.bold(String(report.overallScore))}/100  — what your spec says`,
          )
          console.log(
            `  Proved score   : ${formatGrade(report.provedGrade!)} ${chalk.bold(String(report.provedScore))}/100  — what has been verified`,
          )
          console.log(
            `  Pending proof  : ${chalk.yellow(String(report.pendingProofCount))} rules — run external tools and POST to ${opts.url}/proof/rule/:ruleId`,
          )
        } else {
          console.log(
            `  Score : ${formatGrade(report.grade)} ${chalk.bold(String(report.overallScore))}/100`,
          )
        }

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

        // Violations — grouped by status when provedScore is available
        if (report.provedScore !== undefined) {
          renderDualModeViolations(report.violations, report, opts.url)
        } else {
          renderViolations(report.violations)
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
          const { declarative, probed, behavioral, external } = report.evidenceBreakdown
          const dLabel = declarative.total > 0
            ? `${declarative.passed}/${declarative.total}`
            : 'N/A'
          const pLabel = probed.total > 0
            ? `${probed.passed}/${probed.total}`
            : 'N/A  (run `agentspec health <file>` for live checks)'
          const bLabel = behavioral.total > 0
            ? `${behavioral.passed}/${behavioral.total}`
            : 'N/A  (no runtime events — deploy with sdk-langgraph + EventPush)'
          const xLabel = external.total > 0
            ? `${external.passed}/${external.total}`
            : 'N/A'
          console.log(`    ${chalk.gray('[D]')} Declarative  ${chalk.cyan(dLabel)}  (manifest declarations)`)
          console.log(`    ${chalk.gray('[P]')} Probed        ${chalk.cyan(pLabel)}`)
          console.log(`    ${chalk.gray('[B]')} Behavioral    ${chalk.cyan(bLabel)}`)
          console.log(`    ${chalk.gray('[X]')} External      ${chalk.cyan(xLabel)}  (k6, Presidio, Promptfoo, LiteLLM)`)
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

function evidenceBadge(level: EvidenceLevel | undefined): string {
  switch (level) {
    case 'declarative': return chalk.gray('[D]')
    case 'probed':      return chalk.blue('[P]')
    case 'behavioral':  return chalk.magenta('[B]')
    case 'external':    return chalk.yellow('[X]')
    default:            return chalk.gray('[D]')
  }
}

type Violation = ReturnType<typeof runAudit>['violations'][number]

/** Render the detail lines for a single violation. */
function renderViolationDetail(v: Violation, badge: string, sidecarUrl?: string): void {
  console.log(`\n  ${formatSeverity(v.severity)} ${badge} ${chalk.bold(v.ruleId)} — ${chalk.white(v.title)}`)
  console.log(`    ${chalk.gray(v.message)}`)
  if (v.path) console.log(`    Path: ${chalk.cyan(v.path)}`)
  if (v.recommendation) console.log(`    ${chalk.cyan('→')} ${v.recommendation}`)
  if (v.proofTool) {
    if (sidecarUrl) {
      const endpoint = `POST ${sidecarUrl.replace(/\/$/, '')}/proof/rule/${v.ruleId}`
      console.log(`    ${chalk.yellow('→ Prove:')} ${v.proofTool} → ${chalk.cyan(endpoint)}`)
    } else {
      console.log(`    ${chalk.yellow('→ Prove:')} ${v.proofTool}`)
    }
  }
  if (v.proofToolUrl) console.log(`    ${chalk.blue(v.proofToolUrl)}`)
  if (v.references?.length) {
    for (const ref of v.references) console.log(`    ${chalk.blue(ref)}`)
  }
}

function renderViolations(violations: Violation[]): void {
  if (violations.length === 0) {
    console.log(chalk.green('  ✓ No violations found'))
    return
  }
  console.log(chalk.bold(`  Violations (${violations.length})`))
  for (const v of violations) renderViolationDetail(v, evidenceBadge(v.evidenceLevel))
}

function renderDualModeViolations(
  violations: Violation[],
  report: ReturnType<typeof runAudit>,
  sidecarUrl?: string,
): void {
  if (violations.length === 0) {
    console.log(chalk.green('  ✓ No violations found'))
    return
  }

  // Separate external violations (awaiting proof) from not-declared ones
  const needsProof = violations.filter((v) => v.evidenceLevel === 'external')
  const notDeclared = violations.filter((v) => v.evidenceLevel !== 'external')

  if (notDeclared.length > 0) {
    console.log(chalk.bold(`  NOT DECLARED (${notDeclared.length})`))
    for (const v of notDeclared) renderViolationDetail(v, evidenceBadge(v.evidenceLevel))
  }

  if (needsProof.length > 0) {
    console.log()
    console.log(chalk.bold(`  DECLARED, AWAITING PROOF (${needsProof.length})`))
    for (const v of needsProof) renderViolationDetail(v, chalk.yellow('[D→X]'), sidecarUrl)
  }

  if (report.pendingProofCount && report.pendingProofCount > 0) {
    console.log()
    console.log(chalk.yellow(`  ⚠ ${report.pendingProofCount} rules pass declaratively but await external proof`))
    console.log(chalk.gray(`    Run the external tools and POST results to ${sidecarUrl ?? '<sidecar-url>'}/proof/rule/:ruleId`))
    console.log(chalk.gray('    See: https://agentspec.io/docs/guides/proof-integration'))
  }
}
