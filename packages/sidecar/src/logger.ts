/**
 * Minimal structured JSON logger for the sidecar.
 *
 * Writes newline-delimited JSON to stdout (info) or stderr (error),
 * compatible with Kubernetes log aggregators (Datadog, ELK, GCP Logging).
 *
 * Format: { "ts": "<ISO>", "level": "info"|"error", "msg": "...", ...extra }
 */

function write(stream: NodeJS.WriteStream, level: string, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })
  stream.write(line + '\n')
}

export const log = {
  info(msg: string, extra?: Record<string, unknown>): void {
    write(process.stdout, 'info', msg, extra)
  },
  error(msg: string, extra?: Record<string, unknown>): void {
    write(process.stderr, 'error', msg, extra)
  },
}
