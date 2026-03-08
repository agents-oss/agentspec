import { z } from 'zod'

// ── Reference syntax patterns ─────────────────────────────────────────────────
// $env:VAR_NAME  | $secret:name  | $file:path  | $func:now_iso  | literal string
const refOrLiteral = z.string()
const refDesc =
  'Supports reference syntax: "$env:VAR_NAME" (env var), "$secret:name" (secret manager), "$file:path" (file relative to agent.yaml), or a literal string value.'

// ── Metadata ──────────────────────────────────────────────────────────────────
const MetadataSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Must be a lowercase slug'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Must be semver (e.g. 1.0.0)'),
  description: z.string().min(1),
  tags: z.array(z.string()).optional()
    .describe('Free-form tags for filtering and discovery (e.g. ["finance", "rag", "internal"]).'),
  author: z.string().optional(),
  license: z.string().optional()
    .describe('SPDX license identifier (e.g. "MIT", "Apache-2.0", "proprietary").'),
})

// ── Model ─────────────────────────────────────────────────────────────────────
const ModelFallbackSchema = z.object({
  provider: z.string()
    .describe('LLM provider for the fallback model. Common values: "openai", "anthropic", "groq", "google", "mistral", "azure", "bedrock".'),
  id: z.string()
    .describe('Model ID for the fallback (e.g. "gpt-4o-mini", "claude-haiku-4-5-20251001"). Must be a valid ID for the declared provider.'),
  apiKey: refOrLiteral.describe(refDesc),
  triggerOn: z
    .array(z.enum(['rate_limit', 'timeout', 'error_5xx', 'error_4xx']))
    .optional()
    .describe('Conditions that trigger failover to this model. Omit to use the fallback for all errors.'),
  maxRetries: z.number().int().min(0).max(10).optional()
    .describe('Number of retry attempts before failing over. Defaults to 0 (immediate failover).'),
})

const ModelSchema = z.object({
  provider: z.string()
    .describe('LLM provider. Common values: "openai", "anthropic", "groq", "google", "mistral", "azure", "bedrock". Determines the API client and base URL used.'),
  id: z.string()
    .describe('Exact model ID as accepted by the provider API (e.g. "gpt-4o", "claude-sonnet-4-6", "llama-3.1-70b-versatile"). Check provider docs for valid IDs.'),
  apiKey: refOrLiteral.describe(refDesc),
  parameters: z
    .object({
      temperature: z.number().min(0).max(2).optional()
        .describe('Sampling temperature. 0 = deterministic/focused, 1 = balanced, 2 = highly creative. Most providers recommend 0–1 for production agents.'),
      maxTokens: z.number().int().min(1).optional()
        .describe('Maximum tokens in the model response. Controls cost and latency. Check model context window limits.'),
      topP: z.number().min(0).max(1).optional()
        .describe('Nucleus sampling threshold. The model samples from the smallest set of tokens whose cumulative probability exceeds topP. Alternative to temperature — do not set both.'),
      frequencyPenalty: z.number().optional()
        .describe('Penalises tokens that have already appeared frequently in the output (-2.0–2.0). Positive values reduce repetition.'),
      presencePenalty: z.number().optional()
        .describe('Penalises tokens that appear at all in the output so far (-2.0–2.0). Positive values encourage the model to introduce new topics.'),
    })
    .optional(),
  fallback: ModelFallbackSchema.optional(),
  costControls: z
    .object({
      maxMonthlyUSD: z.number().positive().optional()
        .describe('Hard monthly spend cap in USD. Requests are rejected once this limit is reached.'),
      alertAtUSD: z.number().positive().optional()
        .describe('Send an alert when cumulative monthly spend crosses this USD threshold. Must be less than maxMonthlyUSD.'),
    })
    .optional(),
})

// ── Prompts ───────────────────────────────────────────────────────────────────
const PromptVariableSchema = z.object({
  name: z.string()
    .describe('Variable name used in the prompt template (e.g. "user_name" for {{user_name}}).'),
  value: refOrLiteral.describe(refDesc),
})

