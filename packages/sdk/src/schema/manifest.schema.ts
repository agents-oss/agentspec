import { z } from 'zod'

// ── Reference syntax patterns ─────────────────────────────────────────────────
// $env:VAR_NAME  | $secret:name  | $file:path  | $func:now_iso  | literal string
const refOrLiteral = z.string()

// ── Metadata ──────────────────────────────────────────────────────────────────
const MetadataSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Must be a lowercase slug'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Must be semver (e.g. 1.0.0)'),
  description: z.string().min(1),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  license: z.string().optional(),
})

// ── Model ─────────────────────────────────────────────────────────────────────
const ModelFallbackSchema = z.object({
  provider: z.string(),
  id: z.string(),
  apiKey: refOrLiteral,
  triggerOn: z
    .array(z.enum(['rate_limit', 'timeout', 'error_5xx', 'error_4xx']))
    .optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
})

const ModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  apiKey: refOrLiteral,
  parameters: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).optional(),
      topP: z.number().min(0).max(1).optional(),
      frequencyPenalty: z.number().optional(),
      presencePenalty: z.number().optional(),
    })
    .optional(),
  fallback: ModelFallbackSchema.optional(),
  costControls: z
    .object({
      maxMonthlyUSD: z.number().positive().optional(),
      alertAtUSD: z.number().positive().optional(),
    })
    .optional(),
})

// ── Prompts ───────────────────────────────────────────────────────────────────
const PromptVariableSchema = z.object({
  name: z.string(),
  value: refOrLiteral,
})

const PromptsSchema = z.object({
  system: refOrLiteral,
  fallback: z.string().optional(),
  hotReload: z.boolean().optional().default(false),
  variables: z.array(PromptVariableSchema).optional(),
})

// ── Tools ─────────────────────────────────────────────────────────────────────
const ToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
})

const ToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Tool name must be a lowercase slug'),
  type: z.enum(['function', 'mcp', 'builtin']),
  description: z.string(),
  module: z.string().optional(), // $file: reference
  function: z.string().optional(),
  annotations: ToolAnnotationsSchema.optional(),
})

// ── MCP Servers ───────────────────────────────────────────────────────────────
const McpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string(), refOrLiteral).optional(),
  healthCheck: z
    .object({
      timeoutSeconds: z.number().int().min(1).max(60).default(5),
    })
    .optional(),
})

const McpSchema = z.object({
  servers: z.array(McpServerSchema),
})

// ── Memory ────────────────────────────────────────────────────────────────────
const ShortTermMemorySchema = z.object({
  backend: z.enum(['in-memory', 'redis', 'sqlite']),
  maxTurns: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
  ttlSeconds: z.number().int().min(0).optional(),
  connection: refOrLiteral.optional(),
})

const LongTermMemorySchema = z.object({
  backend: z.enum(['postgres', 'sqlite', 'mongodb']),
  connectionString: refOrLiteral,
  table: z.string().optional(),
  ttlDays: z.number().int().min(1).optional(),
})

const VectorMemorySchema = z.object({
  backend: z.enum(['pgvector', 'pinecone', 'weaviate', 'qdrant', 'chroma']),
  connectionString: refOrLiteral.optional(),
  apiKey: refOrLiteral.optional(),
  dimension: z.number().int().min(1),
  topK: z.number().int().min(1).optional(),
  namespace: z.string().optional(),
})

const MemoryHygieneSchema = z.object({
  piiScrubFields: z.array(z.string()).optional(),
  auditLog: z.boolean().optional().default(false),
  retentionPolicy: z.string().optional(),
})

const MemorySchema = z.object({
  shortTerm: ShortTermMemorySchema.optional(),
  longTerm: LongTermMemorySchema.optional(),
  vector: VectorMemorySchema.optional(),
  hygiene: MemoryHygieneSchema.optional(),
})

// ── Sub-agents ────────────────────────────────────────────────────────────────
const SubagentRefSchema = z.union([
  z.object({ agentspec: z.string() }), // local file path
  z.object({
    a2a: z.object({
      url: refOrLiteral,
      auth: z
        .object({
          type: z.enum(['bearer', 'apikey', 'none']),
          token: refOrLiteral.optional(),
          header: z.string().optional(),
        })
        .optional(),
    }),
  }),
])

