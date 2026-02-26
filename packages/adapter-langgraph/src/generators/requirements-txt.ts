import type { AgentSpecManifest } from '@agentspec/sdk'

const PROVIDER_PACKAGES: Record<string, string> = {
  openai: 'langchain-openai',
  anthropic: 'langchain-anthropic',
  groq: 'langchain-groq',
  google: 'langchain-google-genai',
  azure: 'langchain-openai',
  mistral: 'langchain-mistralai',
  together: 'langchain-together',
  fireworks: 'langchain-fireworks',
  cohere: 'langchain-cohere',
}

export function generateRequirementsTxt(manifest: AgentSpecManifest): string {
  const packages = new Set<string>([
    'langgraph>=0.2.0',
    'langchain-core>=0.3.0',
    'python-dotenv>=1.0.0',
  ])

  // Model provider
  const pkg = PROVIDER_PACKAGES[manifest.spec.model.provider.toLowerCase()] ?? 'langchain-openai'
  packages.add(`${pkg}>=0.1.0`)

  // Fallback provider
  if (manifest.spec.model.fallback) {
    const fbPkg =
      PROVIDER_PACKAGES[manifest.spec.model.fallback.provider.toLowerCase()] ?? 'langchain-openai'
    if (fbPkg !== pkg) packages.add(`${fbPkg}>=0.1.0`)
  }

  // Memory backends
  if (manifest.spec.memory?.shortTerm) {
    switch (manifest.spec.memory.shortTerm.backend) {
      case 'redis':
        packages.add('langgraph-checkpoint-redis>=0.1.0')
        packages.add('redis>=5.0.0')
        break
      case 'sqlite':
        packages.add('langgraph-checkpoint-sqlite>=0.1.0')
        break
    }
  }

  // Observability
  if (manifest.spec.observability?.tracing) {
    switch (manifest.spec.observability.tracing.backend) {
      case 'langfuse':
        packages.add('langfuse>=2.0.0')
        break
      case 'langsmith':
        packages.add('langsmith>=0.1.0')
        break
    }
  }

  // Evaluation
  if (manifest.spec.evaluation) {
    switch (manifest.spec.evaluation.framework) {
      case 'deepeval':
        packages.add('deepeval>=1.0.0')
        break
      case 'ragas':
        packages.add('ragas>=0.1.0')
        break
    }
  }

  return [...packages].sort().join('\n') + '\n'
}