const PromptsSchema = z.object({
  system: refOrLiteral
    .describe('System prompt. Use "$file:prompts/system.md" to load from a file (recommended for long prompts), or provide an inline string. ' + refDesc),
  fallback: z.string().optional()
    .describe('Inline fallback system prompt used if the primary system prompt file cannot be loaded. Only applies when "system" is a $file: reference.'),
  hotReload: z.boolean().optional().default(false)
    .describe('When true, the system prompt file is re-read on every request instead of being cached at startup. Useful for rapid iteration without restarts.'),
  variables: z.array(PromptVariableSchema).optional()
    .describe('Template variables injected into the system prompt at runtime. Values support reference syntax for secrets and env vars.'),
})

// ── Tools ─────────────────────────────────────────────────────────────────────
const ToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional()
    .describe('MCP hint: tool does not modify state. Allows clients to show a read-only badge and skip confirmation prompts.'),
  destructiveHint: z.boolean().optional()
    .describe('MCP hint: tool may perform irreversible actions (delete, overwrite). Triggers human-in-the-loop approval when humanInTheLoop.approvalRequired includes "before-destructive-tool".'),
  idempotentHint: z.boolean().optional()
    .describe('MCP hint: calling the tool multiple times with the same inputs produces the same result. Allows safe retries.'),
  openWorldHint: z.boolean().optional()
    .describe('MCP hint: tool interacts with systems outside the agent\'s controlled environment (e.g. the internet). Affects trust level in tool outputs.'),
})

const ToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Tool name must be a lowercase slug'),
  type: z.enum(['function', 'mcp', 'builtin'])
    .describe('"function" = local code module, "mcp" = registered via an MCP server in spec.mcp, "builtin" = provided by the runtime (e.g. code-interpreter, web-search).'),
  description: z.string()
    .describe('Human-readable description of what the tool does and when the agent should use it. This text is included in the tool-call prompt.'),
  module: z.string().optional()
    .describe('Path to the module that implements this tool. Use "$file:tools/my_tool.py" syntax. Only required for type "function".'),
  function: z.string().optional()
    .describe('Name of the callable function exported from the module (e.g. "search", "run_query"). Only required for type "function".'),
  annotations: ToolAnnotationsSchema.optional(),
})

// ── MCP Servers ───────────────────────────────────────────────────────────────
const McpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'sse', 'http'])
    .describe('"stdio" = spawn a local process (requires "command"), "sse" = Server-Sent Events over HTTP, "http" = streamable HTTP (requires "url").'),
  command: z.string().optional()
    .describe('Shell command to spawn the MCP server process. Required for transport "stdio" (e.g. "npx", "python").'),
  args: z.array(z.string()).optional()
    .describe('Arguments passed to the command (e.g. ["-m", "my_mcp_server"]). Only used for transport "stdio".'),
  url: z.string().url().optional()
    .describe('Base URL of the remote MCP server. Required for transport "sse" or "http". ' + refDesc),
  env: z.record(z.string(), refOrLiteral).optional()
    .describe('Environment variables injected into the MCP server process. Values support reference syntax. Use "$env:API_KEY" to forward secrets without hardcoding.'),
  healthCheck: z
    .object({
      timeoutSeconds: z.number().int().min(1).max(60).default(5)
        .describe('Seconds to wait for the MCP server to respond during health checks. Increase for slow-starting processes.'),
    })
    .optional(),
})

const McpSchema = z.object({
  servers: z.array(McpServerSchema),
})

// ── Memory ────────────────────────────────────────────────────────────────────
const ShortTermMemorySchema = z.object({
  backend: z.enum(['in-memory', 'redis', 'sqlite']),
  maxTurns: z.number().int().min(1).optional()
    .describe('Maximum number of conversation turns (user + assistant message pairs) to retain in context. Older turns are evicted first. Use with maxTokens for dual-bounded windows.'),
  maxTokens: z.number().int().min(1).optional()
    .describe('Maximum total tokens across all retained messages. When exceeded, oldest turns are evicted. Required by MEM-05 compliance rule.'),
  ttlSeconds: z.number().int().min(0).optional()
    .describe('Time-to-live in seconds for memory entries. 0 = session-scoped (cleared when connection closes). Omitting means no expiry — increases PII exposure risk (MEM-02).'),
  connection: refOrLiteral.optional()
    .describe('Connection string for redis or sqlite backends. ' + refDesc),
})

