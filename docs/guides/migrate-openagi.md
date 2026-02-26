# Migrating OpenAGI to AgentSpec

[OpenAGI](https://github.com/agiresearch/OpenAGI) is an open-source AGI research platform that orchestrates multiple specialized task-solving agents with LLMs. This guide shows how to represent it as an `agent.yaml` manifest.

## What OpenAGI Has

| Component | OpenAGI | AgentSpec field |
|-----------|---------|-----------------|
| Model | OpenAI GPT-4 (configurable) | `spec.model.provider: openai` |
| Tools | Task-specific expert models (CV, NLP, Audio) | `spec.tools[]` |
| Planning | LLM-based task decomposition | `spec.subagents[]` |
| Memory | In-memory conversation history | `spec.memory.shortTerm` |
| Evaluation | Built-in task success metrics | `spec.evaluation` |

## The Manifest

```yaml
apiVersion: agentspec.io/v1
kind: AgentSpec

metadata:
  name: openagi-orchestrator
  version: 1.0.0
  description: "AGI research platform — orchestrates specialized task-solving agents via LLM planning"
  tags: [research, agi, multi-agent, task-solving]
  license: Apache-2.0

spec:
  model:
    provider: openai
    id: gpt-4-0125-preview
    apiKey: $env:OPENAI_API_KEY
    parameters:
      temperature: 0.0
      maxTokens: 2000
    fallback:
      provider: openai
      id: gpt-3.5-turbo
      apiKey: $env:OPENAI_API_KEY
      triggerOn: [rate_limit, timeout]
      maxRetries: 3
    costControls:
      maxMonthlyUSD: 500
      alertAtUSD: 400

  prompts:
    system: $file:prompts/task_planning.md
    fallback: "Task planning temporarily unavailable. Please retry."

  tools:
    - name: image-classification
      type: function
      description: "Classify images using ResNet/ViT expert model"
      module: $file:openagi/expert_models/vision.py
      function: classify_image
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: true

    - name: text-summarization
      type: function
      description: "Summarize documents using fine-tuned T5"
      module: $file:openagi/expert_models/nlp.py
      function: summarize_text
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: true

    - name: audio-transcription
      type: function
      description: "Transcribe audio using Whisper"
      module: $file:openagi/expert_models/audio.py
      function: transcribe_audio
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: true

    - name: task-decomposer
      type: function
      description: "Decompose a complex task into subtasks"
      module: $file:openagi/planner.py
      function: decompose_task
      annotations:
        readOnlyHint: false
        destructiveHint: false

  memory:
    shortTerm:
      backend: in-memory
      maxTurns: 50
      maxTokens: 16000
    hygiene:
      piiScrubFields: []
      auditLog: false

  evaluation:
    framework: custom
    metrics:
      - faithfulness
      - answer_relevancy
    thresholds:
      faithfulness: 0.75
    ciGate: false

  observability:
    tracing:
      backend: langsmith
      sampleRate: 0.1
    logging:
      level: info
      structured: true

  guardrails:
    input:
      - type: prompt-injection
        action: reject
        sensitivity: medium
    output:
      - type: toxicity-filter
        threshold: 0.8
        action: reject

  compliance:
    packs:
      - owasp-llm-top10
      - model-resilience

  requires:
    envVars:
      - OPENAI_API_KEY
    minimumMemoryMB: 2048
```

## Running the Migration

```bash
# 1. Write the manifest
npx agentspec validate agent.yaml

# 2. Health check (with OPENAI_API_KEY set)
npx agentspec health agent.yaml

# 3. Audit
npx agentspec audit agent.yaml
# Expected: ~72/100 (C) — no long-term memory, no CI gate, $env not $secret
```

## Audit Results

| Rule | Status | Reason |
|------|--------|--------|
| MODEL-01 | ✓ | Fallback GPT-3.5 configured |
| MODEL-03 | ✓ | Cost controls set |
| SEC-LLM-01 | ✓ | Prompt injection guard |
| SEC-LLM-06 | ✓ | No long-term memory (N/A) |
| SEC-LLM-09 | ✗ | CI gate not enabled |
| SEC-LLM-10 | ✗ | Uses `$env:` not `$secret:` |
| EVAL-02 | ✗ | CI gate disabled |

## Generating LangGraph Code

```bash
npm install @agentspec/adapter-langgraph
npx agentspec generate agent.yaml --framework langgraph --output ./generated/
```

This produces `agent.py` with:
- GPT-4 + GPT-3.5 fallback via `llm.with_fallbacks()`
- All 4 tool functions bound to the model
- In-memory `MemorySaver` checkpointer
- LangSmith tracing enabled
- Prompt injection guard in `guardrails.py`

## Export as A2A AgentCard

```bash
npx agentspec export agent.yaml --format agentcard
```

```json
{
  "name": "openagi-orchestrator",
  "description": "AGI research platform — orchestrates specialized task-solving agents via LLM planning",
  "version": "1.0.0",
  "capabilities": {
    "streaming": false,
    "stateTransitionHistory": false
  },
  "skills": []
}
```
