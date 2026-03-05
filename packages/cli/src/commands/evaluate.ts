import type { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import chalk from 'chalk'
import { loadManifest } from '@agentspec/sdk'
import { printHeader, printError, scoreColor, formatCiGate } from '../utils/output.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DatasetSample {
  input: string
  expected: string
  /** Retrieved chunks the agent used — required for faithfulness / context_precision / hallucination metrics. */
  context?: string[]
  /** Ground-truth relevant chunks — required for context_recall metric. */
  reference_contexts?: string[]
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface SampleResult {
  index: number
  input: string
  expected: string
  actual: string | null
  pass: boolean
  latencyMs: number
  error?: string
}

export interface EvaluateReport {
  dataset: string
  agentUrl: string
  totalSamples: number
  metrics: {
    pass_rate: number
    [key: string]: number
  }
  threshold?: number
  ciGateResult: 'PASS' | 'FAIL' | 'N/A'
  samples: SampleResult[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Parse a JSONL file into DatasetSample array, skipping blank/invalid lines. */
export function loadDataset(datasetPath: string): DatasetSample[] {
  if (!existsSync(datasetPath)) {
    throw new Error(`Dataset file not found: ${datasetPath}`)
  }
  const content = readFileSync(datasetPath, 'utf-8')
  const samples: DatasetSample[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof parsed.input === 'string' && typeof parsed.expected === 'string') {
        samples.push({
          input: parsed.input,
          expected: parsed.expected,
          context: Array.isArray(parsed.context) ? (parsed.context as string[]) : undefined,
          reference_contexts: Array.isArray(parsed.reference_contexts)
            ? (parsed.reference_contexts as string[])
            : undefined,
          tags: Array.isArray(parsed.tags) ? (parsed.tags as string[]) : undefined,
          metadata:
            parsed.metadata !== null && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
              ? (parsed.metadata as Record<string, unknown>)
              : undefined,
        })
      }
    } catch {
      // Skip invalid JSON lines
    }
  }
  return samples
}

/** Send a single input to the agent's chat endpoint and return the response text. */
export async function sendToAgent(
  baseUrl: string,
  chatPath: string,
  input: string,
  timeoutMs: number,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}${chatPath}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: input }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`Agent returned HTTP ${res.status}`)
  }
  // Support both { response: "..." } and { message: "...", content: "..." } shapes
  const body = await res.json() as Record<string, unknown>
  const text =
    ['response', 'message', 'content']
      .map((k) => body[k])
      .find((v): v is string => typeof v === 'string')
    ?? JSON.stringify(body)
  return text
}

/** Case-insensitive substring match. */
export function scoreStringMatch(expected: string, actual: string): boolean {
  return actual.toLowerCase().includes(expected.toLowerCase())
}

/** Build an EvaluateReport from sample results and manifest config. */
export function buildReport(
  results: SampleResult[],
  datasetName: string,
  agentUrl: string,
  manifest: { spec: { evaluation?: { ciGate?: boolean; thresholds?: Record<string, number> } } },
): EvaluateReport {
  const total = results.length
  const passed = results.filter((r) => r.pass).length
  const passRate = total === 0 ? 1 : passed / total

  const threshold = manifest.spec.evaluation?.thresholds?.['pass_rate']
  const ciGate = manifest.spec.evaluation?.ciGate ?? false
  let ciGateResult: 'PASS' | 'FAIL' | 'N/A' = 'N/A'
  if (ciGate && threshold !== undefined) {
    ciGateResult = passRate >= threshold ? 'PASS' : 'FAIL'
  }

  return {
    dataset: datasetName,
    agentUrl,
    totalSamples: total,
    metrics: {
      pass_rate: passRate,
    },
    threshold,
    ciGateResult,
    samples: results,
  }
}

/** Print human-readable table output. */
export function printTable(report: EvaluateReport): void {
  printHeader(`AgentSpec Evaluate — ${report.dataset}`)
  console.log(
    `  Evaluating: ${chalk.bold(report.dataset)}  ${chalk.gray(String(report.totalSamples) + ' samples')}  agent: ${chalk.cyan(report.agentUrl)}`,
  )
  console.log(chalk.gray('  ' + '─'.repeat(65)))
  console.log()

  for (const s of report.samples) {
    const icon = s.pass ? chalk.green('  ✓') : chalk.red('  ✗')
    const expected = chalk.gray(`"${s.expected}"`)
    if (s.error) {
      console.log(`${icon}  ${String(s.index + 1).padStart(2)}  ${chalk.gray(s.input.slice(0, 50))} → ${chalk.red('error: ' + s.error)}`)
    } else if (s.pass) {
      console.log(`${icon}  ${String(s.index + 1).padStart(2)}  ${chalk.gray(s.input.slice(0, 50))} → found ${expected} ${chalk.gray('[' + s.latencyMs + 'ms]')}`)
    } else {
      console.log(`${icon}  ${String(s.index + 1).padStart(2)}  ${chalk.gray(s.input.slice(0, 50))} → expected ${expected} not found ${chalk.gray('[' + s.latencyMs + 'ms]')}`)
    }
  }

  console.log()
  console.log(chalk.bold('  Results'))
  const { pass_rate } = report.metrics
  const pct = Math.round(pass_rate * 100)
  const pctColor = scoreColor(pct)
  const threshStr =
    report.threshold !== undefined
      ? `(threshold: ${Math.round(report.threshold * 100)}%)`
      : '(no threshold declared)'
  console.log(
    `    pass_rate     ${pctColor(pct + '%')}  ${chalk.gray(threshStr)}  ${formatCiGate(report.ciGateResult)}`,
  )
  console.log()
  console.log(`  ciGate: ${formatCiGate(report.ciGateResult)}`)
  console.log(`  Exit code: ${report.ciGateResult === 'FAIL' ? chalk.red('1') : chalk.green('0')}`)
  console.log()
}

