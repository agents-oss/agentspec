import { spawnCli } from '../cli-runner.js'

/**
 * Generate framework code from an agent.yaml.
 * Returns JSON string: { success: true, output: string }
 */
export async function generate(file: string, framework: string, out?: string): Promise<string> {
  const args = ['generate', file, '--framework', framework]
  if (out) args.push('--out', out)
  const output = await spawnCli(args)
  return JSON.stringify({ success: true, output: output.trim() })
}
