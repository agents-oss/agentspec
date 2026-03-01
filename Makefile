# AgentSpec — root Makefile
# Usage: make <target>

.DEFAULT_GOAL := help
.PHONY: help install build test lint typecheck clean schema docs docs-build docs-preview
.PHONY: demo demo-cluster demo-operator demo-deploy demo-verify demo-status demo-logs demo-down

# ── Demo cluster config ────────────────────────────────────────────────────────
DEMO_CLUSTER   := agentspec
DEMO_OP_NS     := agentspec-system
DEMO_AGENT_NS  := demo
OPERATOR_IMAGE := agentspec/operator:dev

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
	@printf "  $(BOLD)Demo (requires kind + helm + docker)$(RESET)\n"
	@printf "    $(GREEN)demo$(RESET)           Full demo: kind cluster + operator + agents + verify\n"
	@printf "    $(GREEN)demo-cluster$(RESET)   Create the kind cluster (idempotent)\n"
	@printf "    $(GREEN)demo-operator$(RESET)  Build + load operator image, deploy via Helm\n"
	@printf "    $(GREEN)demo-deploy$(RESET)    Apply demo agents (gymcoach / trading-bot / voice-assistant)\n"
	@printf "    $(GREEN)demo-verify$(RESET)    Run the UAT verify script\n"
	@printf "    $(GREEN)demo-status$(RESET)    Show live AgentObservation phase/grade/score table\n"
	@printf "    $(GREEN)demo-logs$(RESET)      Tail the operator logs\n"
	@printf "    $(GREEN)demo-down$(RESET)      Delete the kind cluster\n"
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

# ── Demo (kind cluster UAT) ───────────────────────────────────────────────────
#
# Full end-to-end demo: creates a local kind cluster, builds and loads the
# operator image, deploys the operator via Helm, applies the three demo agents
# (gymcoach / trading-bot / voice-assistant), and runs the verify script.
#
# Expected result:
#   gymcoach       Healthy   A  score=100  violations=0
#   trading-bot    Degraded  D  score=55   violations=4
#   voice-assistant Unhealthy C  score=60   violations=3
#
# Prerequisites: kind, helm, docker, kubectl (all in PATH)
#
# Usage:
#   make demo           # full setup + verify
#   make demo-status    # check live status (cluster must already be running)
#   make demo-down      # tear down the cluster

## Create (or reuse) the kind cluster
demo-cluster:
	@if kind get clusters 2>/dev/null | grep -q "^$(DEMO_CLUSTER)$$"; then \
	  printf "  $(CYAN)cluster$(RESET)   '$(DEMO_CLUSTER)' already exists — skipping create\n"; \
	else \
	  printf "  $(BOLD)Creating kind cluster '$(DEMO_CLUSTER)' (k8s v1.31.4)...$(RESET)\n"; \
	  kind create cluster --name $(DEMO_CLUSTER) \
	    --config packages/operator/uat/kind-cluster.yaml; \
	fi

## Build operator image + load into kind + deploy via Helm
demo-operator: demo-cluster
	@printf "\n  $(BOLD)Building operator image $(OPERATOR_IMAGE)...$(RESET)\n"
	docker build -t $(OPERATOR_IMAGE) packages/operator
	@printf "  $(BOLD)Loading image into kind cluster '$(DEMO_CLUSTER)'...$(RESET)\n"
	kind load docker-image $(OPERATOR_IMAGE) --name $(DEMO_CLUSTER)
	@printf "  $(BOLD)Deploying operator via Helm...$(RESET)\n"
	helm upgrade --install agentspec-operator \
	  packages/operator/helm/agentspec-operator \
	  --namespace $(DEMO_OP_NS) --create-namespace \
	  --set operator.image.repository=agentspec/operator \
	  --set operator.image.tag=dev \
	  --set operator.image.pullPolicy=Never \
	  --wait --timeout=120s

## Deploy the three demo agent pods + AgentObservation CRs
demo-deploy:
	@printf "\n  $(BOLD)Deploying demo agents...$(RESET)\n"
	kubectl apply -k packages/operator/demo/
	@printf "  $(BOLD)Waiting for pods to be ready...$(RESET)\n"
	kubectl rollout status \
	  deployment/gymcoach deployment/trading-bot deployment/voice-assistant \
	  -n $(DEMO_AGENT_NS) --timeout=120s

## Run the UAT verify script
demo-verify:
	@bash packages/operator/uat/verify.sh \
	  --namespace $(DEMO_OP_NS) \
	  --demo-namespace $(DEMO_AGENT_NS)

## Full demo: cluster + operator + agents + verify
demo: demo-cluster demo-operator demo-deploy demo-verify
	@echo ""
	@printf "  $(BOLD)$(GREEN)Demo is live!$(RESET)\n"
	@printf "  Run '$(CYAN)make demo-status$(RESET)' to watch agent health.\n"
	@printf "  Run '$(CYAN)make demo-down$(RESET)'   to tear down the cluster.\n"
	@echo ""

## Show live AgentObservation status table
demo-status:
	@echo ""
	@printf "  $(BOLD)AgentObservations — cluster: $(DEMO_CLUSTER) / namespace: $(DEMO_AGENT_NS)$(RESET)\n"
	@echo ""
	@kubectl get agentobservations -n $(DEMO_AGENT_NS) \
	  -o custom-columns="NAME:.metadata.name,PHASE:.status.phase,GRADE:.status.grade,SCORE:.status.score,VIOLATIONS:.status.violations,SOURCE:.status.source" 2>&1 \
	  | sed 's/^/  /' \
	  || printf "  $(RED)Could not reach cluster — is it running? (kind get clusters)$(RESET)\n"
	@echo ""

## Tail the operator logs (Ctrl-C to stop)
demo-logs:
	kubectl logs -n $(DEMO_OP_NS) deploy/agentspec-operator -f

## Delete the kind cluster and all demo resources
demo-down:
	@printf "  $(BOLD)Deleting kind cluster '$(DEMO_CLUSTER)'...$(RESET)\n"
	kind delete cluster --name $(DEMO_CLUSTER)