/** Print JSON output. */
export function printJSON(report: EvaluateReport): void {
  console.log(JSON.stringify(report, null, 2))
}

// ── Private helpers ────────────────────────────────────────────────────────────

function resolveChatEndpoint(
  manifest: { spec: { api?: { chatEndpoint?: { path?: string } } } },
): string {
  return (manifest.spec.api as { chatEndpoint?: { path?: string } } | undefined)
    ?.chatEndpoint?.path ?? '/v1/chat'
}

async function runInference(
  samples: DatasetSample[],
  agentUrl: string,
  chatPath: string,
  timeoutMs: number,
): Promise<SampleResult[]> {
  const results: SampleResult[] = []
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!
    const start = Date.now()
    try {
      const actual = await sendToAgent(agentUrl, chatPath, sample.input, timeoutMs)
      results.push({
        index: i,
        input: sample.input,
        expected: sample.expected,
        actual,
        pass: scoreStringMatch(sample.expected, actual),
        latencyMs: Date.now() - start,
      })
    } catch (err) {
      results.push({
        index: i,
        input: sample.input,
        expected: sample.expected,
        actual: null,
        pass: false,
        latencyMs: Date.now() - start,
        error: String(err),
      })
    }
  }
  return results
}

function determineCiGateExit(report: EvaluateReport): void {
  if (report.ciGateResult === 'FAIL') process.exit(1)
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerEvaluateCommand(program: Command): void {
  program
    .command('evaluate <file>')
    .description('Run declared evaluation dataset against a live agent and score outputs')
    .requiredOption('--url <url>', 'Agent base URL (e.g. http://localhost:4000)')
    .requiredOption('--dataset <name>', 'Dataset name from spec.evaluation.datasets[]')
    .option('--sample-size <n>', 'Run only N random samples (default: all)')
    .option('--tag <tag>', 'Filter samples by tag')
    .option('--timeout <ms>', 'Per-request timeout in ms', '10000')
    .option('--json', 'Output JSON instead of table')
    .action(
      async (
        file: string,
        opts: {
          url: string
          dataset: string
          sampleSize?: string
          tag?: string
          timeout: string
          json?: boolean
        },
      ) => {
        // ── Load manifest ─────────────────────────────────────────────────────
        let parsed: Awaited<ReturnType<typeof loadManifest>>
        try {
          parsed = loadManifest(file, { resolve: false })
        } catch (err) {
          printError(`Cannot load manifest: ${String(err)}`)
          process.exit(1)
        }

        const { manifest } = parsed
        const manifestDir = dirname(resolve(file))
        const timeoutMs = parseInt(opts.timeout, 10) || 10000

        // ── Resolve dataset path ───────────────────────────────────────────────
        const datasets = manifest.spec.evaluation?.datasets ?? []
        const datasetEntry = datasets.find((d) => d.name === opts.dataset)
        if (!datasetEntry) {
          printError(
            `Dataset "${opts.dataset}" not found in spec.evaluation.datasets. ` +
            `Available: ${datasets.map((d) => d.name).join(', ') || '(none)'}`,
          )
          process.exit(1)
        }

        const rawPath = datasetEntry.path
        const relPath = rawPath.startsWith('$file:') ? rawPath.slice(6) : rawPath
        const absPath = resolve(manifestDir, relPath)

        // ── Load samples ───────────────────────────────────────────────────────
        let samples: DatasetSample[]
        try {
          samples = loadDataset(absPath)
        } catch (err) {
          printError(`Cannot load dataset: ${String(err)}`)
          process.exit(1)
        }

        // Filter by tag
        if (opts.tag) {
          samples = samples.filter((s) => s.tags?.includes(opts.tag!))
        }

        // Limit by sample-size
        if (opts.sampleSize) {
          const n = parseInt(opts.sampleSize, 10)
          if (n > 0 && n < samples.length) {
            const shuffled = [...samples].sort(() => Math.random() - 0.5)
            samples = shuffled.slice(0, n)
          }
        }

        // ── Run inference and report ───────────────────────────────────────────
        const chatPath = resolveChatEndpoint(manifest)
        const results = await runInference(samples, opts.url, chatPath, timeoutMs)
        const report = buildReport(results, opts.dataset, opts.url, manifest)

        if (opts.json) {
          printJSON(report)
        } else {
          printTable(report)
        }

        determineCiGateExit(report)
      },
    )
}
