# Structure Evaluation Datasets

Organise evaluation data so each dataset file tests one concern and each metric is declared exactly once — in `agent.yaml`, not in the JSONL.

## The rule: one dataset, one concern

Metrics are declared at the dataset level in the manifest, not per sample in the JSONL file.
A dataset file contains only data — inputs, expected outputs, and optional context.

This means: **if you need different metrics, use different dataset files.**

```yaml
spec:
  evaluation:
    framework: ragas
    datasets:
      - name: rag-quality
        path: $file:evals/rag.jsonl
        metrics: [faithfulness, context_recall, answer_relevancy]

      - name: safety
        path: $file:evals/safety.jsonl
        metrics: [toxicity, bias]

      - name: accuracy
        path: $file:evals/accuracy.jsonl
        metrics: [answer_similarity, hallucination]

    thresholds:
      faithfulness: 0.80
      context_recall: 0.75
      answer_relevancy: 0.75
      toxicity: 0.90
      bias: 0.85
      answer_similarity: 0.80
      hallucination: 0.05
    ciGate: true
```

## JSONL sample format

Each line in a dataset file is a JSON object. All fields except `input` and `expected` are optional.

```jsonl
{"input": "What is RAG?", "expected": "Retrieval Augmented Generation", "context": ["RAG combines a retrieval step..."], "tags": ["basics"]}
{"input": "How does vector search work?", "expected": "By comparing embedding distances", "context": ["Vectors are high-dimensional..."], "reference_contexts": ["Embeddings encode semantic meaning..."], "tags": ["rag", "advanced"], "metadata": {"difficulty": "medium"}}
```

| Field | Required | Description |
|---|---|---|
| `input` | yes | User query sent to the agent |
| `expected` | yes | Expected output — used for `answer_similarity` and `string_match` scoring |
| `context` | for RAG metrics | Retrieved chunks the agent used. Required for `faithfulness`, `context_precision`, `hallucination` |
| `reference_contexts` | for `context_recall` | Ground-truth relevant chunks. Required for `context_recall` |
| `tags` | no | Labels for filtering with `--tag` |
| `metadata` | no | Arbitrary key/value pairs reported in output (e.g. `{"difficulty": "hard", "source": "prod-logs"}`) |

## Which metrics need which fields

| Metric | `context` | `reference_contexts` |
|---|---|---|
| `answer_similarity` | no | no |
| `answer_relevancy` | no | no |
| `hallucination` | yes | no |
| `faithfulness` | yes | no |
| `context_precision` | yes | no |
| `context_recall` | yes | yes |
| `toxicity` | no | no |
| `bias` | no | no |

If a dataset declares a RAG metric but its samples have no `context` field, the evaluation framework will error or return meaningless scores. Splitting by concern prevents this.

## Running a dataset

```bash
# Run all samples
agentspec evaluate agent.yaml --url http://localhost:4000 --dataset rag-quality

# Run 20 random samples
agentspec evaluate agent.yaml --url http://localhost:4000 --dataset rag-quality --sample-size 20

# Run only samples tagged "advanced"
agentspec evaluate agent.yaml --url http://localhost:4000 --dataset rag-quality --tag advanced

# Machine-readable output
agentspec evaluate agent.yaml --url http://localhost:4000 --dataset safety --json
```

Exit code `1` when `ciGate: true` and any metric falls below its threshold.

## Recommended file layout

```
evals/
  rag.jsonl          # faithfulness, context_recall, answer_relevancy
  safety.jsonl       # toxicity, bias
  accuracy.jsonl     # answer_similarity, hallucination
  regression.jsonl   # string_match on known Q&A pairs (no context needed)
```

One JSONL per concern keeps datasets independently runnable, independently versionable, and easy to extend without touching other test suites.

## See also

- [`agentspec evaluate` CLI reference](../reference/cli.md#agentspec-evaluate)
- [Probe coverage & evidence tiers](../concepts/probe-coverage.md)
- [CI integration](./ci-integration.md)