const LongTermMemorySchema = z.object({
  backend: z.enum(['postgres', 'sqlite', 'mongodb']),
  connectionString: refOrLiteral
    .describe('Database connection URI. ' + refDesc),
  table: z.string().optional()
    .describe('Table or collection name where agent memories are stored. Defaults to "agent_memories" if omitted. Use a per-agent name to avoid cross-agent data leakage.'),
  ttlDays: z.number().int().min(1).optional()
    .describe('Time-to-live in days for long-term memory records. Omitting means no expiry — a compliance risk (MEM-02). Required by GDPR Article 5 data minimisation principle.'),
})

const VectorMemorySchema = z.object({
  backend: z.enum(['pgvector', 'pinecone', 'weaviate', 'qdrant', 'chroma']),
  connectionString: refOrLiteral.optional()
    .describe('Connection URI for self-hosted backends (pgvector, weaviate, qdrant, chroma). ' + refDesc),
  apiKey: refOrLiteral.optional()
    .describe('API key for managed backends (Pinecone, Weaviate Cloud). ' + refDesc),
  dimension: z.number().int().min(1)
    .describe('Embedding vector dimension. Must exactly match the output dimension of your embedding model (e.g. 1536 for text-embedding-3-small, 768 for nomic-embed-text). Mismatch causes insertion errors.'),
  topK: z.number().int().min(1).optional()
    .describe('Number of nearest-neighbour results to retrieve per similarity search. Higher values improve recall at the cost of latency and context token usage.'),
  namespace: z.string().optional()
    .describe('Logical partition within the vector store. Required by MEM-04 to prevent cross-agent data leakage. Recommended value: the agent name (spec.metadata.name).'),
})

const MemoryHygieneSchema = z.object({
  piiScrubFields: z.array(z.string()).optional()
    .describe(
      'PII field names to scrub before writing to long-term or vector memory. Required when longTerm is set (MEM-01). ' +
      'Use recogniser names compatible with your scrubbing library (e.g. Microsoft Presidio entity types): ' +
      '"email", "phone_number", "credit_card", "iban", "ssn", "bank_account", "passport", "drivers_license", ' +
      '"person_name", "date_of_birth", "address", "ip_address", "api_key", "password", "medical_record".'
    ),
  auditLog: z.boolean().optional().default(false)
    .describe('When true, all memory read and write operations are emitted as structured audit log events. Required for long-term memory (MEM-03) and HIPAA/SOC2 compliance.'),
  retentionPolicy: z.string().optional()
    .describe(
      'Named governance or compliance retention policy applied to this agent\'s memory. ' +
      'Informational label — must be consistent with ttlSeconds/ttlDays on the backend configs. ' +
      'Common values: "session" (cleared on disconnect), "ephemeral" (never persisted), ' +
      '"30d", "90d", "1y", "persistent" (explicit no-expiry opt-in), ' +
      '"gdpr-30d" (GDPR Art.5 minimum), "hipaa-6y" (HIPAA 45 CFR §164.530), "pci-dss-1y" (PCI DSS Req.10.7).'
    ),
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
          header: z.string().optional()
            .describe('HTTP header name for the API key (e.g. "X-API-Key"). Only used when auth type is "apikey".'),
        })
        .optional(),
    }),
  }),
])

const SubagentSchema = z.object({
  name: z.string(),
  ref: SubagentRefSchema,
  invocation: z.enum(['parallel', 'sequential', 'on-demand'])
    .describe('"parallel" = invoked concurrently with other subagents, "sequential" = invoked in order after previous subagents complete, "on-demand" = only invoked when the agent decides it is needed (triggered by LLM or triggerKeywords).'),
  passContext: z.boolean().optional().default(false)
    .describe('When true, the current conversation thread (messages so far) is forwarded to the subagent as context. Use with care — increases token usage and may leak sensitive conversation history.'),
  triggerKeywords: z.array(z.string()).optional()
    .describe('Keywords in user messages that automatically trigger this subagent (only applies when invocation is "on-demand"). Case-insensitive substring match.'),
})

