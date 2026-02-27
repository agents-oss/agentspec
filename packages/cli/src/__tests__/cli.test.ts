/**
 * CLI integration tests using execa + tsx.
 *
 * These tests spawn the CLI source directly via tsx (no pre-build required).
 * In CI: pnpm build runs before pnpm test, but tsx also works from source.
 */

import { execa } from 'execa'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// repo root: packages/cli/src/__tests__ → ../../../../
const repoRoot = resolve(__dirname, '../../../..')
const tsxBin = join(repoRoot, 'node_modules/.bin/tsx')
const cliSrc = join(repoRoot, 'packages/cli/src/cli.ts')
const exampleManifest = join(repoRoot, 'examples/budgetbud/agent.yaml')

async function runCli(args: string[]) {
  return execa(tsxBin, [cliSrc, ...args], {
    cwd: repoRoot,
    reject: false,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
}

describe('agentspec validate', () => {
  it('exits 0 for a valid manifest', async () => {
    const result = await runCli(['validate', exampleManifest])
    expect(result.exitCode).toBe(0)
  })

  it('exits non-zero for a nonexistent file', async () => {
    const result = await runCli(['validate', '/nonexistent/does-not-exist.yaml'])
    expect(result.exitCode).not.toBe(0)
  })

  it('outputs valid: true in JSON mode for a valid manifest', async () => {
    const result = await runCli(['validate', exampleManifest, '--json'])
    expect(result.exitCode).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.valid).toBe(true)
  })

  it('outputs valid: false in JSON mode for nonexistent file', async () => {
    const result = await runCli(['validate', '/nonexistent.yaml', '--json'])
    expect(result.exitCode).not.toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json.valid).toBe(false)
  })
})

describe('agentspec audit', () => {
  it('exits 0 for a valid manifest', async () => {
    const result = await runCli(['audit', exampleManifest])
    expect(result.exitCode).toBe(0)
  })

  it('stdout contains Score', async () => {
    const result = await runCli(['audit', exampleManifest])
    expect(result.stdout).toContain('Score')
  })

  it('JSON mode outputs overallScore', async () => {
    const result = await runCli(['audit', exampleManifest, '--json'])
    expect(result.exitCode).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(typeof json.overallScore).toBe('number')
  })
})

describe('agentspec migrate', () => {
  it('exits 0 for an already-latest manifest with --dry-run', async () => {
    const result = await runCli(['migrate', exampleManifest, '--dry-run'])
    expect(result.exitCode).toBe(0)
  })

  it('stdout indicates already at latest version', async () => {
    const result = await runCli(['migrate', exampleManifest, '--dry-run'])
    expect(result.stdout).toContain('latest')
  })
})
