/**
 * @agentspec/sdk — Universal Agent Manifest System
 *
 * Core public API:
 *   - loadManifest()     — parse + validate agent.yaml
 *   - runHealthCheck()   — runtime dependency checks
 *   - runAudit()         — compliance scoring
 *   - generateAdapter()  — framework code generation
 *   - registerAdapter()  — register a framework adapter
 */

// Schema + types
export {
  ManifestSchema,
  type AgentSpecManifest,
  type AgentSpecMetadata,
  type AgentSpecModel,
  type AgentSpecPrompts,
  type AgentSpecTool,
  type AgentSpecMcpServer,
  type AgentSpecMemory,
  type AgentSpecGuardrails,
  type AgentSpecHumanInTheLoop,
  type AgentSpecChatEndpoint,
  type AgentSpecEvaluation,
  type AgentSpecObservability,
  type AgentSpecCompliance,
  type AgentSpecRequires,
} from './schema/manifest.schema.js'

export { exportJsonSchema } from './schema/json-schema.js'

// Loader
export {
  loadManifest,
  tryLoadManifest,
  type ParsedManifest,
  type LoadOptions,
} from './loader/index.js'

export {
  resolveRef,
  resolveRefs,
  collectEnvRefs,
  collectFileRefs,
  detectRefType,
  type ResolverOptions,
  type RefType,
  type SecretBackend,
} from './loader/resolvers.js'

export {
  migrateManifest,
  detectVersion,
  isLatestVersion,
  LATEST_API_VERSION,
  type Migration,
} from './loader/migrations/index.js'

// Health check
export {
  runHealthCheck,
  type HealthReport,
  type HealthCheck,
  type HealthStatus,
  type CheckStatus,
  type CheckSeverity,
  type HealthCheckOptions,
} from './health/index.js'

// Audit
export {
  runAudit,
  type AuditReport,
  type AuditViolation,
  type AuditRule,
  type AuditOptions,
  type RuleResult,
  type RuleSeverity,
  type CompliancePack,
  type SuppressionRecord,
} from './audit/index.js'

// Generate
export {
  generateAdapter,
  registerAdapter,
  getAdapter,
  listAdapters,
  type GeneratedAgent,
  type FrameworkAdapter,
} from './generate/index.js'
