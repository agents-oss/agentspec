import { spawnCli } from '../cli-runner.js'

/**
 * Scan a source directory and generate an agent.yaml (dry-run: prints YAML, no write).
 * Returns the dry-run output from `agentspec scan --dir <dir> --dry-run`.
 */
export async function scan(dir: string): Promise<string> {
  const output = await spawnCli(['scan', '--dir', dir, '--dry-run'])
  return output.trim()
}
