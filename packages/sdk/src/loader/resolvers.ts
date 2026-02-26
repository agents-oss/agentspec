import { readFileSync } from 'node:fs'
import { resolve, dirname, sep } from 'node:path'

export type SecretBackend = 'env' | 'vault' | 'aws' | 'gcp' | 'azure'

export interface ResolverOptions {
  /** Directory where agent.yaml lives — used to resolve $file: paths */
  baseDir: string
  /** Override the secret backend (default: AGENTSPEC_SECRET_BACKEND || 'env') */
  secretBackend?: SecretBackend
  /** If true, throw on missing $env vars. Default: true */
  failOnMissingEnv?: boolean
}

// Detect the reference type from a value string
export type RefType = 'env' | 'secret' | 'file' | 'func' | 'literal'

export function detectRefType(value: string): RefType {
  if (value.startsWith('$env:')) return 'env'
  if (value.startsWith('$secret:')) return 'secret'
  if (value.startsWith('$file:')) return 'file'
  if (value.startsWith('$func:')) return 'func'
  return 'literal'
}

/** Built-in $func: implementations */
const BUILTINS: Record<string, () => string> = {
  now_iso: () => new Date().toISOString(),
  now_unix: () => String(Math.floor(Date.now() / 1000)),
  now_date: () => new Date().toISOString().split('T')[0]!,
}

/**
 * Resolve a single reference value.
 * Returns the resolved string or null if optional and missing.
 */
export function resolveRef(
  value: string,
  opts: ResolverOptions,
  { optional = false }: { optional?: boolean } = {},
): string {
  const refType = detectRefType(value)

  if (refType === 'literal') return value

  if (refType === 'env') {
    const varName = value.slice('$env:'.length)
    const resolved = process.env[varName]
    if (resolved === undefined) {
      if (optional || opts.failOnMissingEnv === false) return ''
      throw new Error(
        `Missing environment variable: ${varName}\n` +
          `  Referenced as ${value}\n` +
          `  Set ${varName} in your .env file or environment`,
      )
    }
    return resolved
  }

  if (refType === 'secret') {
    const secretName = value.slice('$secret:'.length)
    const backend: SecretBackend =
      opts.secretBackend ??
      ((process.env['AGENTSPEC_SECRET_BACKEND'] as SecretBackend) || 'env')
    return resolveSecret(secretName, backend)
  }

  if (refType === 'file') {
    const filePath = value.slice('$file:'.length)
    const absPath = resolve(opts.baseDir, filePath)

    // Path traversal guard: the resolved path must remain within baseDir
    const normalizedBase = resolve(opts.baseDir) + sep
    if (!absPath.startsWith(normalizedBase) && absPath !== resolve(opts.baseDir)) {
      throw new Error(
        `Path traversal detected in ${value}\n` +
          `  Resolved to: ${absPath}\n` +
          `  Which is outside baseDir: ${opts.baseDir}\n` +
          `  Use paths relative to agent.yaml location only`,
      )
    }

    try {
      return readFileSync(absPath, 'utf-8')
    } catch {
      if (optional) return ''
      throw new Error(
        `Cannot read file referenced by ${value}\n` +
          `  Resolved path: ${absPath}`,
      )
    }
  }

  if (refType === 'func') {
    const funcName = value.slice('$func:'.length)
    const fn = BUILTINS[funcName]
    if (!fn) {
      throw new Error(
        `Unknown $func: ${funcName}\n` +
          `  Available functions: ${Object.keys(BUILTINS).join(', ')}`,
      )
    }
    return fn()
  }

  return value
}

function resolveSecret(name: string, backend: SecretBackend): string {
  switch (backend) {
    case 'env': {
      // Fallback: treat $secret:name as env var AGENTSPEC_SECRET_<NAME>
      const envKey = `AGENTSPEC_SECRET_${name.toUpperCase().replace(/-/g, '_')}`
      const val = process.env[envKey]
      if (!val) {
        throw new Error(
          `Secret "${name}" not found.\n` +
            `  In 'env' backend, set environment variable: ${envKey}`,
        )
      }
      return val
    }
    case 'vault':
    case 'aws':
    case 'gcp':
    case 'azure':
      // In runtime, callers should have pre-resolved secrets before loading.
      // Throw a clear "not implemented" to guide users.
      throw new Error(
        `Secret backend "${backend}" requires async resolution.\n` +
          `  Use loadManifestWithSecrets() which pre-fetches all secrets,\n` +
          `  or set AGENTSPEC_SECRET_BACKEND=env and map secrets to env vars.`,
      )
  }
}

/**
 * Deeply walk a parsed YAML object and resolve all reference strings.
 * Returns a new object with all $ref values replaced.
 */
export function resolveRefs(
  obj: unknown,
  opts: ResolverOptions,
): unknown {
  if (typeof obj === 'string') {
    return resolveRef(obj, opts, { optional: true })
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, opts))
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveRefs(val, opts)
    }
    return result
  }
  return obj
}

/**
 * Collect all $env: references from the raw manifest for health-check reporting.
 * Does NOT resolve them — just lists which env vars are referenced.
 */
export function collectEnvRefs(obj: unknown, refs: Set<string> = new Set()): Set<string> {
  if (typeof obj === 'string' && obj.startsWith('$env:')) {
    refs.add(obj.slice('$env:'.length))
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectEnvRefs(item, refs)
  } else if (obj !== null && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      collectEnvRefs(val, refs)
    }
  }
  return refs
}

/**
 * Collect all $file: references from the raw manifest.
 */
export function collectFileRefs(obj: unknown, refs: Set<string> = new Set()): Set<string> {
  if (typeof obj === 'string' && obj.startsWith('$file:')) {
    refs.add(obj.slice('$file:'.length))
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectFileRefs(item, refs)
  } else if (obj !== null && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      collectFileRefs(val, refs)
    }
  }
  return refs
}