// ── API ───────────────────────────────────────────────────────────────────────
const ChatEndpointSchema = z.object({
  path: z.string().optional().default('/v1/chat')
    .describe('URL path for the chat endpoint (e.g. "/v1/chat", "/api/chat"). Must start with "/".'),
  protocol: z.enum(['openai-compatible', 'custom']).optional().default('openai-compatible')
    .describe('"openai-compatible" = request/response shape matches the OpenAI Chat Completions API (enables drop-in compatibility with OpenAI SDKs). "custom" = proprietary shape defined by the agent.'),
  streaming: z.boolean().optional().default(true)
    .describe('When true, the endpoint supports Server-Sent Events streaming responses. Clients receive tokens as they are generated.'),
  sessionMode: z.enum(['stateful', 'stateless']).optional().default('stateful')
    .describe('"stateful" = conversation history is persisted per thread (requires threadIdHeader). "stateless" = each request is independent; no memory across calls.'),
  threadIdHeader: z.string().optional().default('X-Thread-Id')
    .describe('HTTP request header used to identify the conversation thread for stateful session routing (e.g. "X-Thread-Id", "X-Session-Id").'),
})

const ApiSchema = z.object({
  type: z.enum(['rest', 'mcp', 'grpc', 'websocket']),
  port: z.number().int().min(1).max(65535).optional(),
  pathPrefix: z.string().optional()
    .describe('URL path prefix applied to all API routes (e.g. "/api/v1"). Useful when the agent runs behind a reverse proxy.'),
  auth: z
    .object({
      type: z.enum(['jwt', 'apikey', 'oauth2', 'none']),
      jwksUri: refOrLiteral.optional()
        .describe('JWKS endpoint URL used to fetch public keys for JWT signature verification (e.g. "https://your-auth.example.com/.well-known/jwks.json"). ' + refDesc),
      header: z.string().optional()
        .describe('HTTP header name carrying the credential (e.g. "Authorization" for JWT bearer, "X-API-Key" for apikey auth). Defaults to "Authorization".'),
    })
    .optional(),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().int().min(1).optional()
        .describe('Maximum requests allowed per client per minute. Excess requests receive HTTP 429.'),
      requestsPerHour: z.number().int().min(1).optional()
        .describe('Maximum requests allowed per client per hour. Excess requests receive HTTP 429.'),
    })
    .optional(),
  streaming: z.boolean().optional().default(false)
    .describe('When true, the API supports streaming responses (SSE). Set true for conversational agents to reduce perceived latency.'),
  healthEndpoint: z.string().optional()
    .describe('URL path for the health check endpoint (e.g. "/health", "/ready"). Exposes agentspec health report. Defaults to "/agentspec/health" when using the SDK.'),
  metricsEndpoint: z.string().optional()
    .describe('URL path where Prometheus-format metrics are exposed (e.g. "/metrics"). Required for observability.metrics to be scraped.'),
  corsOrigins: z.array(z.string()).optional()
    .describe('Allowed CORS origins for browser clients (e.g. ["https://app.example.com", "http://localhost:3000"]). Use ["*"] only for fully public APIs.'),
  /** Declares the conversational chat endpoint for this agent */
  chatEndpoint: ChatEndpointSchema.optional(),
})

// ── Skills ────────────────────────────────────────────────────────────────────
const SkillSchema = z.object({
  id: z.string()
    .describe('Skill identifier as registered in the runtime skill registry (e.g. "code-interpreter", "image-gen").'),
  version: z.string().optional()
    .describe('Pinned skill version. Omit to use the latest available version. Semver range or exact version string.'),
})

