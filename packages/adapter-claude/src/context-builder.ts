import type { AgentSpecManifest } from '@agentspec/sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BuildContextOptions {
  manifest: AgentSpecManifest
  contextFiles?: string[]
  /** Base directory for resolving $file: references in spec.tools[].module */
  manifestDir?: string
}

/**
 * Scan spec.tools[].module for $file: references and return resolved absolute paths.
 * This gives Claude the actual tool implementations to reference when generating typed wrappers.
 */
function extractFileRefs(manifest: AgentSpecManifest, baseDir: string): string[] {
  const refs: string[] = []
  for (const tool of manifest.spec.tools ?? []) {
    const mod = (tool as Record<string, unknown>).module as string | undefined
    if (typeof mod === 'string' && mod.startsWith('$file:')) {
      refs.push(join(baseDir, mod.slice(6)))
    }
  }
  return refs
}

/**
 * Build the user-message context for Claude from a manifest + optional source files.
 * The manifest is serialised as JSON. Context files are appended verbatim so Claude
 * can infer tool signatures, existing patterns, etc.
 *
 * When manifestDir is provided, $file: references in spec.tools[].module are automatically
 * resolved and included as context files.
 */
export function buildContext(options: BuildContextOptions): string {
  const { manifest, contextFiles = [], manifestDir } = options

  const resolvedRefs = manifestDir ? extractFileRefs(manifest, manifestDir) : []
  const allContextFiles = [...resolvedRefs, ...contextFiles]

  const parts: string[] = [
    '## Agent Manifest (JSON)',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
  ]

  for (const filePath of allContextFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const ext = filePath.split('.').pop() ?? ''
      parts.push(`\n## Context File: ${filePath}`)
      parts.push(`\`\`\`${ext}`)
      parts.push(content)
      parts.push('```')
    } catch {
      // Silently skip unreadable context files
    }
  }

  return parts.join('\n')
}
