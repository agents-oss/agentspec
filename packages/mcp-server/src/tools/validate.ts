import { spawnCli } from '../cli-runner.js'

/**
 * Validate an agent.yaml against the AgentSpec schema.
 * Returns JSON string: { success: true, output: string }
 */
export async function validate(file: string): Promise<string> {
  const output = await spawnCli(['validate', file])
  return JSON.stringify({ success: true, output: output.trim() })
}
