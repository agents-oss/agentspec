/**
 * `agentspec scan --dir <src>`
 *
 * Claude-powered source analysis: reads .py / .ts / .js files and generates
 * an agent.yaml manifest from what it finds.
 *
 * Output behaviour:
 *   No existing agent.yaml  →  writes agent.yaml
 *   Existing agent.yaml, no --update  →  writes agent.yaml.new
 *   Existing agent.yaml + --update  →  overwrites agent.yaml
 *   --out <path>  →  writes to that resolved path (ignores above logic)
 *   --dry-run  →  prints to stdout, writes nothing
 *
 * Security:
 *   - Symlinks are skipped (lstatSync) to prevent traversal to outside srcDir
 *   - All resolved paths are checked against the srcDir prefix
 *   - node_modules / .git / dist and other non-user dirs are excluded
 *   - Total source content is capped at 200 KB before being sent to Claude
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { Command } from 'commander'
import { spinner } from '@clack/prompts'
import { generateWithClaude } from '@agentspec/adapter-claude'

// ── Public types ──────────────────────────────────────────────────────────────

export interface SourceFile {
  path: string
  content: string
}

export interface ScanOptions {
  srcDir: string
  out?: string
  update?: boolean
  dryRun?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILES = 50
const MAX_BYTES = 200 * 1024 // 200 KB

const SOURCE_EXTENSIONS = new Set(['.py', '.ts', '.js', '.mjs', '.cjs'])

/** Directories that never contain user-authored source code. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', '.env',
  'dist', 'build', '.next', '.nuxt', 'coverage', '.tox', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', 'target', 'out', '.turbo',
])

// ── collectSourceFiles ────────────────────────────────────────────────────────

/**
 * Recursively collect source files from srcDir.
 *
 * Security guarantees:
 *  - Symlinks are detected via `lstatSync` and skipped entirely.
 *  - Every regular file's real path is checked to stay within srcDir.
 *  - Directories named in SKIP_DIRS or starting with '.' are skipped.
 *
 * Caps:
 *  - At most `maxFiles` files (default 50).
 *  - At most `maxBytes` total content (default 200 KB); last file is truncated if needed.
 */
export function collectSourceFiles(
  srcDir: string,
  maxFiles = MAX_FILES,
  maxBytes = MAX_BYTES,
): SourceFile[] {
  // Use realpathSync so that on systems where /tmp → /private/tmp (macOS),
  // the base and all file paths share the same canonical prefix.
  let resolvedBase: string
  try {
    resolvedBase = realpathSync(resolve(srcDir))
  } catch {
    resolvedBase = resolve(srcDir)
  }
  const results: SourceFile[] = []
  let totalBytes = 0

  function walk(dir: string): void {
    if (results.length >= maxFiles) return
    if (totalBytes >= maxBytes) return

    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break
      if (totalBytes >= maxBytes) break

      // Skip hidden dirs and known non-user dirs
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue

      const fullPath = join(dir, entry)

      // [C1] Use lstatSync — does NOT follow symlinks
      let stat
      try {
        stat = lstatSync(fullPath)
      } catch {
        continue
      }

      // Skip all symlinks to prevent traversal to outside srcDir
      if (stat.isSymbolicLink()) continue

      if (stat.isDirectory()) {
        // Guard: canonical directory path must stay within base
        let resolvedDir: string
        try {
          resolvedDir = realpathSync(fullPath)
        } catch {
          continue
        }
        if (!resolvedDir.startsWith(resolvedBase + '/') && resolvedDir !== resolvedBase) continue
        walk(fullPath)
      } else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry))) {
        // [C1] Double-check real path for any OS-level indirection
        let realPath: string
        try {
          realPath = realpathSync(fullPath)
        } catch {
          continue
        }
        if (!realPath.startsWith(resolvedBase + '/') && realPath !== resolvedBase) continue

        let content: string
        try {
          content = readFileSync(fullPath, 'utf-8')
        } catch {
          continue
        }
        const remaining = maxBytes - totalBytes
        if (content.length > remaining) {
          content = content.slice(0, remaining)
        }
        totalBytes += content.length
        results.push({ path: fullPath, content })
      }
    }
  }

  walk(resolvedBase)
  return results
}

// ── resolveOutputPath ─────────────────────────────────────────────────────────

/**
 * Determine the path where agent.yaml will be written.
 *
 * --out <path>   →  resolve(that path) — always absolute
 * --dry-run      →  still returns a resolved path; caller skips the write
 * existing yaml  →  agent.yaml.new (unless --update)
 * no existing    →  agent.yaml
 */
