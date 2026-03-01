import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  // Bundle the workspace sibling so dist/index.js is self-contained
  // and doesn't need @agentspec/sdk in node_modules at runtime.
  noExternal: ['@agentspec/sdk'],
  // Keep optional LLM dep external — only loaded when ANTHROPIC_API_KEY is set
  external: ['@anthropic-ai/sdk'],
  sourcemap: true,
  clean: true,
})
