import { spawn } from 'child_process'

// ── Bin resolution ────────────────────────────────────────────────────────────

function resolveAgentspecBin(): string {
  return process.env['AGENTSPEC_BIN'] ?? 'agentspec'
}

// ── CLI spawn helper ──────────────────────────────────────────────────────────

/**
 * Spawn the agentspec CLI with the given args.
 * Resolves with stdout on exit 0; rejects with stderr (or stdout) on non-zero exit.
 */
export function spawnCli(args: string[]): Promise<string> {
  const bin = resolveAgentspecBin()

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { shell: false })
    } catch (err) {
      reject(new Error(`Failed to launch "${bin}": ${(err as Error).message}. Is @agentspec/cli installed?`))
      return
    }

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('error', err => {
      reject(new Error(`Failed to launch "${bin}": ${err.message}. Is @agentspec/cli installed?`))
    })

    child.on('close', code => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `agentspec ${args[0]} exited with code ${code}`))
      }
    })
  })
}