export function resolveOutputPath(opts: ScanOptions): string {
  // [H3] Always resolve to absolute path so callers get a canonical path
  if (opts.out) return resolve(opts.out)

  const defaultPath = join(resolve(opts.srcDir), 'agent.yaml')

  if (opts.update || opts.dryRun) return defaultPath
  if (existsSync(defaultPath)) return join(resolve(opts.srcDir), 'agent.yaml.new')
  return defaultPath
}

// ── Commander registration ─────────────────────────────────────────────────────

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Scan source code and generate an agent.yaml manifest (Claude-powered)')
    .requiredOption('-d, --dir <src>', 'Source directory to scan')
    .option('--out <path>', 'Explicit output path')
    .option('--update', 'Overwrite existing agent.yaml in place')
    .option('--dry-run', 'Print generated YAML to stdout without writing')
    .action(async (opts: { dir: string; out?: string; update?: boolean; dryRun?: boolean }) => {
      if (!process.env['ANTHROPIC_API_KEY']) {
        console.error(
          'ANTHROPIC_API_KEY is not set. agentspec scan uses Claude to analyse source code.\n' +
          'Get a key at https://console.anthropic.com',
        )
        process.exit(1)
      }

      const srcDir = resolve(opts.dir)

      // Collect source files (caps enforced inside)
      const sourceFiles = collectSourceFiles(srcDir)

      if (sourceFiles.length === 0) {
        console.warn(`No source files found in ${srcDir}`)
      }

      // Warn if capped (count without reading content — shares security rules)
      const rawCount = countSourceFiles(srcDir)
      if (rawCount > MAX_FILES) {
        console.warn(
          `Found ${rawCount} source files — truncating to ${MAX_FILES} files cap. ` +
          `Use a narrower --dir path to scan specific modules.`
        )
      }

      const s = spinner()
      s.start('Analysing source code with Claude…')

      // [H1] Pass source file paths to generateWithClaude via contextFiles.
      // adapter-claude's buildContext reads each path and embeds its content
      // in the prompt, making all source code visible to the Claude skill.
      let rawResult: unknown
      try {
        rawResult = await generateWithClaude(
          {}, // empty manifest — the scan skill generates one from source
          {
            framework: 'scan',
            contextFiles: sourceFiles.map(f => f.path),
            manifestDir: srcDir,
          },
        )
      } catch (err) {
        s.stop('Failed')
        console.error(`Scan failed: ${(err as Error).message}`)
        process.exit(1)
      }

      s.stop('Analysis complete')

      // [H2] Runtime validation — never trust the cast alone
      if (
        !rawResult ||
        typeof rawResult !== 'object' ||
        !('files' in rawResult) ||
        typeof (rawResult as Record<string, unknown>).files !== 'object' ||
        (rawResult as Record<string, unknown>).files === null
      ) {
        console.error('Claude returned an unexpected response format (missing "files" object).')
        process.exit(1)
      }

      const result = rawResult as { files: Record<string, string> }
      const agentYaml = result.files['agent.yaml']
      if (!agentYaml) {
        console.error('Claude did not return an agent.yaml in the output.')
        process.exit(1)
      }

      if (opts.dryRun) {
        console.log(agentYaml)
        return
      }

      const outPath = resolveOutputPath({
        srcDir,
        out: opts.out,
        update: opts.update,
        dryRun: opts.dryRun,
      })

      writeFileSync(outPath, agentYaml, 'utf-8')
      console.log(`✓ Written: ${outPath}`)
    })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Count source files without reading content (for cap warning).
 *
 * [C2] Applies the same security guards as collectSourceFiles:
 *   - Symlinks skipped via lstatSync
 *   - Path kept within resolvedBase
 *   - SKIP_DIRS excluded
 */
function countSourceFiles(srcDir: string): number {
  let resolvedBase: string
  try {
    resolvedBase = realpathSync(resolve(srcDir))
  } catch {
    resolvedBase = resolve(srcDir)
  }
  let count = 0

  function walk(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue

      const fullPath = join(dir, entry)
      let stat
      try {
        stat = lstatSync(fullPath) // [C2] lstatSync — no symlink following
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue

      if (stat.isDirectory()) {
        let resolvedDir: string
        try {
          resolvedDir = realpathSync(fullPath)
        } catch {
          continue
        }
        if (!resolvedDir.startsWith(resolvedBase + '/') && resolvedDir !== resolvedBase) continue
        walk(fullPath)
      } else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry))) {
        count++
      }
    }
  }

  walk(resolvedBase)
  return count
}
