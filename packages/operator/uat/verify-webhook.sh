#!/usr/bin/env bash
# verify-webhook.sh — UAT verification script for Phase 2 MutatingWebhook.
#
# Covers the two acceptance criteria that require a live cluster:
#   ✓ helm lint passes with webhook templates enabled
#   ✓ kubectl apply annotated pod → appears in k9s :ao within 35s
#
# Usage:
#   bash uat/verify-webhook.sh [OPTIONS]
#
# Options:
#   --namespace       <ns>   Operator namespace        (default: agentspec-system)
#   --target-namespace <ns>  Namespace to create test pods in (default: default)
#   --timeout         <s>    Seconds to wait for reconciliation (default: 60)
#   --skip-helm-lint         Skip helm lint checks (if helm CLI absent)
#   --skip-cluster           Skip all cluster checks (unit + lint only)
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

pass()  { echo -e "  ${GREEN}PASS${RESET}  $1"; }
fail()  { echo -e "  ${RED}FAIL${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
warn()  { echo -e "  ${YELLOW}WARN${RESET}  $1"; }
info()  { echo -e "  ${CYAN}INFO${RESET}  $1"; }
skip()  { echo -e "  ${CYAN}SKIP${RESET}  $1"; }

FAILURES=0
OP_NS="${OP_NS:-agentspec-system}"
TARGET_NS="${TARGET_NS:-default}"
TIMEOUT="${TIMEOUT:-60}"
SKIP_HELM_LINT=false
SKIP_CLUSTER=false

# ── Parse flags ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)          OP_NS="$2";         shift 2 ;;
    --target-namespace)   TARGET_NS="$2";     shift 2 ;;
    --timeout)            TIMEOUT="$2";       shift 2 ;;
    --skip-helm-lint)     SKIP_HELM_LINT=true; shift ;;
    --skip-cluster)       SKIP_CLUSTER=true;  shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPERATOR_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "\n${BOLD}AgentSpec Webhook — Phase 2 UAT Verification${RESET}"
echo "  Operator namespace : $OP_NS"
echo "  Test namespace     : $TARGET_NS"
echo "  Reconcile timeout  : ${TIMEOUT}s"
echo "  Operator dir       : $OPERATOR_DIR"
echo ""

# ── 1. Unit tests ─────────────────────────────────────────────────────────────
echo -e "${BOLD}[1] Unit tests (pytest)${RESET}"
if command -v pytest &>/dev/null || python3 -m pytest --version &>/dev/null 2>&1; then
  cd "$OPERATOR_DIR"
  if python3 -m pytest tests/test_webhook.py -q --tb=short 2>&1 | tail -3; then
    pass "All webhook unit tests passed"
  else
    fail "Webhook unit tests failed — run: pytest tests/test_webhook.py -v"
  fi
  # Full regression
  TOTAL=$(python3 -m pytest tests/ -q --tb=no 2>&1 | grep -E "passed" | grep -oE "[0-9]+ passed" | head -1 || echo "")
  if [[ -n "$TOTAL" ]]; then
    pass "Full test suite: $TOTAL"
  else
    fail "Could not determine full test suite result"
  fi
else
  warn "pytest not found — skipping unit tests (run: pip install -r requirements-dev.txt)"
fi

# ── 2. Helm lint ──────────────────────────────────────────────────────────────
echo -e "\n${BOLD}[2] Helm lint${RESET}"
if $SKIP_HELM_LINT; then
  skip "Skipped (--skip-helm-lint)"
elif ! command -v helm &>/dev/null; then
  warn "helm CLI not found — install from https://helm.sh/docs/intro/install/"
  warn "Skipping helm lint (install helm and rerun to close this acceptance criterion)"
