import type { AgentSpecManifest } from '../schema/manifest.schema.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GeneratedAgent {
  framework: string
  files: Record<string, string>  // filename → content
  installCommands: string[]
  envVars: string[]
  readme: string
}

export interface FrameworkAdapter<TOptions = unknown> {
  framework: string
  version: string
  generate(manifest: AgentSpecManifest, options?: TOptions): GeneratedAgent
}

// ── Adapter registry ──────────────────────────────────────────────────────────

const _registry = new Map<string, FrameworkAdapter>()

/**
 * Register a framework adapter.
 * Called by adapter packages (e.g. @agentspec/adapter-langgraph) via side-effect import.
 */
export function registerAdapter(adapter: FrameworkAdapter): void {
  _registry.set(adapter.framework.toLowerCase(), adapter)
}

/**
 * Get a registered adapter by framework name.
 */
export function getAdapter(framework: string): FrameworkAdapter | undefined {
  return _registry.get(framework.toLowerCase())
}

/**
 * List all registered frameworks.
 */
export function listAdapters(): string[] {
  return [..._registry.keys()]
}

/**
 * Generate framework-specific agent code from a manifest.
 *
 * @throws Error if the framework adapter is not registered
 */
export function generateAdapter(
  manifest: AgentSpecManifest,
  framework: string,
  options?: unknown,
): GeneratedAgent {
  const adapter = _registry.get(framework.toLowerCase())
  if (!adapter) {
    throw new Error(
      `No adapter registered for framework: ${framework}\n` +
        `  Available: ${listAdapters().join(', ') || 'none'}\n` +
        `  Install an adapter package, e.g: npm install @agentspec/adapter-langgraph`,
    )
  }
  return adapter.generate(manifest, options)
}
