import { spawnCli } from '../cli-runner.js'

/**
 * Compare two agent.yaml files and return a JSON diff.
 * Returns the raw JSON output from `agentspec diff <from> <to> --json`.
 */
export async function diff(from: string, to: string): Promise<string> {
  const output = await spawnCli(['diff', from, to, '--json'])
  return output.trim()
}