// ── Guardrails ────────────────────────────────────────────────────────────────
const InputGuardrailSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('topic-filter'),
    blockedTopics: z.array(z.string())
      .describe('Topics or keywords that should be blocked in user input (e.g. ["competitor-names", "legal-advice"]). Case-insensitive substring match against the full message.'),
    action: z.enum(['reject', 'warn', 'log'])
      .describe('"reject" = refuse the request and return an error, "warn" = continue but emit a warning event, "log" = silently log the violation.'),
    message: z.string().optional()
      .describe('Custom error message returned to the user when a topic is blocked. Defaults to a generic refusal message.'),
  }),
  z.object({
    type: z.literal('pii-detector'),
    action: z.enum(['scrub', 'reject', 'warn'])
      .describe('"scrub" = replace detected PII with placeholders before passing to the model, "reject" = refuse the request, "warn" = pass through but emit a warning event.'),
    fields: z.array(z.string()).optional()
      .describe('Specific PII entity types to detect. When omitted, all PII types supported by the detection library are scanned. Use the same entity names as in spec.memory.hygiene.piiScrubFields.'),
  }),
  z.object({
    type: z.literal('prompt-injection'),
    action: z.enum(['reject', 'warn']),
    sensitivity: z.enum(['low', 'medium', 'high']).optional()
      .describe('Detection sensitivity. "low" = only block obvious injection patterns, "medium" = balanced (default), "high" = aggressive — may produce false positives on legitimate complex instructions.'),
  }),
  z.object({
    type: z.literal('custom'),
    module: z.string()
      .describe('Path to the module implementing the guardrail function. Use "$file:guardrails/my_check.py" syntax.'),
    function: z.string()
      .describe('Name of the guardrail function exported from the module. Signature: (input: str) -> None (raise to block) or (input: str) -> str (return scrubbed value).'),
    action: z.enum(['reject', 'warn', 'log']),
  }),
])

const OutputGuardrailSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hallucination-detector'),
    threshold: z.number().min(0).max(1)
      .describe('Confidence score below which a response is considered hallucinated (0.0–1.0). 0.0 = block everything, 1.0 = block nothing. Typical value: 0.5–0.7.'),
    action: z.enum(['reject', 'retry', 'warn'])
      .describe('"reject" = return error to user, "retry" = re-invoke the model (up to maxRetries), "warn" = return response with a warning annotation.'),
    maxRetries: z.number().int().min(1).max(5).optional()
      .describe('Maximum re-generation attempts before giving up. Only used when action is "retry". Defaults to 1.'),
  }),
  z.object({
    type: z.literal('toxicity-filter'),
    threshold: z.number().min(0).max(1)
      .describe('Toxicity score above which a response is blocked (0.0–1.0). 0.0 = block all output, 1.0 = block nothing. Typical production value: 0.7–0.85.'),
    action: z.enum(['reject', 'warn']),
  }),
  z.object({
    type: z.literal('pii-detector'),
    action: z.enum(['scrub', 'reject', 'warn'])
      .describe('"scrub" = replace PII in the model output before returning to the user, "reject" = discard the response and return an error, "warn" = return with a warning annotation.'),
    fields: z.array(z.string()).optional()
      .describe('Specific PII entity types to detect in model output. Omit to scan all types. Use the same entity names as in spec.memory.hygiene.piiScrubFields.'),
  }),
  z.object({
    type: z.literal('custom'),
    module: z.string()
      .describe('Path to the module implementing the output guardrail. Use "$file:guardrails/output_check.py" syntax.'),
    function: z.string()
      .describe('Name of the guardrail function. Signature: (output: str) -> None (raise to block) or (output: str) -> str (return transformed value).'),
    action: z.enum(['reject', 'warn', 'log']),
  }),
])

const GuardrailsSchema = z.object({
  input: z.array(InputGuardrailSchema).optional()
    .describe('Guardrails applied to user input before it is sent to the model. Evaluated in order — first blocking rule wins.'),
  output: z.array(OutputGuardrailSchema).optional()
    .describe('Guardrails applied to model output before it is returned to the user. Evaluated in order — first blocking rule wins.'),
})

// ── Evaluation ────────────────────────────────────────────────────────────────
const EvalMetricEnum = z.enum([
  'faithfulness',        // RAG: does the answer only use information from the retrieved context?
  'answer_relevancy',    // Is the answer relevant to the question?
  'answer_similarity',   // Semantic similarity between actual and expected output (embedding-based).
  'hallucination',       // Does the answer contain claims not grounded in context or facts?
  'toxicity',            // Does the answer contain harmful, offensive, or unsafe content?
  'context_precision',   // RAG: are the retrieved chunks actually relevant to the question?
  'context_recall',      // RAG: do the retrieved chunks cover the ground-truth answer?
  'bias',                // Does the answer exhibit demographic or political bias?
  'custom',              // Custom scorer defined in the evaluation framework config.
])

