# Phase 5 — `agentspec scan` + `agentspec diff`

**Status: ✅ DONE**
**Depends on:** Phase 1 (existing `agentspec generate` command and adapter-claude skills)

---

## Goal

Complete the **bi-directional loop** between source code and `agent.yaml`:

```
Code  ──(agentspec scan)──▶  agent.yaml  ──(agentspec generate)──▶  Deployment manifests
  ▲                                                                         │
  └──────────────────(agentspec diff)──────────────────────────────────────┘
                    (drift detection)
```

Currently `agentspec generate` goes manifest → code (right half). This phase adds:
- `agentspec scan` — code → manifest (left half, Claude-powered)
- `agentspec diff` — detect drift between two manifests (deterministic, no Claude)

Together they give teams **compliance-as-code**: the manifest is always in sync with the
running agent, and deviations trigger visible grade changes in k9s.

---

## Why This Phase

Without scan, teams must write `agent.yaml` by hand — high friction, often skipped.
With scan, the manifest is generated from existing code in seconds. Diff makes the
manifest a living document rather than a one-time artifact: changes to code are
immediately visible as score deltas, preventing silent compliance degradation.

This also enables the wow-3 and wow-4 UAT demos.

---

## Deliverables

| Deliverable | File(s) | Status |
|-------------|---------|--------|
| `agentspec scan` CLI command | `packages/cli/src/commands/scan.ts` | ✅ |
| Claude skill for source analysis | `packages/adapter-claude/src/skills/scan.md` | ✅ |
| `agentspec diff` CLI command | `packages/cli/src/commands/diff.ts` | ✅ |
| Compliance diff scoring table | `packages/cli/src/utils/diff-score.ts` | ✅ |
| CLI tests for scan + diff | `packages/cli/src/__tests__/scan.test.ts`, `diff.test.ts` | ✅ |
| UAT guides update (wow-3, wow-4) | `packages/operator/uat/wow-3-source-scan.md`, `wow-4-drift-detection.md` | ⬜ |

---

## Files to Create / Modify

### New files
- `packages/cli/src/commands/scan.ts` — `agentspec scan -f <dir>` command
- `packages/cli/src/commands/diff.ts` — `agentspec diff <file1> <file2>` command
- `packages/cli/src/utils/diff-score.ts` — per-property compliance impact table
- `packages/adapter-claude/src/skills/scan.md` — Claude skill for source analysis
- `packages/cli/src/__tests__/scan.test.ts`
- `packages/cli/src/__tests__/diff.test.ts`

### Modified files
- `packages/cli/src/index.ts` — register `scan` and `diff` commands
- `packages/cli/package.json` — no new deps (scan uses existing `generateWithClaude`)

---

## `agentspec scan` Design

### CLI interface

```bash
agentspec scan -f ./src/
agentspec scan -f ./src/ --out agent.yaml          # explicit output path
agentspec scan -f ./src/ --update                  # update existing agent.yaml in place
agentspec scan -f ./src/ --dry-run                 # print to stdout, don't write
```

**Behavior:**
- If `agent.yaml` does NOT exist → write `agent.yaml`
- If `agent.yaml` EXISTS and `--update` NOT set → write `agent.yaml.new`
- If `agent.yaml` EXISTS and `--update` SET → overwrite `agent.yaml`
- `--dry-run` always prints to stdout regardless of existing files

### Implementation

`scan.ts` mirrors `generate.ts` but inverts the flow:

```typescript
// generate.ts flow:   agent.yaml → (Claude) → code files
// scan.ts flow:       src files  → (Claude) → agent.yaml

import { generateWithClaude } from '@agentspec/adapter-claude'

export async function scanCommand(srcDir: string, opts: ScanOptions) {
  // 1. Read all .py / .ts / .js files under srcDir (recursive, max 50 files, 200 KB total)
  const sourceFiles = await collectSourceFiles(srcDir)

  // 2. Call Claude with scan.md skill + source files as context
  const result = await generateWithClaude({
    skill: 'scan',
    context: { sourceFiles, existingManifest: opts.existingManifest },
  })

  // 3. Write agent.yaml (or agent.yaml.new)
  const outPath = resolveOutputPath(opts)
  writeFileSync(outPath, result.files['agent.yaml'])

  // 4. Print compliance estimate
  printScanSummary(result)
}
```

### `scan.md` Claude skill (adapter-claude)

The skill instructs Claude to:

1. Read all provided source files
2. Detect: model provider + name (from import + env var pattern)
3. Detect: tools (functions with `@tool`, MCP servers in config)
4. Detect: guardrails (content filters, rate limiters, output validators)
5. Detect: eval hooks (`deepeval`, `pytest`, custom eval calls)
6. Detect: required env vars (any `os.getenv`, `process.env`, `$env:` patterns)
7. Detect: memory backend (vector store imports, Redis, etc.)
8. Detect: services (DB connections, external APIs)
9. Estimate compliance score (0-100) based on what's present/missing
10. Output: valid `agent.yaml` YAML

**Output format constraint**: Claude must return a `files` dict with exactly one key `agent.yaml`.

---

## `agentspec diff` Design

### CLI interface

```bash
agentspec diff agent.yaml agent.yaml.new
agentspec diff agent.yaml agent.yaml.new --json       # machine-readable
agentspec diff agent.yaml agent.yaml.new --exit-code  # exit 1 if drift detected
```

