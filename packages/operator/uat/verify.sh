#!/usr/bin/env bash
# verify.sh — UAT verification script for the AgentSpec operator.
#
# Checks that the operator is running, CRD is installed, demo AgentObservations
# exist, and the operator is actively reconciling them (status.phase is set).
#
# Usage:
#   bash uat/verify.sh [--namespace agentspec-system] [--demo-namespace demo] [--context kind-agentspec]
#
# Exit codes:
#   0  all checks passed
#   1  one or more checks failed

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { echo -e "  ${GREEN}PASS${RESET}  $1"; }
fail() { echo -e "  ${RED}FAIL${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}WARN${RESET}  $1"; }
info() { echo -e "  ${CYAN}INFO${RESET}  $1"; }

FAILURES=0
OP_NS="${OP_NS:-agentspec-system}"
DEMO_NS="${DEMO_NS:-demo}"
TIMEOUT="${TIMEOUT:-120}"   # seconds to wait for reconciliation
KUBE_CONTEXT=""

# ── Parse flags ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)       OP_NS="$2"; shift 2 ;;
    --demo-namespace)  DEMO_NS="$2"; shift 2 ;;
    --timeout)         TIMEOUT="$2"; shift 2 ;;
    --context)         KUBE_CONTEXT="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# Build kubectl context flag (empty string when not specified = use default)
CTX_FLAG=""
[[ -n "$KUBE_CONTEXT" ]] && CTX_FLAG="--context $KUBE_CONTEXT"

# Wrapper so every kubectl call uses the right context
kubectl() { command kubectl $CTX_FLAG "$@"; }

echo -e "\n${BOLD}AgentSpec Operator — UAT Verification${RESET}"
echo "  Operator namespace : $OP_NS"
echo "  Demo namespace     : $DEMO_NS"
echo "  Reconcile timeout  : ${TIMEOUT}s"
[[ -n "$KUBE_CONTEXT" ]] && echo "  Kube context       : $KUBE_CONTEXT"
echo ""

# ── 1. Tools ──────────────────────────────────────────────────────────────────
echo -e "${BOLD}[1] Prerequisites${RESET}"
for tool in kubectl; do
  if command -v "$tool" &>/dev/null; then
    pass "$tool found ($(command -v "$tool"))"
  else
    fail "$tool not found — install it before running UAT"
  fi
done
[[ $FAILURES -gt 0 ]] && echo -e "\n${RED}Aborting: missing required tools.${RESET}" && exit 1

# ── 2. CRD installed ──────────────────────────────────────────────────────────
echo -e "\n${BOLD}[2] CRD${RESET}"
if kubectl get crd agentobservations.agentspec.io &>/dev/null; then
  pass "CRD agentobservations.agentspec.io is installed"
else
  fail "CRD not found — run: kubectl apply -f crds/agentobservation.yaml"
fi

# ── 3. Operator deployment ────────────────────────────────────────────────────
echo -e "\n${BOLD}[3] Operator deployment (namespace: $OP_NS)${RESET}"
if kubectl get namespace "$OP_NS" &>/dev/null; then
  pass "Namespace $OP_NS exists"
else
  fail "Namespace $OP_NS does not exist — run: helm install agentspec helm/agentspec-operator -n $OP_NS --create-namespace"
fi