const SubagentSchema = z.object({
  name: z.string(),
  ref: SubagentRefSchema,
  invocation: z.enum(['parallel', 'sequential', 'on-demand']),
  passContext: z.boolean().optional().default(false),
  triggerKeywords: z.array(z.string()).optional(),
})

// ── API ───────────────────────────────────────────────────────────────────────
const ChatEndpointSchema = z.object({
  path: z.string().optional().default('/v1/chat'),
  protocol: z.enum(['openai-compatible', 'custom']).optional().default('openai-compatible'),
  streaming: z.boolean().optional().default(true),
  sessionMode: z.enum(['stateful', 'stateless']).optional().default('stateful'),
  threadIdHeader: z.string().optional().default('X-Thread-Id'),
})

const ApiSchema = z.object({
  type: z.enum(['rest', 'mcp', 'grpc', 'websocket']),
  port: z.number().int().min(1).max(65535).optional(),
  pathPrefix: z.string().optional(),
  auth: z
    .object({
      type: z.enum(['jwt', 'apikey', 'oauth2', 'none']),
      jwksUri: refOrLiteral.optional(),
      header: z.string().optional(),
    })
    .optional(),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().int().min(1).optional(),
      requestsPerHour: z.number().int().min(1).optional(),
    })
    .optional(),
  streaming: z.boolean().optional().default(false),
  healthEndpoint: z.string().optional(),
  metricsEndpoint: z.string().optional(),
  corsOrigins: z.array(z.string()).optional(),
  /** Declares the conversational chat endpoint for this agent */
  chatEndpoint: ChatEndpointSchema.optional(),
})

// ── Skills ────────────────────────────────────────────────────────────────────
const SkillSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
})

// ── Guardrails ────────────────────────────────────────────────────────────────
const InputGuardrailSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('topic-filter'),
    blockedTopics: z.array(z.string()),
    action: z.enum(['reject', 'warn', 'log']),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('pii-detector'),
    action: z.enum(['scrub', 'reject', 'warn']),
    fields: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('prompt-injection'),
    action: z.enum(['reject', 'warn']),
    sensitivity: z.enum(['low', 'medium', 'high']).optional(),
  }),
  z.object({
    type: z.literal('custom'),
    module: z.string(),
    function: z.string(),
    action: z.enum(['reject', 'warn', 'log']),
  }),
])

const OutputGuardrailSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hallucination-detector'),
    threshold: z.number().min(0).max(1),
    action: z.enum(['reject', 'retry', 'warn']),
    maxRetries: z.number().int().min(1).max(5).optional(),
  }),
  z.object({
    type: z.literal('toxicity-filter'),
    threshold: z.number().min(0).max(1),
    action: z.enum(['reject', 'warn']),
  }),
  z.object({
    type: z.literal('pii-detector'),
    action: z.enum(['scrub', 'reject', 'warn']),
    fields: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('custom'),
    module: z.string(),
    function: z.string(),
    action: z.enum(['reject', 'warn', 'log']),
  }),
])

const GuardrailsSchema = z.object({
  input: z.array(InputGuardrailSchema).optional(),
  output: z.array(OutputGuardrailSchema).optional(),
})

// ── Evaluation ────────────────────────────────────────────────────────────────
const EvaluationSchema = z.object({
  framework: z.enum(['deepeval', 'braintrust', 'langsmith', 'ragas', 'custom']),
  datasets: z
    .array(
      z.object({
        name: z.string(),
        path: refOrLiteral,
      }),
    )
    .optional(),
  metrics: z
    .array(
      z.enum([
        'faithfulness',
        'answer_relevancy',
        'hallucination',
        'toxicity',
        'context_precision',
        'context_recall',
        'bias',
        'custom',
      ]),
    )
    .optional(),
  thresholds: z.record(z.string(), z.number().min(0).max(1)).optional(),
  ciGate: z.boolean().optional().default(false),
})

// ── Observability ─────────────────────────────────────────────────────────────
const ObservabilitySchema = z.object({
  tracing: z
    .object({
      backend: z.enum([
        'langfuse',
        'langsmith',
        'agentops',
        'otel',
        'honeycomb',
        'datadog',
      ]),
      endpoint: refOrLiteral.optional(),
      publicKey: refOrLiteral.optional(),
      secretKey: refOrLiteral.optional(),
      sampleRate: z.number().min(0).max(1).optional().default(1.0),
    })
    .optional(),
  metrics: z
    .object({
      backend: z.enum(['opentelemetry', 'prometheus', 'datadog']),
      endpoint: refOrLiteral.optional(),
      serviceName: z.string().optional(),
    })
    .optional(),
  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
      structured: z.boolean().optional().default(true),
      redactFields: z.array(z.string()).optional(),
    })
    .optional(),
})

