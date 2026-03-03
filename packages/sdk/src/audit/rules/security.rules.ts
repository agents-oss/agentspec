import type { AgentSpecManifest } from '../../schema/manifest.schema.js'
import type { AuditRule, RuleResult } from '../index.js'

export const securityRules: AuditRule[] = [
  {
    id: 'SEC-LLM-01',
    pack: 'owasp-llm-top10',
    title: 'Prompt injection guard: input guardrail required',
    description:
      'OWASP LLM Top 10 #1: Agents should have input guardrails to detect prompt injection',
    severity: 'high',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasGuardrail =
        manifest.spec.guardrails?.input?.some(
          (g) => g.type === 'prompt-injection' || g.type === 'topic-filter',
        ) ?? false
      return {
        pass: hasGuardrail,
        message: hasGuardrail
          ? undefined
          : 'No input guardrail configured. Prompt injection attacks are unmitigated.',
        path: '/spec/guardrails/input',
        recommendation:
          'Add a prompt-injection guardrail to spec.guardrails.input',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm01-prompt-injection',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-02',
    pack: 'owasp-llm-top10',
    title: 'Insecure output handling: output guardrail required',
    description: 'OWASP LLM Top 10 #2: Agents should validate and sanitize LLM outputs',
    severity: 'high',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasGuardrail = (manifest.spec.guardrails?.output?.length ?? 0) > 0
      return {
        pass: hasGuardrail,
        message: hasGuardrail
          ? undefined
          : 'No output guardrail configured. LLM outputs are not sanitized.',
        path: '/spec/guardrails/output',
        recommendation:
          'Add a toxicity-filter or hallucination-detector to spec.guardrails.output',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm02-insecure-output-handling',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-03',
    pack: 'owasp-llm-top10',
    title: 'Training/prompt data poisoning: prompt files referenced',
    description:
      'OWASP LLM Top 10 #3: Prompt content should be loaded from versioned files, not inlined in the manifest',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const system = manifest.spec.prompts.system
      const usesFile = system.startsWith('$file:')
      return {
        pass: usesFile,
        message: usesFile
          ? undefined
          : 'System prompt is inlined in the manifest rather than loaded from a versioned file. Inline prompts bypass version control and integrity checks.',
        path: '/spec/prompts/system',
        recommendation:
          'Use $file:prompts/system.md to load prompt from a versioned file that can be reviewed and audited.',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm03-training-data-poisoning',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-04',
    pack: 'owasp-llm-top10',
    title: 'Model DoS: rate limiting + cost controls declared',
    description: 'OWASP LLM Top 10 #4: Protect against denial-of-service via rate limiting',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasRateLimit = !!manifest.spec.api?.rateLimit?.requestsPerMinute
      const hasCostControls = !!manifest.spec.model.costControls?.maxMonthlyUSD
      const pass = hasRateLimit || hasCostControls
      return {
        pass,
        message: pass
          ? undefined
          : 'No rate limiting or cost controls declared.',
        path: '/spec/api/rateLimit',
        recommendation:
          'Add spec.api.rateLimit.requestsPerMinute and spec.model.costControls.maxMonthlyUSD',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm04-model-denial-of-service',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-05',
    pack: 'owasp-llm-top10',
    title: 'Supply chain: model provider and version pinned',
    description: 'OWASP LLM Top 10 #5: Pin model versions to prevent supply chain drift',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasProvider = !!manifest.spec.model.provider
      const hasVersion = !!manifest.spec.model.id && manifest.spec.model.id !== 'latest'
      const pass = hasProvider && hasVersion
      return {
        pass,
        message: pass
          ? undefined
          : 'Model provider or version not pinned.',
        path: '/spec/model',
        recommendation: 'Specify both spec.model.provider and a specific spec.model.id',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm05-supply-chain-vulnerabilities',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-06',
    pack: 'owasp-llm-top10',
    title: 'Sensitive data disclosure: PII scrub in memory hygiene',
    description:
      'OWASP LLM Top 10 #6: Agents storing long-term memory must scrub PII',
    severity: 'critical',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      if (!manifest.spec.memory?.longTerm) return { pass: true }
      const hasPiiScrub =
        (manifest.spec.memory.hygiene?.piiScrubFields?.length ?? 0) > 0
      return {
        pass: hasPiiScrub,
        message: hasPiiScrub
          ? undefined
          : 'Long-term memory declared without piiScrubFields — PII may be persisted.',
        path: '/spec/memory/hygiene/piiScrubFields',
        recommendation:
          'Add spec.memory.hygiene.piiScrubFields with sensitive fields like [ssn, credit_card, bank_account]',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm06-sensitive-information-disclosure',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-07',
    pack: 'owasp-llm-top10',
    title: 'Insecure plugin design: tool annotations declared',
    description: 'OWASP LLM Top 10 #7: Tools should declare their access scope via annotations',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      if (!manifest.spec.tools?.length) return { pass: true }
      const allAnnotated = manifest.spec.tools.every((t) => t.annotations !== undefined)
      return {
        pass: allAnnotated,
        message: allAnnotated
          ? undefined
          : 'Some tools lack annotations (readOnlyHint, destructiveHint).',
        path: '/spec/tools',
        recommendation:
          'Add annotations to each tool: { readOnlyHint: boolean, destructiveHint: boolean }',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm07-insecure-plugin-design',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-08',
    pack: 'owasp-llm-top10',
    title: 'Excessive agency: destructiveHint declared on tools',
    description:
      'OWASP LLM Top 10 #8: Destructive tools must be explicitly flagged to limit agent autonomy',
    severity: 'high',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      if (!manifest.spec.tools?.length) return { pass: true }
      const allHaveDestructiveHint = manifest.spec.tools.every(
        (t) => t.annotations?.destructiveHint !== undefined,
      )
      return {
        pass: allHaveDestructiveHint,
        message: allHaveDestructiveHint
          ? undefined
          : 'Some tools do not declare destructiveHint — excessive agency risk.',
        path: '/spec/tools',
        recommendation:
          'Add annotations.destructiveHint: true|false to every tool',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm08-excessive-agency',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-09',
    pack: 'owasp-llm-top10',
    title: 'Overreliance: evaluation framework + CI gate configured',
    description:
      'OWASP LLM Top 10 #9: Evaluation with a CI gate reduces overreliance on LLM outputs',
    severity: 'medium',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const hasEval = !!manifest.spec.evaluation?.framework
      const hasCiGate = manifest.spec.evaluation?.ciGate === true
      const pass = hasEval && hasCiGate
      return {
        pass,
        message: pass
          ? undefined
          : !hasEval
            ? 'No evaluation framework configured.'
            : 'Evaluation CI gate is not enabled.',
        path: '/spec/evaluation',
        recommendation:
          'Configure spec.evaluation.framework and set spec.evaluation.ciGate: true',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm09-overreliance',
        ],
      }
    },
  },

  {
    id: 'SEC-LLM-10',
    pack: 'owasp-llm-top10',
    title: 'Model theft: API keys use $secret, not $env',
    description:
      'OWASP LLM Top 10 #10: API keys should use $secret: not $env: to go through a secret manager',
    severity: 'high',
    evidenceLevel: 'declarative',
    check(manifest: AgentSpecManifest): RuleResult {
      const apiKey = manifest.spec.model.apiKey
      const usesSecret = apiKey.startsWith('$secret:')
      const usesEnv = apiKey.startsWith('$env:')
      const isLiteral = !apiKey.startsWith('$')
      // Only $secret: references pass — $env: and literal keys both fail
      return {
        pass: usesSecret,
        message: isLiteral
          ? 'Model API key appears to be a hardcoded literal value — credential exposure risk.'
          : usesEnv
            ? `Model API key uses $env: (${apiKey}). Prefer $secret: for production deployments.`
            : undefined,
        path: '/spec/model/apiKey',
        recommendation:
          'Use $secret:groq-api-key instead of $env:GROQ_API_KEY for production deployments',
        references: [
          'https://owasp.org/www-project-top-10-for-large-language-model-applications/#llm10-model-theft',
        ],
      }
    },
  },
]