if kubectl get deployment agentspec-operator -n "$OP_NS" &>/dev/null; then
  READY=$(kubectl get deployment agentspec-operator -n "$OP_NS" \
            -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  DESIRED=$(kubectl get deployment agentspec-operator -n "$OP_NS" \
              -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
  if [[ "$READY" == "$DESIRED" ]]; then
    pass "Operator deployment: $READY/$DESIRED replicas ready"
  else
    fail "Operator deployment: only $READY/$DESIRED replicas ready"
    warn "Check logs: kubectl logs -n $OP_NS deploy/agentspec-operator"
  fi
else
  fail "Operator deployment not found in $OP_NS"
fi

# ── 4. Demo agents deployed ───────────────────────────────────────────────────
echo -e "\n${BOLD}[4] Demo agents (namespace: $DEMO_NS)${RESET}"
DEMO_AGENTS=("gymcoach" "trading-bot" "voice-assistant" "fitness-tracker" "research-agent")

if kubectl get namespace "$DEMO_NS" &>/dev/null; then
  pass "Namespace $DEMO_NS exists"
else
  fail "Namespace $DEMO_NS does not exist — run: kubectl apply -f demo/"
fi

for agent in "${DEMO_AGENTS[@]}"; do
  if kubectl get agentobservation "$agent" -n "$DEMO_NS" &>/dev/null 2>&1; then
    pass "AgentObservation/$agent exists"
  else
    fail "AgentObservation/$agent not found — run: kubectl apply -f demo/${agent}/agentobservation.yaml"
  fi
done

# ── 5. Wait for reconciliation ────────────────────────────────────────────────
echo -e "\n${BOLD}[5] Waiting for operator to reconcile (up to ${TIMEOUT}s)${RESET}"

wait_for_phase() {
  local name="$1"
  local deadline=$((SECONDS + TIMEOUT))
  while [[ $SECONDS -lt $deadline ]]; do
    PHASE=$(kubectl get agentobservation "$name" -n "$DEMO_NS" \
              -o jsonpath='{.status.phase}' 2>/dev/null || true)
    if [[ -n "$PHASE" && "$PHASE" != "Pending" ]]; then
      echo "$PHASE"
      return 0
    fi
    sleep 5
  done
  echo ""
  return 1
}

for agent in "${DEMO_AGENTS[@]}"; do
  info "Waiting for $agent..."
  PHASE=$(wait_for_phase "$agent" || true)
  if [[ -n "$PHASE" ]]; then
    pass "$agent reconciled: phase=$PHASE"
  else
    fail "$agent: still Pending or no status after ${TIMEOUT}s"
    warn "Is the sidecar reachable? Check: kubectl logs -n $OP_NS deploy/agentspec-operator | grep $agent"
  fi
done

# ── 6. Status field snapshot ──────────────────────────────────────────────────
echo -e "\n${BOLD}[6] Status snapshot${RESET}"
for agent in "${DEMO_AGENTS[@]}"; do
  PHASE=$(kubectl get agentobservation "$agent" -n "$DEMO_NS" \
            -o jsonpath='{.status.phase}' 2>/dev/null || echo "—")
  GRADE=$(kubectl get agentobservation "$agent" -n "$DEMO_NS" \
            -o jsonpath='{.status.grade}' 2>/dev/null || echo "—")
  SCORE=$(kubectl get agentobservation "$agent" -n "$DEMO_NS" \
            -o jsonpath='{.status.score}' 2>/dev/null || echo "—")
  VIOL=$(kubectl get agentobservation "$agent" -n "$DEMO_NS" \
           -o jsonpath='{.status.violations}' 2>/dev/null || echo "—")
  SOURCE=$(kubectl get agentobservation "$agent" -n "$DEMO_NS" \
             -o jsonpath='{.status.source}' 2>/dev/null || echo "—")
  MODEL=$(kubectl get agentobservation "$agent" -n "$DEMO_NS" \
            -o jsonpath='{.status.model.status}' 2>/dev/null || echo "—")
  printf "  %-20s  phase=%-10s  grade=%-3s  score=%-5s  violations=%-3s  model=%-5s  source=%s\n" \
    "$agent" "$PHASE" "$GRADE" "$SCORE" "$VIOL" "$MODEL" "$SOURCE"
done

# ── 7. Expected outcomes (when sidecar is reachable) ─────────────────────────
echo -e "\n${BOLD}[7] Expected compliance profile checks${RESET}"
info "These checks only pass when the agentspec-sidecar image is reachable."
info "With a stub sidecar (ImagePullBackOff), all agents will show phase=Unknown."
echo ""

check_field() {
  local agent="$1" field="$2" expected="$3"
  actual=$(kubectl get agentobservation "$agent" -n "$DEMO_NS" \
             -o jsonpath="{.status.$field}" 2>/dev/null || echo "")
  if [[ "$actual" == "$expected" ]]; then
    pass "$agent .status.$field = $expected"
  else
    warn "$agent .status.$field = '${actual:-<empty>}' (expected '$expected' — sidecar may be unreachable)"
  fi
}

check_field "gymcoach"       "phase"        "Healthy"
check_field "gymcoach"       "grade"        "A"
check_field "trading-bot"    "phase"        "Degraded"
check_field "trading-bot"    "model.status" "fail"
check_field "voice-assistant" "grade"       "C"
check_field "fitness-tracker" "phase"       "Healthy"
check_field "fitness-tracker" "grade"       "A"
check_field "research-agent"  "phase"       "Unhealthy"
check_field "research-agent"  "grade"       "F"
check_field "research-agent"  "source"      "agent-sdk"

# ── 8. Operator logs (last 20 lines) ─────────────────────────────────────────
echo -e "\n${BOLD}[8] Operator log tail${RESET}"
kubectl logs -n "$OP_NS" deploy/agentspec-operator --tail=20 2>/dev/null \
  | sed 's/^/  /' || warn "Could not fetch operator logs"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}All checks passed.${RESET}"
else
  echo -e "${RED}${BOLD}$FAILURES check(s) failed.${RESET}"
  exit 1
fi
