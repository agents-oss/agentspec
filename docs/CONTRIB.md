# Contributing to AgentSpec

Get the repository compiling and all tests passing, then follow the conventions below.

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`npm i -g pnpm`)

## Setup

```bash
git clone https://github.com/agents-oss/agentspec.git
cd agentspec
pnpm install
pnpm build
pnpm test        # all tests must pass before you start
```

## Scripts

### Root (runs across all packages)

| Command | What it does |
|---------|--------------|
| `pnpm build` | Build all packages (`sdk` → `adapter-claude` → `cli`, `sidecar`) |
| `pnpm test` | Run all unit/integration tests |
| `pnpm lint` | TypeScript type-check all packages |
| `pnpm typecheck` | TypeScript type-check all packages (alias of lint) |
| `pnpm clean` | Remove all `dist/` artefacts |
| `pnpm schema:export` | Re-generate `schemas/v1/agent.schema.json` from Zod schema |

### Make shortcuts

```bash
make install      # pnpm install
make build        # build all packages
make test         # run all tests
make lint         # type-check all packages
make typecheck    # same as lint
make clean        # remove build artefacts
make build-sdk    # build @agentspec/sdk only
make build-cli    # build @agentspec/cli only
make test-sdk     # test @agentspec/sdk only
make test-cli     # test @agentspec/cli only
make schema       # regenerate schemas/v1/agent.schema.json
make docs         # start VitePress dev server (hot-reload)
make docs-build   # build static doc site → docs/.vitepress/dist
make docs-preview # preview built site locally
```

### Per-package

```bash
pnpm --filter @agentspec/sdk          test
pnpm --filter @agentspec/cli          test
pnpm --filter @agentspec/adapter-claude test
pnpm --filter @agentspec/sidecar      test

# Sidecar — unit/integration + E2E (needs Docker)
pnpm --filter @agentspec/sidecar      test:e2e
pnpm --filter @agentspec/sidecar      test:all

# Watch mode (one package at a time)
pnpm --filter @agentspec/sdk dev
```

## Environment Variables for Local Development

When running `agentspec generate` locally:

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Yes (for generate/helm) | — | Claude API key |
| `ANTHROPIC_MODEL` | No | `claude-opus-4-6` | Override model |
| `ANTHROPIC_BASE_URL` | No | Anthropic API | Custom proxy endpoint |

When running the sidecar locally (or in tests):

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `UPSTREAM_URL` | Yes | `http://localhost:8000` | Agent's HTTP URL |
| `MANIFEST_PATH` | No | `/manifest/agent.yaml` | Path to agent.yaml inside container |
| `PROXY_PORT` | No | `4000` | Sidecar proxy listen port |
| `CONTROL_PLANE_PORT` | No | `4001` | Control plane listen port |
| `ANTHROPIC_API_KEY` | No | — | Required only for `/gap` LLM analysis |
| `AUDIT_RING_SIZE` | No | `1000` | Number of audit ring entries to keep |

## Package Architecture

```
agentspec/
├── packages/
│   ├── sdk/              @agentspec/sdk        — manifest schema, health checks, audit rules
│   ├── adapter-claude/   @agentspec/adapter-claude — LLM code generation via Claude API
│   ├── cli/              @agentspec/cli        — agentspec CLI binary
│   └── sidecar/          @agentspec/sidecar    — Fastify proxy + control plane
├── docs/                 VitePress docs site
├── schemas/v1/           JSON Schema (generated, do not hand-edit)
└── Makefile              Top-level convenience targets
```

**Build order matters:** `sdk` must be built before `adapter-claude` and `cli`, because they depend on it as workspace packages.

## Adapter Build Note

`@agentspec/adapter-claude` build script copies skill Markdown files to `dist/skills/`:
```bash
tsup && mkdir -p dist/skills && cp src/skills/*.md dist/skills/
```
If you add a new skill file, ensure it ends in `.md` and is placed in `src/skills/`. It is auto-discovered by `listFrameworks()` at runtime.

## Branch and Commit Conventions

| Branch pattern | Use for |
|----------------|---------|
| `feat/<description>` | New features |
| `fix/<description>` | Bug fixes |
| `docs/<description>` | Documentation only |
| `chore/<description>` | Tooling, deps, CI |

Commits use [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: add --deploy helm flag
fix: resolve $env: refs in model.check before probing
docs: update cli.md with --deploy usage
chore: bump @anthropic-ai/sdk to 0.40
```

## PR Checklist

- [ ] `pnpm test` — all tests pass
- [ ] `pnpm typecheck` — zero type errors
- [ ] New code has tests written first (TDD: RED → GREEN → REFACTOR)
- [ ] Docs updated if a user-visible behaviour changed
- [ ] `pnpm schema:export` run and `schemas/v1/agent.schema.json` committed if schema changed

## See Also

- [CONTRIBUTING.md](../CONTRIBUTING.md) — root-level contribution guide
- [CLI Reference](./reference/cli.md)
- [docs/CLAUDE.md](./CLAUDE.md) — documentation writing standards