const datasetPathDesc =
  'Path to the evaluation dataset file (JSONL format). ' +
  'Use "$file:evals/my_dataset.jsonl" syntax. ' +
  'Each line is a JSON object with the following fields:\n' +
  '  input            (required) – user query sent to the agent.\n' +
  '  expected         (required) – expected output; used for string_match and answer_similarity scoring.\n' +
  '  context          (optional) – string[] of retrieved chunks the agent actually used. ' +
                                   'Required for faithfulness, context_precision, hallucination metrics.\n' +
  '  reference_contexts (optional) – string[] of ground-truth relevant chunks. ' +
                                     'Required for context_recall metric.\n' +
  '  tags             (optional) – string[] labels for filtering with --tag.\n' +
  '  metadata         (optional) – arbitrary key/value pairs for reporting (e.g. {"difficulty": "hard"}).\n' +
  'Example: {"input":"What is RAG?","expected":"Retrieval Augmented Generation","context":["RAG combines retrieval..."],"tags":["rag"]}'

const EvaluationSchema = z.object({
  framework: z.enum(['deepeval', 'braintrust', 'langsmith', 'ragas', 'custom']),
  datasets: z
    .array(
      z.object({
        name: z.string()
          .describe('Unique dataset identifier, referenced by "agentspec evaluate --dataset <name>".'),
        path: refOrLiteral.describe(datasetPathDesc),
        metrics: z.array(EvalMetricEnum).optional()
          .describe(
            'Metrics to compute for this specific dataset. ' +
            'Overrides (narrows) spec.evaluation.metrics for this dataset only. ' +
            'When omitted, the global spec.evaluation.metrics list is used. ' +
            'Example: a RAG dataset sets ["faithfulness","context_recall"] while a safety dataset sets ["toxicity","bias"].'
          ),
      }),
    )
    .optional()
    .describe('Evaluation datasets. Each entry maps a name to a JSONL file and optionally scopes which metrics to compute.'),
  metrics: z
    .array(EvalMetricEnum)
    .optional()
    .describe(
      'Default metrics to compute across all datasets that do not declare their own metrics. ' +
      '"faithfulness", "context_precision", "context_recall" require the "context" field in dataset samples. ' +
      '"context_recall" additionally requires "reference_contexts". ' +
      '"custom" requires a scorer registered in the evaluation framework config.'
    ),
  thresholds: z.record(z.string(), z.number().min(0).max(1)).optional()
    .describe('Pass/fail thresholds per metric (0.0–1.0). Key = metric name, value = minimum required score. Example: {"faithfulness": 0.8, "answer_relevancy": 0.75}. Used by ciGate and "agentspec evaluate".'),
  ciGate: z.boolean().optional().default(false)
    .describe('When true, "agentspec evaluate" exits with code 1 if any metric falls below its threshold. Blocks CI pipelines on evaluation regression (EVAL-01).'),
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
      endpoint: refOrLiteral.optional()
        .describe('Tracing collector endpoint URL. Required for "otel", "honeycomb", and self-hosted backends. ' + refDesc),
      publicKey: refOrLiteral.optional()
        .describe('Public/project API key for the tracing backend (e.g. Langfuse public key). ' + refDesc),
      secretKey: refOrLiteral.optional()
        .describe('Secret API key for the tracing backend (e.g. Langfuse secret key). Always use "$secret:" or "$env:" — never hardcode. ' + refDesc),
      sampleRate: z.number().min(0).max(1).optional().default(1.0)
        .describe('Fraction of requests to trace (0.0–1.0). 1.0 = trace every request (default), 0.1 = trace 10% for high-traffic cost savings. Set to 1.0 during development.'),
    })
    .optional(),
  metrics: z
    .object({
      backend: z.enum(['opentelemetry', 'prometheus', 'datadog']),
      endpoint: refOrLiteral.optional()
        .describe('Metrics export endpoint (e.g. OTLP endpoint for OpenTelemetry, Datadog agent URL). ' + refDesc),
      serviceName: z.string().optional()
        .describe('Service name used to label all emitted metrics and traces. Defaults to metadata.name. Use a consistent name across deployments for accurate dashboards.'),
    })
    .optional(),
  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
      structured: z.boolean().optional().default(true)
        .describe('When true, logs are emitted as JSON objects (structured logging). Required for log aggregation platforms (Datadog, Splunk, CloudWatch). Set false only for local development readability.'),
      redactFields: z.array(z.string()).optional()
        .describe('Field names to redact from structured log output before writing to log sinks. Use the same values as spec.memory.hygiene.piiScrubFields plus any application-specific sensitive keys (e.g. ["password", "credit_card", "session_token"]).'),
    })
    .optional(),
})

