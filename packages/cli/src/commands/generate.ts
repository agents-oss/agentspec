import type { Command } from 'commander'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import chalk from 'chalk'
import { spinner } from '../utils/spinner.js'
import { loadManifest } from '@agentspec/sdk'
import { generateWithClaude, listFrameworks } from '@agentspec/adapter-claude'
import { printHeader, printError, printSuccess } from '../utils/output.js'
import { generateK8sManifests } from '../deploy/k8s.js'

const DEPLOY_TARGETS = ['k8s', 'helm'] as const
type DeployTarget = (typeof DEPLOY_TARGETS)[number]

/**
 * Writes all generated files to the output directory.
 * Creates any missing parent directories automatically.
 *
 * @throws {Error} if a filename attempts to escape the output directory (path traversal).
 */
export function writeGeneratedFiles(
  files: Record<string, string>,
  outDir: string,
): void {
  const resolvedOutDir = resolve(outDir)
  mkdirSync(resolvedOutDir, { recursive: true })
  const safeOutDir = resolvedOutDir.endsWith(sep) ? resolvedOutDir : resolvedOutDir + sep

  for (const [filename, content] of Object.entries(files)) {
    const outPath = resolve(resolvedOutDir, filename)
    if (!outPath.startsWith(safeOutDir) && outPath !== resolvedOutDir) {
      throw new Error(`Rejected generated filename "${filename}" — path traversal detected`)
    }
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, content, 'utf-8')
    console.log(`  ${chalk.green('✓')} ${filename}`)
  }
}

/**
 * Copies the source manifest file to the output directory, stripping `$secret:` values.
 * No-op when the source file does not exist or is already in the generated file set.
 */
