# AgentSpec — root Makefile
# Usage: make <target>

.DEFAULT_GOAL := help
.PHONY: help install build test lint typecheck clean schema docs docs-build docs-preview

# ── Colours ───────────────────────────────────────────────────────────────────
BOLD  := \033[1m
RESET := \033[0m
CYAN  := \033[36m
GREEN := \033[32m

# ── Help ──────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@printf "  $(BOLD)$(CYAN)AgentSpec$(RESET) — available targets\n"
	@echo ""
	@printf "  $(BOLD)Dev$(RESET)\n"
	@printf "    $(GREEN)install$(RESET)        Install all workspace dependencies\n"
	@printf "    $(GREEN)build$(RESET)          Build all packages (sdk, cli, adapters)\n"
	@printf "    $(GREEN)test$(RESET)           Run all tests across the workspace\n"
	@printf "    $(GREEN)lint$(RESET)           Lint all packages\n"
	@printf "    $(GREEN)typecheck$(RESET)      Type-check all packages\n"
	@printf "    $(GREEN)clean$(RESET)          Remove all build artefacts\n"
	@echo ""
	@printf "  $(BOLD)Packages$(RESET)\n"
	@printf "    $(GREEN)build-sdk$(RESET)      Build @agentspec/sdk only\n"
	@printf "    $(GREEN)build-cli$(RESET)      Build @agentspec/cli only\n"
	@printf "    $(GREEN)test-sdk$(RESET)       Test @agentspec/sdk only\n"
	@printf "    $(GREEN)test-cli$(RESET)       Test @agentspec/cli only\n"
	@printf "    $(GREEN)schema$(RESET)         Generate schemas/v1/agent.schema.json\n"
	@echo ""
	@printf "  $(BOLD)Docs$(RESET)\n"
	@printf "    $(GREEN)docs$(RESET)           Start the VitePress dev server (hot-reload)\n"
	@printf "    $(GREEN)docs-build$(RESET)     Build the static doc site to docs/.vitepress/dist\n"
	@printf "    $(GREEN)docs-preview$(RESET)   Preview the built doc site locally\n"
	@echo ""

# ── Install ───────────────────────────────────────────────────────────────────
install:
	pnpm install

# ── Build ─────────────────────────────────────────────────────────────────────
build:
	pnpm -r build

build-sdk:
	pnpm --filter @agentspec/sdk build

build-cli:
	pnpm --filter @agentspec/cli build

# ── Test ──────────────────────────────────────────────────────────────────────
test:
	pnpm -r test

test-sdk:
	pnpm --filter @agentspec/sdk test

test-cli:
	pnpm --filter @agentspec/cli test

# ── Lint / Typecheck ──────────────────────────────────────────────────────────
lint:
	pnpm -r lint

typecheck:
	pnpm -r typecheck

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	pnpm -r clean

# ── Schema export ─────────────────────────────────────────────────────────────
schema:
	pnpm schema:export

# ── Docs (VitePress) ──────────────────────────────────────────────────────────
# Ensure VitePress is available, then serve / build the docs/ folder.

docs:
	pnpm exec vitepress dev docs

docs-build:
	pnpm exec vitepress build docs

docs-preview:
	pnpm exec vitepress preview docs
