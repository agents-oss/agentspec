#!/usr/bin/env bash
set -euo pipefail

REPO="agents-oss/agentspec"
NAMESPACE="agentspec-system"

# ── Prerequisite checks ───────────────────────────────────────────────────────
for cmd in helm kubectl curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Error: $cmd not found. Please install it first."; exit 1; }
done

kubectl cluster-info >/dev/null 2>&1 || { echo "Error: No active Kubernetes cluster. Configure kubectl first."; exit 1; }

# ── Fetch latest release version ─────────────────────────────────────────────
VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' \
  | sed 's/.*"v\([^"]*\)".*/\1/')

if [[ -z "$VERSION" ]]; then
  echo "Error: Could not determine latest version from GitHub releases."
  exit 1
fi

echo "Installing agentspec-operator v${VERSION}..."

# ── Helm install from OCI ─────────────────────────────────────────────────────
helm upgrade --install agentspec-operator \
  oci://ghcr.io/agents-oss/charts/agentspec-operator \
  --version "$VERSION" \
  --namespace "$NAMESPACE" --create-namespace

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "agentspec-operator v${VERSION} installed in namespace: ${NAMESPACE}"
echo ""
echo "To watch agent compliance:"
echo "  kubectl get agentobservations -A"
echo ""
echo "To access the control plane (if running):"
echo "  kubectl port-forward svc/agentspec-control-plane 4001:4001 -n ${NAMESPACE}"
