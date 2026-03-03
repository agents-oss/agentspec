import type { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import chalk from 'chalk'

export function registerProbeCommand(program: Command): void {
  const probe = program
    .command('probe')
    .description('Run external probes to generate compliance proof records')

  probe
    .command('pii <file>')
    .description('Scan agent outputs or logs for unredacted PII (proves SEC-LLM-06, MEM-01, OBS-03)')
    .option('--log-file <path>', 'Log file to scan line-by-line (proves OBS-03)')
    .option('--text <text>', 'Text to scan for PII; repeat for multiple (proves SEC-LLM-06 + MEM-01)', collect, [])
    .option('--sidecar-url <url>', 'Sidecar URL to submit proof on pass (e.g. http://localhost:4001)')
    .option('--submit', 'Auto-submit proof to sidecar when scan passes (requires --sidecar-url)')
    .option('--threshold <float>', 'Minimum Presidio confidence score to report as PII (default: 0.7)')
    .option('--json', 'Output ProbeScanResult as JSON')
    .action(
      (
        file: string,
        opts: {
          logFile?: string
          text?: string[]
          sidecarUrl?: string
          submit?: boolean
          threshold?: string
          json?: boolean
        },
      ) => {
        // Mutual exclusivity: --log-file and --text cannot both be provided
        if (opts.logFile && opts.text && opts.text.length > 0) {
          console.error(chalk.red('  ✗ --log-file and --text are mutually exclusive'))
          process.exit(1)
        }

        if (!opts.logFile && (!opts.text || opts.text.length === 0)) {
          console.error(chalk.red('  ✗ Provide --log-file <path> or --text <text> (at least one required)'))
          process.exit(1)
        }

        if (opts.submit && !opts.sidecarUrl) {
          console.error(chalk.red('  ✗ --submit requires --sidecar-url'))
          process.exit(1)
        }

        // Validate threshold is a float in [0, 1]
        if (opts.threshold !== undefined) {
          const t = parseFloat(opts.threshold)
          if (isNaN(t) || t < 0 || t > 1) {
            console.error(chalk.red('  ✗ --threshold must be a number between 0.0 and 1.0'))
            process.exit(1)
          }
        }

        // Validate log file exists before shelling out
        if (opts.logFile && !existsSync(opts.logFile)) {
          console.error(chalk.red(`  ✗ Log file not found: ${opts.logFile}`))
          process.exit(1)
        }

        // Build args for python -m agentspec.presidio_probe
        const pyArgs: string[] = ['-m', 'agentspec.presidio_probe', '--manifest', file]

        if (opts.logFile) {
          pyArgs.push('--log-file', opts.logFile)
        }

        for (const t of opts.text ?? []) {
          pyArgs.push('--text', t)
        }

        if (opts.sidecarUrl) {
          pyArgs.push('--sidecar-url', opts.sidecarUrl)
        }

        if (opts.submit) {
          pyArgs.push('--submit')
        }

        if (opts.threshold) {
          pyArgs.push('--threshold', opts.threshold)
        }

        if (opts.json) {
          pyArgs.push('--json')
        }

        // Try python3 first, fall back to python
        const python = resolvePython()
        if (!python) {
          console.error(chalk.red('  ✗ Python 3 not found. Install Python 3.10+ to use agentspec probe.'))
          process.exit(1)
        }

        const result = spawnSync(python, pyArgs, { stdio: 'inherit' })

        if (result.error) {
          console.error(chalk.red(`  ✗ Failed to run Presidio probe: ${result.error.message}`))
          console.error(chalk.gray(`    Ensure the agentspec Python SDK is installed: pip install agentspec`))
          process.exit(1)
        }

        process.exit(result.status ?? 1)
      },
    )
}

/** Repeatable option collector for --text */
function collect(val: string, prev: string[]): string[] {
  return [...prev, val]
}

/** Try python3 then python; return the working executable or null. */
function resolvePython(): string | null {
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'pipe' })
    if (probe.status === 0) return bin
  }
  return null
}
