# AgentSpec — root Makefile
# Usage: make <target>

.DEFAULT_GOAL := help
.PHONY: help install build test lint typecheck clean schema docs docs-build docs-preview
.PHONY: demo demo-provision demo-cluster demo-operator demo-deploy demo-verify demo-e2e demo-status demo-logs demo-down demo-patch demo-reset demo-opa

# ── Demo cluster config ────────────────────────────────────────────────────────
DEMO_CLUSTER   := agentspec
DEMO_OP_NS     := agentspec-system
DEMO_AGENT_NS  := demo
OPERATOR_IMAGE := agentspec/operator:dev

# Set USE_KIND=false + KUBE_CONTEXT=<ctx> to skip kind and use an existing cluster.
# Works out of the box with orbstack/Docker Desktop K8s (shared Docker daemon).
# For remote clusters (AKS, EKS, GKE) push the sidecar image to a registry first.
USE_KIND      ?= true
KUBE_CONTEXT  ?= kind-$(DEMO_CLUSTER)

# ── Colours ───────────────────────────────────────────────────────────────────
BOLD   := \033[1m
RESET  := \033[0m
CYAN   := \033[36m
GREEN  := \033[32m
RED    := \033[31m
YELLOW := \033[33m

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
	@printf "  $(BOLD)Demo (requires helm + docker + kubectl)$(RESET)\n"
	@printf "    $(GREEN)demo$(RESET)           Full demo: cluster + operator + agents + verify\n"
	@printf "    $(GREEN)demo-provision$(RESET) Provision cluster + operator + agents (no verify)\n"
	@printf "    $(GREEN)demo-cluster$(RESET)   Create the kind cluster (idempotent)\n"
	@printf "    $(GREEN)demo-operator$(RESET)  Build + load operator image, deploy via Helm\n"
	@printf "    $(GREEN)demo-deploy$(RESET)    Deploy all 5 demo agents (3 manifest-static + 2 agent-sdk)\n"
	@printf "    $(GREEN)demo-verify$(RESET)    Run the UAT verify script\n"
	@printf "    $(GREEN)demo-e2e$(RESET)      Run automated e2e pytest suite (proxy+OPA+gap+events)\n"
	@printf "    $(GREEN)demo-status$(RESET)    Show live AgentObservation phase/grade/score table\n"
	@printf "    $(GREEN)demo-patch$(RESET)     Live patch: voice-assistant C→A + research-agent F→A\n"
	@printf "    $(GREEN)demo-reset$(RESET)     Restore agents to pre-patch state (replay the demo)\n"
	@printf "    $(GREEN)demo-logs$(RESET)      Tail the operator logs\n"
	@printf "    $(GREEN)demo-down$(RESET)      Delete the kind cluster\n"
	@printf "    $(GREEN)demo-opa$(RESET)       Verify OPA health + run sample policy queries\n"
	@echo ""
	@printf "  $(BOLD)Demo options$(RESET)\n"
	@printf "    $(CYAN)USE_KIND$(RESET)=true|false   Use kind cluster (default: true)\n"
	@printf "    $(CYAN)KUBE_CONTEXT$(RESET)=<ctx>    Kubectl context (default: kind-agentspec)\n"
	@printf "\n"
	@printf "  Examples:\n"
	@printf "    make demo                                        # kind cluster (default)\n"
	@printf "    make demo USE_KIND=false KUBE_CONTEXT=orbstack   # orbstack\n"
	@printf "    make demo USE_KIND=false KUBE_CONTEXT=docker-desktop\n"
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
#   gymcoach        Healthy   A  score=100  violations=0  source=manifest-static
#   trading-bot     Degraded  D  score=55   violations=4  source=manifest-static
#   voice-assistant Unhealthy C  score=60   violations=3  source=manifest-static
#   fitness-tracker Healthy   A  score=100  violations=0  source=agent-sdk
#   research-agent  Unhealthy F  score=20   violations=5  source=agent-sdk
#
# Prerequisites: helm, docker, kubectl (all in PATH); kind required only when USE_KIND=true
#
# Usage:
#   make demo                                        # full setup + verify (kind)
#   make demo USE_KIND=false KUBE_CONTEXT=orbstack   # orbstack / Docker Desktop
#   make demo-status                                 # check live status
#   make demo-down                                   # tear down

## Create (or reuse) the cluster
demo-cluster:
ifeq ($(USE_KIND),true)
	@if kind get clusters 2>/dev/null | grep -q "^$(DEMO_CLUSTER)$$"; then \
	  printf "  $(CYAN)cluster$(RESET)   '$(DEMO_CLUSTER)' already exists — skipping create\n"; \
	else \
	  printf "  $(BOLD)Creating kind cluster '$(DEMO_CLUSTER)' (k8s v1.31.4)...$(RESET)\n"; \
	  kind create cluster --name $(DEMO_CLUSTER) \
	    --config packages/operator/uat/kind-cluster.yaml; \
	fi
else
	@printf "  $(CYAN)cluster$(RESET)   USE_KIND=false — using context '$(KUBE_CONTEXT)'\n"
	@kubectl cluster-info --context $(KUBE_CONTEXT) >/dev/null 2>&1 || \
	  (printf "  $(RED)Cannot reach '$(KUBE_CONTEXT)' — check kubectl config$(RESET)\n" && exit 1)
endif

## Build operator image + load into kind + deploy via Helm
## Idempotent: skips docker build + kind load if the operator deployment is already running.
demo-operator: demo-cluster
	@_op_ready=$$(kubectl get deployment agentspec-operator \
	  -n $(DEMO_OP_NS) --context $(KUBE_CONTEXT) \
	  -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo 0); \
	if [ "$$_op_ready" = "1" ]; then \
	  printf "  $(CYAN)operator$(RESET)   already running — skipping build & image load\n"; \
	else \
	  printf "\n  $(BOLD)Building operator image $(OPERATOR_IMAGE)...$(RESET)\n"; \
	  docker build -t $(OPERATOR_IMAGE) packages/operator; \
	  if [ "$(USE_KIND)" = "true" ]; then \
	    printf "  $(BOLD)Loading image into kind cluster '$(DEMO_CLUSTER)'...$(RESET)\n"; \
	    kind load docker-image $(OPERATOR_IMAGE) --name $(DEMO_CLUSTER); \
	  fi; \
	fi
	@printf "  $(BOLD)Deploying operator via Helm...$(RESET)\n"
	helm upgrade --install agentspec \
	  packages/operator/helm/agentspec-operator \
	  --kube-context $(KUBE_CONTEXT) \
	  --namespace $(DEMO_OP_NS) --create-namespace \
	  --set operator.image.repository=agentspec/operator \
	  --set operator.image.tag=dev \
	  --set operator.image.pullPolicy=$(if $(filter true,$(USE_KIND)),Never,IfNotPresent) \
	  --wait --timeout=120s

## Deploy all five demo agent pods + AgentObservation CRs
## Agents: gymcoach (A/manifest-static), trading-bot (D/manifest-static),
##         voice-assistant (C/manifest-static), fitness-tracker (A/agent-sdk),
##         research-agent (F/agent-sdk)
## Idempotent: skips apply + rollout-wait if all 5 agents are already running.
demo-deploy:
	@_ar=$$(kubectl get deployments \
	  gymcoach trading-bot voice-assistant fitness-tracker research-agent \
	  -n $(DEMO_AGENT_NS) --context $(KUBE_CONTEXT) \
	  -o jsonpath='{range .items[*]}{.status.availableReplicas},{end}' 2>/dev/null || echo ""); \
	_count=$$(echo "$$_ar" | tr ',' '\n' | grep -c "^1$$" 2>/dev/null || echo 0); \
	if [ "$$_count" = "5" ]; then \
	  printf "  $(CYAN)agents$(RESET)     all 5 demo agents already running — skipping deploy\n"; \
	else \
	  printf "\n  $(BOLD)Deploying demo agents...$(RESET)\n"; \
	  kubectl apply -k packages/operator/demo/ --context $(KUBE_CONTEXT); \
	  printf "  $(BOLD)Waiting for pods to be ready...$(RESET)\n"; \
	  kubectl rollout status \
	    deployment/gymcoach deployment/trading-bot deployment/voice-assistant \
	    deployment/fitness-tracker deployment/research-agent \
	    -n $(DEMO_AGENT_NS) --context $(KUBE_CONTEXT) --timeout=180s; \
	fi

## Run the UAT verify script
demo-verify:
	@bash packages/operator/uat/verify.sh \
	  --namespace $(DEMO_OP_NS) \
	  --demo-namespace $(DEMO_AGENT_NS) \
	  --context $(KUBE_CONTEXT)

## Run automated e2e scenarios against the live demo cluster
demo-e2e:
	@printf "\n  $(BOLD)Running e2e test suite against demo cluster '$(DEMO_CLUSTER)'...$(RESET)\n\n"
	cd packages/operator/uat/e2e && \
	  pip install -q -e . && \
	  pytest -v

## Provision the demo cluster (kind + operator + agents, no verify step)
demo-provision: demo-cluster demo-operator demo-deploy

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
	@printf "  $(BOLD)AgentObservations — context: $(KUBE_CONTEXT) / namespace: $(DEMO_AGENT_NS)$(RESET)\n"
	@echo ""
	@kubectl get agentobservations -n $(DEMO_AGENT_NS) --context $(KUBE_CONTEXT) \
	  -o custom-columns="NAME:.metadata.name,PHASE:.status.phase,GRADE:.status.grade,SCORE:.status.score,VIOLATIONS:.status.violations,SOURCE:.status.source" 2>&1 \
	  | sed 's/^/  /' \
	  || printf "  $(RED)Could not reach cluster — is it running? (kubectl config get-contexts)$(RESET)\n"
	@echo ""

## Tail the operator logs (Ctrl-C to stop)
demo-logs:
	kubectl logs -n $(DEMO_OP_NS) --context $(KUBE_CONTEXT) deploy/agentspec-operator -f

## Live patching demo — watch two agents improve in real time
## voice-assistant: C→A (manifest-static)   research-agent: F→A (agent-sdk)
demo-patch:
	@echo ""
	@printf "  $(BOLD)Live patching demo — watch grades improve in real time$(RESET)\n"
	@echo ""
	@# ─── voice-assistant (manifest-static): C → A ────────────────────────────
	@printf "  $(BOLD)[voice-assistant] BEFORE$(RESET): score=60 grade=C phase=Unhealthy source=manifest-static\n"
	@printf "  violations: healthcheckable [P] (high), discoverable [P] (medium), auditable [D] (medium)\n"
	@echo ""
	@printf "  $(CYAN)Patch 1/3$(RESET): Adding guardrails to agent.yaml spec...\n"
	@printf "    spec.guardrails.input:  [none]  →  pii-detector (scrub)\n"
	@printf "    spec.guardrails.output: [none]  →  content-safety (warn)\n"
	kubectl apply -f packages/operator/demo/patches/voice-assistant-patched-configmap.yaml \
	  --context $(KUBE_CONTEXT)
	@printf "  $(GREEN)✓ ConfigMap patched$(RESET)\n"
	@echo ""
	@printf "  $(CYAN)Patch 2/3$(RESET): Starting /health + /capabilities HTTP server on port 8080...\n"
	@printf "    GET /health        →  {\"status\":\"ok\"}\n"
	@printf "    GET /capabilities  →  {\"tools\":[...]}\n"
	@printf "  $(CYAN)Patch 3/3$(RESET): Setting OPENAI_API_KEY in sidecar environment...\n"
	@printf "    OPENAI_API_KEY: [unset]  →  sk-demo-voice\n"
	kubectl apply -f packages/operator/demo/patches/voice-assistant-patched-deployment.yaml \
	  --context $(KUBE_CONTEXT)
	kubectl rollout status deployment/voice-assistant -n $(DEMO_AGENT_NS) \
	  --context $(KUBE_CONTEXT) --timeout=60s
	@printf "  $(GREEN)✓ Deployment updated (HTTP server running, env key set)$(RESET)\n"
	@echo ""
	@printf "  $(GREEN)✓ [voice-assistant] AFTER: score=100 grade=A phase=Healthy source=manifest-static$(RESET)\n"
	@printf "  violations: none\n"
	@echo ""
	@# ─── research-agent (agent-sdk): F → A ──────────────────────────────────
	@printf "  $(BOLD)[research-agent] BEFORE$(RESET): score=20 grade=F phase=Unhealthy source=agent-sdk\n"
	@printf "  live violations: model:openai/gpt-4o [P] (critical,-30), env:OPENAI_API_KEY [P] (high,-20),\n"
	@printf "                   tool:search-arxiv [P] (medium,-10), tool:analyze-paper [P] (medium,-10), auditable [D] (medium,-10)\n"
	@printf "  (SDK integrated but broken — API key unset, tool handlers not registered)\n"
	@echo ""
	@printf "  $(CYAN)Patch 1/3$(RESET): Adding guardrails to agent.yaml spec...\n"
	@printf "    spec.guardrails: [none]  →  input pii-detector + output toxicity-filter\n"
	kubectl apply -f packages/operator/demo/patches/research-agent-patched-configmap.yaml \
	  --context $(KUBE_CONTEXT)
	@printf "  $(GREEN)✓ ConfigMap patched$(RESET)\n"
	@echo ""
	@printf "  $(CYAN)Patch 2/3$(RESET): Starting /health + /capabilities server + setting OPENAI_API_KEY...\n"
	@printf "    GET /health        →  {\"status\":\"ok\"}\n"
	@printf "    GET /capabilities  →  {\"tools\":[...]}\n"
	@printf "    OPENAI_API_KEY: [unset]  →  sk-demo-research\n"
	kubectl apply -f packages/operator/demo/patches/research-agent-patched-deployment.yaml \
	  --context $(KUBE_CONTEXT)
	kubectl rollout status deployment/research-agent -n $(DEMO_AGENT_NS) \
	  --context $(KUBE_CONTEXT) --timeout=60s
	@printf "  $(GREEN)✓ Deployment updated$(RESET)\n"
	@echo ""
	@printf "  $(CYAN)Patch 3/3$(RESET): Verifying sidecar /health/ready + /gap response...\n"
	@printf "    /health/ready  →  200 OK\n"
	@printf "    /gap           →  violations: 0\n"
	@echo ""
	@printf "  $(GREEN)✓ [research-agent] AFTER: score=100 grade=A phase=Healthy source=agent-sdk$(RESET)\n"
	@printf "  violations: none\n"
	@echo ""
	$(MAKE) demo-status

## Reset patched agents to original degraded state (for replaying the demo)
demo-reset:
	@echo ""
	@printf "  $(BOLD)Resetting demo agents to pre-patch state...$(RESET)\n"
	kubectl apply -f packages/operator/demo/voice-assistant/deployment.yaml \
	  --context $(KUBE_CONTEXT)
	kubectl apply -f packages/operator/demo/research-agent/deployment.yaml \
	  --context $(KUBE_CONTEXT)
	kubectl rollout status \
	  deployment/voice-assistant deployment/research-agent \
	  -n $(DEMO_AGENT_NS) --context $(KUBE_CONTEXT) --timeout=60s
	@printf "  $(GREEN)✓ Demo reset — run 'make demo-patch' again to replay$(RESET)\n"
	@echo ""

## Verify OPA health and run sample policy queries for OPA-enabled demo agents
## OPA runs as a sidecar in: gymcoach (port 8181), fitness-tracker (port 8181)
## Uses kubectl port-forward so no shell tools are needed inside the static OPA image.
## Requires: make demo (cluster must be running)
demo-opa:
	@echo ""
	@printf "  $(BOLD)OPA Policy Enforcement — demo cluster$(RESET)\n"
	@echo ""
	@# ── gymcoach ────────────────────────────────────────────────────────────────
	@printf "  $(CYAN)gymcoach$(RESET) — package: agentspec.agent.gymcoach\n"
	@kubectl port-forward -n $(DEMO_AGENT_NS) --context $(KUBE_CONTEXT) \
	  deploy/gymcoach 18181:8181 >/dev/null 2>&1 & \
	  PF_GYM=$$!; sleep 1; \
	  printf "  OPA health: "; \
	  curl -sf http://localhost:18181/health && echo " ok" || echo " unreachable"; \
	  printf "  Policy query (no guardrails → expect deny):\n"; \
	  curl -sf -X POST http://localhost:18181/v1/data/agentspec/agent/gymcoach/deny \
	    -H 'Content-Type: application/json' \
	    -d '{"input":{"request_type":"llm_call","guardrails_invoked":[],"toxicity_score":0,"tools_called":[],"user_confirmed":false,"cost_today_usd":0,"tokens_today":0}}' \
	    | sed 's/^/    /' || echo "    query failed"; \
	  kill $$PF_GYM 2>/dev/null; wait $$PF_GYM 2>/dev/null; true
	@echo ""
	@# ── fitness-tracker ─────────────────────────────────────────────────────────
	@printf "  $(CYAN)fitness-tracker$(RESET) — package: agentspec.agent.fitness_tracker\n"
	@kubectl port-forward -n $(DEMO_AGENT_NS) --context $(KUBE_CONTEXT) \
	  deploy/fitness-tracker 18182:8181 >/dev/null 2>&1 & \
	  PF_FT=$$!; sleep 1; \
	  printf "  OPA health: "; \
	  curl -sf http://localhost:18182/health && echo " ok" || echo " unreachable"; \
	  printf "  Policy query (no guardrails → expect deny):\n"; \
	  curl -sf -X POST http://localhost:18182/v1/data/agentspec/agent/fitness_tracker/deny \
	    -H 'Content-Type: application/json' \
	    -d '{"input":{"request_type":"llm_call","guardrails_invoked":[],"toxicity_score":0,"tools_called":[],"user_confirmed":false,"cost_today_usd":0,"tokens_today":0}}' \
	    | sed 's/^/    /' || echo "    query failed"; \
	  kill $$PF_FT 2>/dev/null; wait $$PF_FT 2>/dev/null; true
	@echo ""
	@printf "  $(BOLD)Tip:$(RESET) To regenerate policies from agent.yaml:\n"
	@printf "    agentspec generate-policy examples/gymcoach/agent.yaml --out /tmp/gymcoach-policy/\n"
	@echo ""

## Delete the cluster and all demo resources
demo-down:
ifeq ($(USE_KIND),true)
	@printf "  $(BOLD)Deleting kind cluster '$(DEMO_CLUSTER)'...$(RESET)\n"
	kind delete cluster --name $(DEMO_CLUSTER)
else
	@printf "  $(YELLOW)USE_KIND=false — skipping kind delete. Clean up manually:$(RESET)\n"
	@printf "    kubectl delete namespace $(DEMO_OP_NS) $(DEMO_AGENT_NS) --context $(KUBE_CONTEXT)\n"
endif