export function copyManifestToOutput(
  srcFile: string,
  outDir: string,
  alreadyGenerated: Record<string, string>,
): void {
  const manifestSrc = resolve(srcFile)
  const resolvedOutDir = resolve(outDir)
  if (!existsSync(manifestSrc) || alreadyGenerated[basename(manifestSrc)] !== undefined) {
    return
  }
  try {
    let content = readFileSync(manifestSrc, 'utf-8')
    content = content.replace(/\$secret:[^\s\n'"]+/g, '<redacted>')
    writeFileSync(join(resolvedOutDir, basename(manifestSrc)), content, 'utf-8')
    console.log(`  ${chalk.green('✓')} ${basename(manifestSrc)} (manifest copy)`)
  } catch {
    // Non-fatal: manifest copy failed (e.g., source is a virtual path in tests)
  }
}

// ── Private helpers ────────────────────────────────────────────────────────────

function validateFramework(framework: string): void {
  let available: string[]
  try {
    available = listFrameworks()
  } catch {
    printError(
      'Failed to load available frameworks. ' +
        'Is @agentspec/adapter-claude installed correctly?',
    )
    process.exit(1)
  }
  if (!available.includes(framework)) {
    printError(`Unknown framework "${framework}". Available: ${available.join(', ')}`)
    process.exit(1)
  }
}

function handleK8sGeneration(
  manifest: Awaited<ReturnType<typeof loadManifest>>['manifest'],
  outDir: string,
  outputOpt: string,
): void {
  printHeader('AgentSpec Deploy — Kubernetes')
  console.log()
  try {
    writeGeneratedFiles(generateK8sManifests(manifest), outDir)
  } catch (err) {
    printError(String(err))
    process.exit(1)
  }
  printSuccess(`Written to ${outputOpt}`)
}

async function handleLLMGeneration(
  manifest: Awaited<ReturnType<typeof loadManifest>>['manifest'],
  framework: string,
  manifestDir: string,
  spin: ReturnType<typeof spinner>,
  displayModel: string,
): Promise<Awaited<ReturnType<typeof generateWithClaude>>> {
  try {
    return await generateWithClaude(manifest, {
      framework,
      manifestDir,
      onProgress: ({ outputChars }) => {
        const kb = (outputChars / 1024).toFixed(1)
        spin.message(`Generating with ${displayModel} · ${kb}k chars`)
      },
    })
  } catch (err) {
    spin.stop('Generation failed')
    printError(`Generation failed: ${String(err)}`)
    process.exit(1)
  }
}

function writePushModeEnv(outDir: string): void {
  const envContent = [
    'AGENTSPEC_URL=https://control-plane.agentspec.io',
    'AGENTSPEC_KEY=<paste key from: agentspec register>',
    '',
  ].join('\n')
  writeFileSync(join(outDir, '.env.agentspec'), envContent, 'utf-8')
  console.log(
    `  ${chalk.green('✓')} .env.agentspec (push mode — paste your key from agentspec register)`,
  )
}

function printDryRunOutput(files: Record<string, string>): void {
  console.log()
  console.log(chalk.bold('  Files to be generated:'))
  for (const [filename, content] of Object.entries(files)) {
    console.log()
    console.log(chalk.cyan(`  ── ${filename} ──`))
    console.log(content.split('\n').map((l) => `    ${l}`).join('\n'))
  }
  console.log()
}

function printPostGeneration(
  generated: { installCommands: string[]; envVars: string[] },
  outputDir: string,
): void {
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
  printSuccess(`Written to ${outputDir}`)
}

async function runDeployTarget(
  target: DeployTarget,
  manifest: Awaited<ReturnType<typeof loadManifest>>['manifest'],
  outDir: string,
): Promise<void> {
  if (target === 'k8s') {
    console.log()
    console.log(chalk.bold('  Kubernetes manifests:'))
    const deployFiles = generateK8sManifests(manifest)
    writeGeneratedFiles(deployFiles, outDir)
    return
  }

  if (target === 'helm') {
    console.log()
    console.log(chalk.bold('  Helm chart (Claude-generated):'))
    const helmGenerated = await generateWithClaude(manifest, { framework: 'helm' })
    writeGeneratedFiles(helmGenerated.files, outDir)
  }
}

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate <file>')
    .description('Generate framework-specific agent code from a manifest')
    .requiredOption('--framework <fw>', 'Target framework (langgraph, crewai, mastra)')
    .option('--output <dir>', 'Output directory', './generated')
    .option('--dry-run', 'Print generated files without writing them')
    .option(
      '--deploy <target>',
      `Also generate deployment manifests: ${DEPLOY_TARGETS.join(', ')}`,
    )
    .option('--push', 'Write .env.agentspec with push mode env var placeholders')
    .action(
      async (
        file: string,
        opts: { framework: string; output: string; dryRun?: boolean; deploy?: string; push?: boolean },
      ) => {
        validateFramework(opts.framework)

        if (opts.deploy && !DEPLOY_TARGETS.includes(opts.deploy as DeployTarget)) {
          printError(
            `Unknown deploy target "${opts.deploy}". Available: ${DEPLOY_TARGETS.join(', ')}`,
          )
          process.exit(1)
        }

        let parsed: Awaited<ReturnType<typeof loadManifest>>
        try {
          parsed = loadManifest(file, { resolve: false })
        } catch (err) {
          printError(`Cannot load manifest: ${String(err)}`)
          process.exit(1)
        }

        // ── k8s deploy: deterministic, no LLM needed — early return ──────────
        if (opts.deploy === 'k8s') {
          handleK8sGeneration(parsed.manifest, resolve(opts.output), opts.output)
          return
        }

        // ── LLM-driven generation (framework code or helm chart) ─────────────
        if (!process.env['ANTHROPIC_API_KEY']) {
          printError(
            'ANTHROPIC_API_KEY is not set. AgentSpec generates code using Claude.\n' +
              '  Get a key at https://console.anthropic.com and add it to your environment.',
          )
          process.exit(1)
        }

        printHeader(`AgentSpec Generate — ${opts.framework}`)

        const displayModel = process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-4-6'
        const spin = spinner()
        spin.start(`Generating with ${displayModel}`)

        const manifestDir = dirname(resolve(file))
        const generated = await handleLLMGeneration(
          parsed.manifest,
          opts.framework,
          manifestDir,
          spin,
          displayModel,
        )

        const totalKb = (
          Object.values(generated.files).reduce((n, c) => n + c.length, 0) / 1024
        ).toFixed(1)
        spin.stop(`Generated ${Object.keys(generated.files).length} files · ${totalKb}k chars`)

        if (opts.dryRun) {
          printDryRunOutput(generated.files)
          return
        }

        const outDir = resolve(opts.output)
        console.log()

        try {
          writeGeneratedFiles(generated.files, outDir)
        } catch (err) {
          printError(String(err))
          process.exit(1)
        }

        // Copy source manifest to output dir (safety net for frameworks that don't
        // generate agent.yaml — Claude's updated langgraph.md skill always includes it)
        copyManifestToOutput(file, outDir, generated.files)

        if (opts.push) {
          writePushModeEnv(outDir)
        }

        if (opts.deploy === 'helm') {
          await runDeployTarget('helm', parsed.manifest, outDir)
        }

        printPostGeneration(generated, opts.output)
      },
    )
}
