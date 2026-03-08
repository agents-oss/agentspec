# Deploy with the Sidecar and Monitor Live

Deploy a LangGraph agent to Kubernetes with the AgentSpec sidecar pre-wired, then use the live `/gap` endpoint to see the delta between what your manifest declares and what's actually running.

**Time:** ~10 minutes
**Prerequisites:** Node.js 20+, Python 3.11+, `kubectl` connected to a cluster, `ANTHROPIC_API_KEY`, a valid `agent.yaml` (see [Build a Production Agent](./01-build-production-agent))

---

## 1. Generate Kubernetes manifests

```bash
export ANTHROPIC_API_KEY=ant-...
agentspec generate agent.yaml --framework langgraph --deploy k8s --output ./generated/
```

The `--deploy k8s` flag generates a full Kubernetes package alongside the Python code:

```
generated/
├── agent.py
├── requirements.txt
├── .env.example
├── README.md
└── k8s/
    ├── deployment.yaml
    ├── service.yaml
    ├── configmap.yaml
    └── secret.yaml.example
```

---

## 2. Understand the generated Deployment

Open `generated/k8s/deployment.yaml`. It contains two containers: your agent and the AgentSpec sidecar.

```yaml
spec:
  containers:
    - name: agent
      image: your-registry/my-agent:latest
      ports:
        - containerPort: 8000
      envFrom:
        - secretRef:
            name: my-agent-secrets

    - name: agentspec-sidecar
      image: ghcr.io/agents-oss/agentspec-sidecar:latest
      ports:
        - containerPort: 4000   # health/explore/gap
        - containerPort: 4001   # control plane push
      env:
        - name: AGENT_SPEC_PATH
          value: /etc/agentspec/agent.yaml
        - name: AGENT_SDK_URL
          value: http://localhost:8000/agentspec/health
      volumeMounts:
        - name: agentspec-config
          mountPath: /etc/agentspec
  volumes:
    - name: agentspec-config
      configMap:
        name: my-agent-agentspec
```

The sidecar reads the manifest from the ConfigMap and polls the agent's `/agentspec/health` endpoint (provided by the Python SDK). If the SDK endpoint is unreachable, the sidecar falls back to static manifest analysis.

---

## 3. Configure secrets

```bash
cp generated/k8s/secret.yaml.example generated/k8s/secret.yaml
```

Edit `secret.yaml` and fill in base64-encoded values:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-agent-secrets
type: Opaque
data:
  OPENAI_API_KEY: <base64>
  REDIS_URL: <base64>
```

```bash
echo -n "sk-..." | base64
echo -n "redis://redis-service:6379" | base64
```

---

## 4. Deploy to the cluster

```bash
kubectl apply -f generated/k8s/configmap.yaml
kubectl apply -f generated/k8s/secret.yaml
kubectl apply -f generated/k8s/deployment.yaml
kubectl apply -f generated/k8s/service.yaml
```

Wait for the pod to be ready:

```bash
kubectl rollout status deployment/my-agent
```

---

## 5. Port-forward to the sidecar

```bash
kubectl port-forward deployment/my-agent 4000:4000
```

Leave this running in a separate terminal.

---

## 6. Read the live health report

```bash
curl -s http://localhost:4000/health/ready | jq .
```

Example response:

```json
{
  "status": "healthy",
  "checks": [
    { "category": "env",    "name": "OPENAI_API_KEY", "status": "pass" },
    { "category": "model",  "name": "openai/gpt-4o-2024-11-20", "status": "pass", "latencyMs": 134 },
    { "category": "memory", "name": "redis://redis-service:6379", "status": "pass" },
    { "category": "tool",   "name": "web_search", "status": "pass" },
    { "category": "tool",   "name": "file_reader", "status": "pass" }
  ]
}
```

The `tool` category checks come from the SDK reporter — they confirm which handlers are actually registered at runtime.

---

## 7. Explore runtime capabilities

```bash
curl -s http://localhost:4000/explore | jq .
```

`/explore` returns the agent's declared capabilities merged with live registration status:

```json
{
  "model": { "provider": "openai", "id": "gpt-4o-2024-11-20", "reachable": true },
  "tools": [
    { "name": "web_search",  "declared": true, "registered": true },
    { "name": "file_reader", "declared": true, "registered": true }
  ],
  "memory": { "backend": "redis", "reachable": true },
  "guardrails": { "input": 2, "output": 2 }
}
```

---

## 8. Read the gap report

```bash
curl -s http://localhost:4000/gap | jq .
```

The `/gap` endpoint is the most important sidecar endpoint. It shows the delta between what `agent.yaml` declares and what's actually observable at runtime:

```json
{
  "gaps": [],
  "summary": {
    "total": 0,
    "critical": 0,
    "high": 0
  }
}
```

An empty `gaps` array means perfect alignment between spec and runtime.

If a declared tool isn't registered at runtime:

```json
{
  "gaps": [
    {
      "field": "spec.tools[1].name",
      "declared": "file_reader",
      "observed": null,
      "severity": "high",
      "evidenceLevel": "probed",
      "remediation": "Register the 'file_reader' handler in your agent startup code"
    }
  ]
}
```

Fix gaps by aligning your implementation with the manifest — not by removing things from the manifest.

---

## 9. Enable push mode and run the dual audit

Enable the agent to push health reports to the control plane. In the deployment's `generated/k8s/deployment.yaml`, add env vars to the agent container:

```yaml
env:
  - name: AGENTSPEC_URL
    value: http://localhost:4001
  - name: AGENTSPEC_KEY
    valueFrom:
      secretKeyRef:
        name: my-agent-secrets
        key: AGENTSPEC_KEY
```

Port-forward the control plane port:

```bash
kubectl port-forward deployment/my-agent 4001:4001
```

Run the full dual-score audit:

```bash
agentspec audit agent.yaml --url http://localhost:4001
```

The output now shows both declared and proved scores:

```
  AgentSpec Audit — my-agent
  ──────────────────────────
  Declared score:  74/100   Grade: C
  Proved score:    81/100   Grade: B

  Pending proof:   3 external rules (submit via POST /proof/rule/:ruleId)
```

The proved score is higher because the sidecar confirms tools are registered, model is reachable, and memory is connected — upgrading those checks from `[D]` to `[P]`.

---

## What you've accomplished

- Generated a full k8s deployment with sidecar from a single `agent.yaml`
- Deployed the agent and sidecar to a live cluster
- Read live health, capability, and gap reports via sidecar endpoints
- Ran a dual-score audit showing declared vs proved compliance

---

## See also

- [Build a Production Agent](./01-build-production-agent) — start here if you don't have a manifest yet
- [Harden an Existing Agent](./02-harden-existing-agent) — improve an existing agent's score
- [Operator Helm Values](../reference/operator-helm-values) — production Helm chart configuration
- [Proof Integration](../guides/proof-integration) — submit external evidence for `[X]` rules
- [Runtime Introspection](../concepts/runtime-introspection) — how the sidecar endpoints work
