# Pin to a specific patch release so rebuilds are reproducible.
# To pin further to a digest: docker inspect python:3.12.9-slim --format '{{index .RepoDigests 0}}'
FROM python:3.12.9-slim

WORKDIR /app

# Install dependencies first (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy operator source (webhook.py: pure business logic, remote_watcher.py: Phase 6)
COPY operator.py models.py prober.py status.py webhook.py remote_watcher.py ./

# Run as non-root (uid 1000) — required for PSA restricted policy and aligns
# with runAsUser: 1000 set in the Helm deployment securityContext.
RUN adduser --system --uid 1000 --no-create-home agentspec
USER 1000

# Port 9443: kopf native admission webhook (MutatingWebhookConfiguration)
# Port 8080: Kopf liveness probe
EXPOSE 9443 8080

# Kopf entrypoint — runs operator.py as a Kopf operator.
# The admission webhook (port 9443) is served by kopf's built-in WebhookServer
# when WEBHOOK_ENABLED=true — no separate uvicorn process required.
ENTRYPOINT ["kopf", "run", "--all-namespaces", "--liveness=http://0.0.0.0:8080/healthz", "operator.py"]