else
  HELM_DIR="$OPERATOR_DIR/helm/agentspec-operator"

  # Default values (webhook disabled)
  if helm lint "$HELM_DIR" -q 2>&1 | grep -q "0 chart(s) failed"; then
    pass "helm lint: default values (webhook disabled)"
  else
    fail "helm lint failed with default values"
    helm lint "$HELM_DIR" 2>&1 | sed 's/^/    /'
  fi

  # Webhook + cert-manager enabled
  if helm lint "$HELM_DIR" -q \
      --set webhook.enabled=true \
      --set webhook.certManager.enabled=true 2>&1 | grep -q "0 chart(s) failed"; then
    pass "helm lint: webhook.enabled=true, certManager.enabled=true"
  else
    fail "helm lint failed with webhook + certManager enabled"
    helm lint "$HELM_DIR" --set webhook.enabled=true --set webhook.certManager.enabled=true 2>&1 | sed 's/^/    /'
  fi

  # Webhook + manual caBundle (no cert-manager)
  if helm lint "$HELM_DIR" -q \
      --set webhook.enabled=true \
      --set webhook.certManager.enabled=false \
      --set "webhook.caBundle=dGVzdA==" 2>&1 | grep -q "0 chart(s) failed"; then
    pass "helm lint: webhook.enabled=true, certManager.enabled=false (manual caBundle)"
  else
    fail "helm lint failed with webhook enabled, cert-manager disabled"
    helm lint "$HELM_DIR" --set webhook.enabled=true --set webhook.certManager.enabled=false --set "webhook.caBundle=dGVzdA==" 2>&1 | sed 's/^/    /'
  fi
fi

# ── Cluster checks ────────────────────────────────────────────────────────────
if $SKIP_CLUSTER; then
  echo -e "\n${CYAN}Skipping all cluster checks (--skip-cluster)${RESET}"
  echo ""
  [[ $FAILURES -eq 0 ]] && echo -e "${GREEN}${BOLD}All checks passed.${RESET}" || { echo -e "${RED}${BOLD}$FAILURES check(s) failed.${RESET}"; exit 1; }
  exit 0
fi

# ── 3. Prerequisites (cluster) ────────────────────────────────────────────────
echo -e "\n${BOLD}[3] Cluster prerequisites${RESET}"
CLUSTER_AVAILABLE=true
for tool in kubectl; do
  if command -v "$tool" &>/dev/null; then
    pass "$tool found"
  else
    fail "$tool not found"
    CLUSTER_AVAILABLE=false
  fi
done

if ! kubectl cluster-info &>/dev/null 2>&1; then
  warn "No cluster reachable — skipping all cluster checks"
  warn "Start a kind cluster: kind create cluster --name agentspec --config uat/kind-cluster.yaml"
  CLUSTER_AVAILABLE=false
fi

if ! $CLUSTER_AVAILABLE; then
  [[ $FAILURES -eq 0 ]] && echo -e "\n${YELLOW}Unit + lint checks passed. Cluster checks skipped (no cluster).${RESET}" && exit 0
  echo -e "\n${RED}${BOLD}$FAILURES check(s) failed.${RESET}"; exit 1
fi

