import chalk from 'chalk'

export const symbols = {
  pass: chalk.green('✓'),
  fail: chalk.red('✗'),
  warn: chalk.yellow('⚠'),
  skip: chalk.gray('–'),
  info: chalk.blue('ℹ'),
  arrow: chalk.gray('→'),
}

export function formatSeverity(severity: string): string {
  switch (severity) {
    case 'critical': return chalk.bgRed.white(' CRITICAL ')
    case 'error':    return chalk.red('[error]')
    case 'high':     return chalk.red('[high]')
    case 'medium':   return chalk.yellow('[medium]')
    case 'warning':  return chalk.yellow('[warning]')
    case 'low':      return chalk.blue('[low]')
    case 'info':     return chalk.gray('[info]')
    default:         return chalk.gray(`[${severity}]`)
  }
}

export function formatGrade(grade: string): string {
  switch (grade) {
    case 'A': return chalk.bgGreen.black(` ${grade} `)
    case 'B': return chalk.bgGreenBright.black(` ${grade} `)
    case 'C': return chalk.bgYellow.black(` ${grade} `)
    case 'D': return chalk.bgYellowBright.black(` ${grade} `)
    case 'F': return chalk.bgRed.white(` ${grade} `)
    default:  return chalk.gray(grade)
  }
}

export function formatHealthStatus(status: string): string {
  switch (status) {
    case 'healthy':   return chalk.green('● healthy')
    case 'degraded':  return chalk.yellow('◐ degraded')
    case 'unhealthy': return chalk.red('○ unhealthy')
    default:          return status
  }
}

export function printHeader(title: string): void {
  console.log()
  console.log(chalk.bold.cyan(`  ${title}`))
  console.log(chalk.gray('  ' + '─'.repeat(title.length + 2)))
}

export function printError(msg: string): void {
  console.error(chalk.red(`\n  ✗ ${msg}\n`))
}

export function printSuccess(msg: string): void {
  console.log(chalk.green(`\n  ✓ ${msg}\n`))
}