// ── Compliance ────────────────────────────────────────────────────────────────
const ComplianceSuppressionSchema = z.object({
  rule: z.string()
    .describe('Rule ID to suppress (e.g. "SEC-LLM-03", "MEM-02"). Must match an existing compliance rule ID.'),
  reason: z.string()
    .describe('Human-readable justification for suppressing this rule. Required for audit trails. Example: "Hallucination detection handled by external Lakera Guard proxy."'),
  approvedBy: z.string().optional()
    .describe('Name or identifier of the person who approved this suppression (e.g. "security-team", "alice@example.com"). Used for compliance sign-off tracking.'),
  expires: z.string().optional()
    .describe('ISO 8601 date (YYYY-MM-DD) when this suppression expires and should be re-evaluated (e.g. "2025-12-31"). Suppressions without an expiry are flagged in audits.'),
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
        'metadata-quality',
      ]),
    )
    .optional()
    .describe('Compliance rule packs to evaluate during "agentspec audit". Each pack groups related rules. Omit to run all packs.'),
  suppressions: z.array(ComplianceSuppressionSchema).optional()
    .describe('Rules to suppress in audit output. Each suppression requires a reason and optional expiry date. Over-suppression is itself flagged.'),
  auditSchedule: z.enum(['daily', 'weekly', 'monthly', 'on-change']).optional()
    .describe('How often the compliance audit should be re-run in CI. "on-change" = re-audit on every manifest change (recommended). Informational — enforcement depends on your CI configuration.'),
})

// ── Runtime Requirements ──────────────────────────────────────────────────────
const RequiresSchema = z.object({
  envVars: z.array(z.string()).optional()
    .describe('Environment variable names that must be set at agent startup. The SDK validates these at load time and throws a descriptive error if any are missing (e.g. ["OPENAI_API_KEY", "DATABASE_URL"]).'),
  services: z
    .array(
      z.object({
        type: z.enum(['postgres', 'redis', 'mysql', 'mongodb', 'elasticsearch']),
        connection: refOrLiteral
          .describe('Connection URI for this service. ' + refDesc),
      }),
    )
    .optional()
    .describe('External services that must be reachable at startup. The SDK health check verifies TCP connectivity to each service.'),
  minimumMemoryMB: z.number().int().min(128).optional()
    .describe('Minimum RAM required to run the agent in megabytes (e.g. 512, 2048). Used by orchestrators for resource scheduling. Does not enforce a limit — purely declarative.'),
  nodeVersion: z.string().optional()
    .describe('Minimum Node.js version required, as a semver range or exact version (e.g. ">=20.0.0", "20.x"). Used by CI and orchestrators for compatibility checks.'),
  pythonVersion: z.string().optional()
    .describe('Minimum Python version required, as a semver range or exact version (e.g. ">=3.11", "3.12"). Used by CI and orchestrators for compatibility checks.'),
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
    .optional()
    .describe('Conditions that pause execution and request human approval. "before-destructive-tool" = any tool with destructiveHint=true, "on-low-confidence" = model confidence below a threshold, "on-high-cost" = single call exceeds cost controls.'),
  timeoutSeconds: z.number().int().min(1).max(3600).optional().default(300)
    .describe('Seconds to wait for human approval before executing the timeoutAction. Default 300s (5 minutes). Max 3600s (1 hour).'),
  timeoutAction: z.enum(['reject', 'proceed', 'escalate']).optional().default('reject')
    .describe('"reject" = abort the action and return an error (default, safest), "proceed" = continue without approval (use only for low-risk actions), "escalate" = forward to a higher-level approver or on-call channel.'),
  notifyVia: z
    .array(z.enum(['slack', 'email', 'webhook', 'console']))
    .optional()
    .describe('Channels used to notify humans when approval is required. Multiple channels can be specified; all are notified simultaneously.'),
  webhookUrl: refOrLiteral.optional()
    .describe('URL to POST approval requests to when notifyVia includes "webhook". The payload contains the pending action and a callback token. ' + refDesc),
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
