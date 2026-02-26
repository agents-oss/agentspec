import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import yaml from 'js-yaml'
import { ManifestSchema, type AgentSpecManifest } from '../schema/manifest.schema.js'
import { resolveRefs, type ResolverOptions } from './resolvers.js'

export interface LoadOptions {
  /**
   * Whether to resolve $env:, $secret:, $file:, $func: references.
   * Default: false — validation only, no I/O side effects.
   */
  resolve?: boolean
  /**
   * Override secret backend. Default: process.env.AGENTSPEC_SECRET_BACKEND || 'env'
   */
  secretBackend?: ResolverOptions['secretBackend']
  /**
   * Fail on missing env vars during resolution. Default: true
   */
  failOnMissingEnv?: boolean
}

export interface ParsedManifest {
  /** The validated manifest (references NOT resolved unless opts.resolve=true) */
  manifest: AgentSpecManifest
  /** Absolute path to the agent.yaml file */
  filePath: string
  /** Directory containing agent.yaml — base for $file: resolution */
  baseDir: string
  /** Raw YAML string */
  raw: string
}

/**
 * Load and validate an agent.yaml manifest.
 *
 * @param filePath - absolute or relative path to agent.yaml
 * @param opts - loading options
 * @throws ZodError if the manifest fails validation
 * @throws Error if the file cannot be read or references cannot be resolved
 */
export function loadManifest(
  filePath: string,
  opts: LoadOptions = {},
): ParsedManifest {
  const absPath = resolve(filePath)
  const baseDir = dirname(absPath)

  let raw: string
  try {
    raw = readFileSync(absPath, 'utf-8')
  } catch (err) {
    throw new Error(`Cannot read manifest: ${absPath}\n  ${String(err)}`)
  }

  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    throw new Error(`Invalid YAML in ${absPath}\n  ${String(err)}`)
  }

  // Optionally resolve all $-references before validation
  const toValidate =
    opts.resolve === true
      ? resolveRefs(parsed, {
          baseDir,
          secretBackend: opts.secretBackend,
          failOnMissingEnv: opts.failOnMissingEnv ?? true,
        })
      : parsed

  // Validate with Zod schema
  const manifest = ManifestSchema.parse(toValidate)

  return { manifest, filePath: absPath, baseDir, raw }
}

/**
 * Same as loadManifest but returns a Result instead of throwing.
 */
export function tryLoadManifest(
  filePath: string,
  opts: LoadOptions = {},
): { ok: true; data: ParsedManifest } | { ok: false; error: Error } {
  try {
    return { ok: true, data: loadManifest(filePath, opts) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}
