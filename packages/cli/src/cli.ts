import { Command } from 'commander'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { registerValidateCommand } from './commands/validate.js'
import { registerHealthCommand } from './commands/health.js'
import { registerAuditCommand } from './commands/audit.js'
import { registerInitCommand } from './commands/init.js'
import { registerGenerateCommand } from './commands/generate.js'
import { registerExportCommand } from './commands/export.js'
import { registerMigrateCommand } from './commands/migrate.js'
import { registerScanCommand } from './commands/scan.js'
import { registerDiffCommand } from './commands/diff.js'
import { registerGeneratePolicyCommand } from './commands/generate-policy.js'
import { registerEvaluateCommand } from './commands/evaluate.js'
import { registerProbeCommand } from './commands/probe.js'

const _dir = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(_dir, '../package.json'), 'utf8')) as { version: string }

const program = new Command()

program
  .name('agentspec')
  .description('Universal Agent Manifest System — validate, health-check, audit, and generate agents')
  .version(version)

registerValidateCommand(program)
registerHealthCommand(program)
registerAuditCommand(program)
registerInitCommand(program)
registerGenerateCommand(program)
registerExportCommand(program)
registerMigrateCommand(program)
registerScanCommand(program)
registerDiffCommand(program)
registerGeneratePolicyCommand(program)
registerEvaluateCommand(program)
registerProbeCommand(program)

program.parse(process.argv)
