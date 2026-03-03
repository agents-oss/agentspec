import { Command } from 'commander'
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

const program = new Command()

program
  .name('agentspec')
  .description('Universal Agent Manifest System — validate, health-check, audit, and generate agents')
  .version('0.1.0')

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

program.parse(process.argv)
