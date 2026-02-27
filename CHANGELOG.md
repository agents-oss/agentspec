# Changelog

All notable changes to AgentSpec are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [0.1.0] - 2026-02-27

### Added

- `@agentspec/sdk` — core: `loadManifest`, `runHealthCheck`, `runAudit`, `generateAdapter`, `registerAdapter`
- `@agentspec/cli` — `agentspec validate | health | audit | init | generate | migrate | export`
- `@agentspec/adapter-langgraph` — generates LangGraph Python agent code from `agent.yaml`
- Zod-based manifest schema (`agentspec.io/v1`) as single source of truth
- Compliance packs: `owasp-llm-top10`, `model-resilience`, `memory-hygiene`, `evaluation-coverage`
- Health check engine: env, model, MCP, memory, secret checks
- Schema migration: `agentspec/v1alpha1` → `agentspec.io/v1`
- `$env:`, `$secret:`, `$file:`, `$func:` reference resolvers
- `schemas/v1/agent.schema.json` for IDE autocomplete
- CI/CD pipeline with OIDC Trusted Publishing (no static npm tokens)
- 88 tests across all packages
