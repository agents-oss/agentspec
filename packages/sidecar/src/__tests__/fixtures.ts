import type { AgentSpecManifest } from '@agentspec/sdk'

/**
 * Minimal valid manifest for sidecar unit tests.
 * Tool names use lowercase slugs as required by the schema.
 */
export const testManifest: AgentSpecManifest = {
  apiVersion: 'agentspec.io/v1',
  kind: 'AgentSpec',
  metadata: {
    name: 'gymcoach',
    version: '1.0.0',
    description: 'AI gym coaching assistant',
  },
  spec: {
    model: {
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      apiKey: '$env:GROQ_API_KEY',
    },
    prompts: {
      system: 'You are a gym coach.',
      hotReload: false,
    },
    tools: [
      {
        name: 'get-workout-history',
        type: 'function',
        description: 'Retrieve the user workout history',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
      },
      {
        name: 'log-workout',
        type: 'function',
        description: 'Log a completed workout session',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
    ],
    requires: {
      services: [
        { type: 'redis', connection: '$env:REDIS_URL' },
        { type: 'postgres', connection: '$env:DATABASE_URL' },
      ],
    },
  },
}
