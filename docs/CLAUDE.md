# CLAUDE.md — Documentation Standards

This file governs how documentation is written for the AgentSpec project.

---

## Documentation Principles

1. **Docs are code** — every doc must be accurate and tested against the actual implementation
2. **User-first** — lead with what the user can do, not how the system works internally
3. **Progressive disclosure** — Quick Start → Concepts → Reference, never the reverse
4. **Show, don't tell** — prefer code examples over prose
5. **Every page answers one question** — if a page answers two questions, split it

---

## Page Structure Template

```markdown
# Page Title (imperative: "Configure Memory", not "Memory Configuration")

One-sentence summary of what this page helps you accomplish.

## Overview (optional, 2-3 sentences max)

## Prerequisites

- [ ] Thing the user must have done first

## Step-by-step

### 1. First step

```yaml
# code example
```

### 2. Second step

## Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|

## See also

- [Related page](./related.md)
```

---

## Writing Style

- Use active voice: "Add a tool" not "A tool can be added"
- Use present tense: "AgentSpec validates" not "AgentSpec will validate"
- Code samples must be copy-pasteable and work without modification
- Every `agent.yaml` example must be valid against the schema
- Avoid jargon — if you must use it, link to the glossary

---

## File Organization

```
docs/
├── index.md              # Home / project overview
├── quick-start.md        # Get up and running in 5 minutes
├── concepts/
│   ├── manifest.md       # What is agent.yaml?
│   ├── health-checks.md  # Runtime health checks
│   ├── compliance.md     # Compliance packs and scoring
│   └── adapters.md       # Framework adapters
├── guides/
│   ├── migrate-budgetbud.md
│   ├── add-memory.md
│   ├── add-guardrails.md
│   └── ci-integration.md
├── reference/
│   ├── manifest-schema.md # Full field reference
│   ├── cli.md             # CLI commands reference
│   └── health-checks.md   # All check categories
└── adapters/
    ├── langgraph.md
    ├── crewai.md
    └── mastra.md
```

---

## When Adding a New Feature

1. Update `docs/reference/manifest-schema.md` with new fields
2. Add an example to the relevant concept doc
3. Update `docs/quick-start.md` if the feature is commonly used
4. Add a guide in `docs/guides/` if the feature needs walkthrough
