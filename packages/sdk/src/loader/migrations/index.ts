import { v1alpha1ToV1 } from './v1alpha1-to-v1.js'

export interface Migration {
  from: string
  to: string
  migrate(raw: Record<string, unknown>): Record<string, unknown>
}

const migrations: Migration[] = [v1alpha1ToV1]

export const LATEST_API_VERSION = 'agentspec.io/v1'

export function migrateManifest(raw: Record<string, unknown>): {
  result: Record<string, unknown>
  migrationsApplied: string[]
} {
  let current = raw
  const migrationsApplied: string[] = []

  for (const m of migrations) {
    const version = (current.apiVersion as string | undefined) ?? ''
    if (version === m.from || version.startsWith(m.from)) {
      current = m.migrate(current)
      migrationsApplied.push(`${m.from} → ${m.to}`)
    }
  }

  return { result: current, migrationsApplied }
}

export function detectVersion(raw: Record<string, unknown>): string {
  return (raw.apiVersion as string | undefined) ?? 'unknown'
}

export function isLatestVersion(raw: Record<string, unknown>): boolean {
  return detectVersion(raw) === LATEST_API_VERSION
}