### Implementation: deterministic, no Claude

`diff.ts` loads both manifests, compares field-by-field, annotates each change with:
- `severity`: HIGH / MEDIUM / LOW
- `scoreImpact`: integer delta (negative = compliance loss)
- `description`: human-readable explanation

```typescript
// packages/cli/src/utils/diff-score.ts
// Per-property compliance impact table

export const DIFF_SCORE_TABLE: Record<string, { severity: string; impact: number; description: string }> = {
  'guardrails.content_filter': {
    severity: 'HIGH', impact: -15,
    description: 'Content filtering removed — user input reaches model unfiltered',
  },
  'guardrails.rate_limit': {
    severity: 'HIGH', impact: -10,
    description: 'Rate limiting removed — DoS risk',
  },
  'spec.eval.hooks': {
    severity: 'MEDIUM', impact: -8,
    description: 'Eval hooks removed — regression detection disabled',
  },
  'spec.model.apiKey': {
    severity: 'HIGH', impact: -12,
    description: 'Model API key reference removed',
  },
  'spec.model.name': {
    severity: 'MEDIUM', impact: -5,
    description: 'Model changed — re-evaluate compliance for new model',
  },
  // tools added: no negative impact (but flagged for review)
  'spec.tools[+]': {
    severity: 'LOW', impact: 0,
    description: 'New tool added — verify it does not expose sensitive data',
  },
  // ... full table TBD during implementation
}
```

### Output format

```
agentspec diff — compliance drift analysis
══════════════════════════════════════════════════════
  Comparing: agent.yaml → agent.yaml.new

  REMOVED  guardrails.content_filter        [-15 score]  HIGH
           Content filtering removed — any user input reaches model unfiltered

  ADDED    tools.fetch_external_prices      [+0 score]   LOW
           New tool: fetch_external_prices (no compliance concerns detected)

  Net score change:  -23  (94 → 71, A → C)
  Net grade change:  A → C

  Recommendation: restore guardrails.content_filter before deploying
══════════════════════════════════════════════════════
```

### `--json` output

```json
{
  "from": "agent.yaml",
  "to": "agent.yaml.new",
  "scoreFrom": 94,
  "scoreTo": 71,
  "gradeFrom": "A",
  "gradeTo": "C",
  "netScoreChange": -23,
  "changes": [
    {
      "type": "removed",
      "property": "guardrails.content_filter",
      "severity": "HIGH",
      "scoreImpact": -15,
      "description": "..."
    }
  ]
}
```

---

## Architecture

```
agentspec scan -f ./src/
       ↓
scan.ts  →  collectSourceFiles() (read .py/.ts/.js, cap 50 files / 200 KB)
       ↓
generateWithClaude({ skill: 'scan', context: { sourceFiles } })
  (existing adapter-claude flow — scan.md skill)
       ↓
write agent.yaml  (or agent.yaml.new)
print compliance estimate

agentspec diff agent.yaml agent.yaml.new
       ↓
diff.ts  →  loadManifest() × 2
       ↓
compare fields → DIFF_SCORE_TABLE lookup
       ↓
print human-readable drift report
exit code: 0 (no drift) or 1 (--exit-code flag + drift detected)
```

---

## Acceptance Criteria

### `agentspec scan`
- [x] Given a Python file with `openai` import + `OPENAI_API_KEY` env → `agent.yaml` contains `model.provider: openai`
- [x] Given a file with `@tool` decorator → `agent.yaml` contains the tool name
- [x] Source dir with existing `agent.yaml` → writes `agent.yaml.new` (does not overwrite)
- [x] `--update` flag → overwrites existing `agent.yaml`
- [x] `--dry-run` → prints to stdout only
- [x] File count / size cap: >50 files warns and truncates
- [x] All CLI tests pass: `pnpm test` in `packages/cli/`
- [x] Existing CLI tests still pass (no regression) — 234 total, 47 new

### `agentspec diff`
- [x] Removed guardrail → HIGH severity, negative score delta
- [x] Added tool → LOW severity, zero score delta
- [x] No changes → "No compliance drift detected", exit 0
- [x] `--exit-code` + drift present → exit 1
- [x] `--json` output is valid JSON matching schema
- [x] All diff tests pass

---

## Security Considerations

- Source file collection: resolve symlinks, reject paths escaping `srcDir` (path traversal)
- File size cap: 200 KB total source sent to Claude (cost + prompt injection risk)
- Claude skill output: validate that returned YAML is a valid `agent.yaml` before writing
- `diff.ts`: no code execution — purely structural comparison of two YAML objects

---

## Test Plan

### `scan.test.ts` (unit, mocked Claude)
- Python openai agent → detects model provider
- MCP tools in config → detects tool names
- Guardrails present → score > 60
- No guardrails → score < 50
- Existing agent.yaml → writes .new (not overwrite)
- `--update` flag → overwrites

### `diff.test.ts` (unit, no I/O)
- Identical manifests → no changes, score delta 0
- Removed guardrail → HIGH change, negative delta
- Added tool → LOW change, zero delta
- Model changed → MEDIUM change
- `--json` output matches schema
- `--exit-code` with drift → process exit 1
