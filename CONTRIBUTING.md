# Contributing to AgentSpec

Thank you for your interest in contributing to AgentSpec!

---

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+

### Getting started

```bash
git clone https://github.com/agents-oss/agentspec.git
cd agentspec
pnpm install
pnpm build
pnpm test
```

All tests should pass before you start making changes.

---

## Branch Naming

| Pattern | Use for |
|---------|---------|
| `feat/<short-description>` | New features |
| `fix/<short-description>` | Bug fixes |
| `docs/<short-description>` | Documentation only |
| `chore/<short-description>` | Tooling, deps, CI |

---

## Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add CrewAI adapter
fix: resolve $secret: references on Azure
docs: update LangGraph adapter guide
chore: bump Zod to 3.24
```

---

## Pull Request Checklist

Before opening a PR, verify:

- [ ] `pnpm test` passes (all packages)
- [ ] `pnpm typecheck` passes (zero errors)
- [ ] `pnpm lint` passes (zero errors)
- [ ] PR description explains **why** the change is needed, not just what changed
- [ ] New features have tests written first (TDD — see below)

---

## Test-Driven Development

Write tests **before** implementation. The order is:

1. Write a failing test in `src/__tests__/`
2. Implement the minimum code to pass it
3. Refactor

Run tests for a specific package:

```bash
pnpm --filter @agentspec/sdk test
pnpm --filter @agentspec/cli test
pnpm --filter @agentspec/adapter-langgraph test
```

---

## Adding a Compliance Rule

Compliance rules live in `packages/sdk/src/audit/rules/`. Each rule file maps to a compliance pack:

| File | Pack |
|------|------|
| `security.rules.ts` | `owasp-llm-top10` |
| `model.rules.ts` | `model-resilience` |
| `memory.rules.ts` | `memory-hygiene` |
| `evaluation.rules.ts` | `evaluation-coverage` |

To add a rule:

1. Open the relevant rules file
2. Implement the `AuditRule` interface:
   ```typescript
   const myRule: AuditRule = {
     id: 'SEC-LLM-XX',
     title: 'Short title',
     pack: 'owasp-llm-top10',
     severity: 'high',
     check(manifest) {
       // return undefined if passes, or { message, recommendation } if fails
     },
   }
   ```
3. Add it to the exported rules array in the same file
4. Write a test in `packages/sdk/src/__tests__/audit.test.ts`

---

## Adding a Framework Adapter

Each framework adapter is a separate package (e.g. `@agentspec/adapter-crewai`).

1. Create `packages/adapter-<framework>/`
2. Implement the `FrameworkAdapter` interface from `@agentspec/sdk`:
   ```typescript
   import { registerAdapter, type FrameworkAdapter } from '@agentspec/sdk'

   const myAdapter: FrameworkAdapter = {
     framework: 'my-framework',
     version: '0.1.0',
     generate(manifest, options) {
       return {
         framework: 'my-framework',
         files: { 'agent.py': '...', 'requirements.txt': '...' },
         installCommands: ['pip install -r requirements.txt'],
         envVars: [],
         readme: '...',
       }
     },
   }

   registerAdapter(myAdapter)
   export { myAdapter }
   ```
3. Call `registerAdapter(adapter)` at module load (side-effect import pattern)
4. Follow the same structure as `packages/adapter-langgraph/`
5. See `packages/sdk/CLAUDE.md` for detailed field mapping guidance

---

## Generating the JSON Schema

After modifying `packages/sdk/src/schema/manifest.schema.ts`, regenerate the IDE autocomplete schema:

```bash
pnpm schema:export
# or
make schema
```

Commit the updated `schemas/v1/agent.schema.json`.

---

## Questions?

Open a [GitHub Discussion](https://github.com/agents-oss/agentspec/discussions) or file an issue.