// ── Compliance ────────────────────────────────────────────────────────────────
const ComplianceSuppressionSchema = z.object({
  rule: z.string(),
  reason: z.string(),
  approvedBy: z.string().optional(),
  expires: z.string().optional(), // ISO date
})

const ComplianceSchema = z.object({
  packs: z
    .array(
      z.enum([
        'owasp-llm-top10',
        'memory-hygiene',
        'model-resilience',
        'evaluation-coverage',
        'observability',
      ]),
    )
    .optional(),
  suppressions: z.array(ComplianceSuppressionSchema).optional(),
  auditSchedule: z.enum(['daily', 'weekly', 'monthly', 'on-change']).optional(),
})

// ── Runtime Requirements ──────────────────────────────────────────────────────
const RequiresSchema = z.object({
  envVars: z.array(z.string()).optional(),
  services: z
    .array(
      z.object({
        type: z.enum(['postgres', 'redis', 'mysql', 'mongodb', 'elasticsearch']),
        connection: refOrLiteral,
      }),
    )
    .optional(),
  minimumMemoryMB: z.number().int().min(128).optional(),
  nodeVersion: z.string().optional(),
  pythonVersion: z.string().optional(),
})

// ── Human-in-the-Loop ─────────────────────────────────────────────────────────
const HumanInTheLoopSchema = z.object({
  enabled: z.boolean().optional().default(false),
  approvalRequired: z
    .array(
      z.enum([
        'before-destructive-tool',
        'before-external-call',
        'on-low-confidence',
        'on-high-cost',
        'always',
      ]),
    )
    .optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional().default(300),
  timeoutAction: z.enum(['reject', 'proceed', 'escalate']).optional().default('reject'),
  notifyVia: z
    .array(z.enum(['slack', 'email', 'webhook', 'console']))
    .optional(),
  webhookUrl: refOrLiteral.optional(),
})

// ── Full Spec ─────────────────────────────────────────────────────────────────
const SpecSchema = z.object({
  model: ModelSchema,
  prompts: PromptsSchema,
  tools: z.array(ToolSchema).optional(),
  mcp: McpSchema.optional(),
  memory: MemorySchema.optional(),
  subagents: z.array(SubagentSchema).optional(),
  api: ApiSchema.optional(),
  skills: z.array(SkillSchema).optional(),
  guardrails: GuardrailsSchema.optional(),
  humanInTheLoop: HumanInTheLoopSchema.optional(),
  evaluation: EvaluationSchema.optional(),
  observability: ObservabilitySchema.optional(),
  compliance: ComplianceSchema.optional(),
  requires: RequiresSchema.optional(),
})

// ── Top-level Manifest ────────────────────────────────────────────────────────
export const ManifestSchema = z.object({
  apiVersion: z.literal('agentspec.io/v1'),
  kind: z.literal('AgentSpec'),
  metadata: MetadataSchema,
  spec: SpecSchema,
})

export type AgentSpecManifest = z.infer<typeof ManifestSchema>
export type AgentSpecMetadata = z.infer<typeof MetadataSchema>
export type AgentSpecModel = z.infer<typeof ModelSchema>
export type AgentSpecPrompts = z.infer<typeof PromptsSchema>
export type AgentSpecTool = z.infer<typeof ToolSchema>
export type AgentSpecMcpServer = z.infer<typeof McpServerSchema>
export type AgentSpecMemory = z.infer<typeof MemorySchema>
export type AgentSpecGuardrails = z.infer<typeof GuardrailsSchema>
export type AgentSpecHumanInTheLoop = z.infer<typeof HumanInTheLoopSchema>
export type AgentSpecChatEndpoint = z.infer<typeof ChatEndpointSchema>
export type AgentSpecEvaluation = z.infer<typeof EvaluationSchema>
export type AgentSpecObservability = z.infer<typeof ObservabilitySchema>
export type AgentSpecCompliance = z.infer<typeof ComplianceSchema>
export type AgentSpecRequires = z.infer<typeof RequiresSchema>