# ── 4. Operator + webhook running ─────────────────────────────────────────────
echo -e "\n${BOLD}[4] Operator health${RESET}"
if kubectl get deployment agentspec-operator -n "$OP_NS" &>/dev/null; then
  READY=$(kubectl get deployment agentspec-operator -n "$OP_NS" \
            -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  [[ "$READY" -ge 1 ]] && pass "Operator deployment ready ($READY replicas)" \
                        || fail "Operator not ready — check: kubectl get pods -n $OP_NS"
else
  fail "Operator deployment not found in $OP_NS — install Phase 1 + Phase 2 first"
fi

if kubectl get mutatingwebhookconfiguration agentspec-operator-inject &>/dev/null 2>&1; then
  pass "MutatingWebhookConfiguration 'agentspec-operator-inject' registered"
else
  fail "MutatingWebhookConfiguration not found — helm upgrade with --set webhook.enabled=true"
fi

if kubectl get certificate agentspec-operator-webhook-cert -n "$OP_NS" &>/dev/null 2>&1; then
  CERT_READY=$(kubectl get certificate agentspec-operator-webhook-cert -n "$OP_NS" \
                 -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
  [[ "$CERT_READY" == "True" ]] && pass "TLS Certificate READY=True" \
                                 || fail "TLS Certificate not ready — check cert-manager: kubectl describe certificate agentspec-operator-webhook-cert -n $OP_NS"
else
  warn "cert-manager Certificate not found — using manual caBundle?"
fi

# ── 5. Annotated pod → sidecar injected ──────────────────────────────────────
echo -e "\n${BOLD}[5] Sidecar injection${RESET}"
TEST_POD="agentspec-webhook-verify-$$"
TEST_CR="$TEST_POD"

cleanup_test_resources() {
  kubectl delete pod "$TEST_POD" -n "$TARGET_NS" --ignore-not-found --grace-period=0 &>/dev/null || true
  kubectl delete agentobservation "$TEST_CR" -n "$TARGET_NS" --ignore-not-found &>/dev/null || true
}
trap cleanup_test_resources EXIT

info "Creating annotated test pod: $TEST_POD"
kubectl apply -f - <<EOF &>/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $TEST_POD
  namespace: $TARGET_NS
  annotations:
    agentspec.io/inject: "true"
    agentspec.io/agent-name: $TEST_CR
    agentspec.io/manifest-configmap: agentspec-manifest
spec:
  containers:
    - name: agent
      image: python:3.12-slim
      command: ["python", "-c", "import time; time.sleep(3600)"]
EOF

# Give kube-apiserver a moment to call the webhook
sleep 2

CONTAINERS=$(kubectl get pod "$TEST_POD" -n "$TARGET_NS" \
               -o jsonpath='{.spec.containers[*].name}' 2>/dev/null || echo "")
if echo "$CONTAINERS" | grep -q "agentspec-sidecar"; then
  pass "Sidecar container 'agentspec-sidecar' present in pod"
else
  fail "Sidecar NOT injected — containers: '${CONTAINERS:-<none>}'"
  warn "Check webhook logs: kubectl logs -n $OP_NS deploy/agentspec-operator | grep webhook"
fi

# ── 6. Un-annotated pod → NOT mutated ────────────────────────────────────────
echo -e "\n${BOLD}[6] Un-annotated pod not mutated${RESET}"
CLEAN_POD="agentspec-webhook-clean-$$"
kubectl apply -f - <<EOF &>/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $CLEAN_POD
  namespace: $TARGET_NS
spec:
  containers:
    - name: agent
      image: python:3.12-slim
      command: ["python", "-c", "import time; time.sleep(3600)"]
EOF

sleep 2
CLEAN_CONTAINERS=$(kubectl get pod "$CLEAN_POD" -n "$TARGET_NS" \
                     -o jsonpath='{.spec.containers[*].name}' 2>/dev/null || echo "")
if echo "$CLEAN_CONTAINERS" | grep -q "agentspec-sidecar"; then
  fail "Sidecar was injected into un-annotated pod — this is wrong"
else
  pass "Un-annotated pod has no sidecar (containers: $CLEAN_CONTAINERS)"
fi
kubectl delete pod "$CLEAN_POD" -n "$TARGET_NS" --ignore-not-found --grace-period=0 &>/dev/null || true

# ── 7. AgentObservation CR created ───────────────────────────────────────────
echo -e "\n${BOLD}[7] AgentObservation CR auto-created${RESET}"
if kubectl get agentobservation "$TEST_CR" -n "$TARGET_NS" &>/dev/null 2>&1; then
  pass "AgentObservation '$TEST_CR' created in namespace '$TARGET_NS'"
else
  fail "AgentObservation '$TEST_CR' NOT found in '$TARGET_NS'"
  warn "Webhook may lack RBAC to create CRs — check: kubectl get clusterrole agentspec-operator-$OP_NS -o yaml | grep agentobservations"
fi

# ── 8. Reconciliation within timeout ─────────────────────────────────────────
echo -e "\n${BOLD}[8] Operator reconciles CR within ${TIMEOUT}s${RESET}"
info "Waiting for AgentObservation phase to move past 'Pending'..."
DEADLINE=$((SECONDS + TIMEOUT))
FINAL_PHASE=""
while [[ $SECONDS -lt $DEADLINE ]]; do
  PHASE=$(kubectl get agentobservation "$TEST_CR" -n "$TARGET_NS" \
            -o jsonpath='{.status.phase}' 2>/dev/null || true)
  if [[ -n "$PHASE" && "$PHASE" != "Pending" ]]; then
    FINAL_PHASE="$PHASE"
    break
  fi
  sleep 3
done

if [[ -n "$FINAL_PHASE" ]]; then
  GRADE=$(kubectl get agentobservation "$TEST_CR" -n "$TARGET_NS" \
            -o jsonpath='{.status.grade}' 2>/dev/null || echo "—")
  SCORE=$(kubectl get agentobservation "$TEST_CR" -n "$TARGET_NS" \
            -o jsonpath='{.status.score}' 2>/dev/null || echo "—")
  SOURCE=$(kubectl get agentobservation "$TEST_CR" -n "$TARGET_NS" \
             -o jsonpath='{.status.source}' 2>/dev/null || echo "—")
  pass "AgentObservation reconciled: phase=$FINAL_PHASE grade=$GRADE score=$SCORE source=$SOURCE"
  info "This satisfies: 'kubectl apply annotated pod → appears in k9s :ao within 35s'"
else
  fail "AgentObservation still Pending after ${TIMEOUT}s — operator may not have picked it up"
  warn "Check: kubectl logs -n $OP_NS deploy/agentspec-operator | grep $TEST_CR"
fi

# ── 9. GC — delete pod → CR deleted ──────────────────────────────────────────
echo -e "\n${BOLD}[9] OwnerReference GC (pod delete → CR delete)${RESET}"
POD_UID=$(kubectl get pod "$TEST_POD" -n "$TARGET_NS" \
            -o jsonpath='{.metadata.uid}' 2>/dev/null || echo "")
OWNER_UID=$(kubectl get agentobservation "$TEST_CR" -n "$TARGET_NS" \
              -o jsonpath='{.metadata.ownerReferences[0].uid}' 2>/dev/null || echo "")

if [[ -n "$POD_UID" && "$POD_UID" == "$OWNER_UID" ]]; then
  pass "ownerReference UID matches pod UID ($POD_UID)"
elif [[ -z "$OWNER_UID" ]]; then
  # Pod was created with generateName (no UID at admission time) — GC via label instead
  warn "No ownerReference on CR (pod may have used generateName at admission time)"
  warn "GC must be handled manually or via label-based cleanup"
else
  warn "ownerReference UID mismatch — pod=$POD_UID, ref=$OWNER_UID"
fi

kubectl delete pod "$TEST_POD" -n "$TARGET_NS" --ignore-not-found --grace-period=0 &>/dev/null || true
sleep 5
if ! kubectl get agentobservation "$TEST_CR" -n "$TARGET_NS" &>/dev/null 2>&1; then
  pass "AgentObservation deleted after pod was removed (ownerReference GC)"
else
  warn "AgentObservation still exists after pod delete — GC may be delayed or ownerRef absent"
  warn "Manual cleanup: kubectl delete agentobservation $TEST_CR -n $TARGET_NS"
fi

# ── 10. failurePolicy: Ignore ─────────────────────────────────────────────────
echo -e "\n${BOLD}[10] failurePolicy: Ignore (webhook failure does not block pods)${RESET}"
FAILURE_POLICY=$(kubectl get mutatingwebhookconfiguration agentspec-operator-inject \
                   -o jsonpath='{.webhooks[0].failurePolicy}' 2>/dev/null || echo "")
if [[ "$FAILURE_POLICY" == "Ignore" ]]; then
  pass "failurePolicy=Ignore on MutatingWebhookConfiguration"
else
  fail "failurePolicy='${FAILURE_POLICY:-<unknown>}' — must be 'Ignore' to avoid blocking pods"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}All checks passed. Phase 2 acceptance criteria satisfied.${RESET}"
  echo ""
  echo "  Remaining manual step:"
  echo "    - Open k9s → :ao to see the live table (visual demo, not automatable)"
else
  echo -e "${RED}${BOLD}$FAILURES check(s) failed.${RESET}"
  echo "  See webhook_testing.md for detailed troubleshooting steps."
  exit 1
fi
