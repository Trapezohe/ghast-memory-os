# gmOS Benchmark Guide

gmOS benchmarks are diagnostic tools. They are not the product goal and must not
drive benchmark-specific runtime branches.

## Required PR Gate

Run before committing code:

```bash
npm run gate:pr
```

The gate runs:

- TypeScript build and unit/integration tests;
- quickstart, host adapter, HTTP adapter, MCP router, and external mini
  examples;
- no-benchmark-special-casing scan;
- consumer install smoke;
- deterministic Memory Gym smoke;
- external fixture smoke;
- release gate;
- scale smoke;
- npm pack dry run.

## Memory Gym

Memory Gym checks internal architecture and safety contracts:

```bash
gmos gym run --db :memory: --generated-seeds 3 --format json
gmos gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
gmos gym scale --sizes 100,1000 --threshold-p95-ms 250 --format json
```

It validates behavior such as preference recall, do-not-push policy,
secret-like rejection, incognito exclusion, forget residue, read-path purity,
active reconstruction, temporal current/history behavior, and host
compatibility. It is an internal engineering gate, not proof of mature digital
twin capability.

## External Adapters

`gmos gym external` supports:

- `gmos`: native deterministic JSONL;
- `longmemeval`: local LongMemEval JSON/JSONL adapter;
- `locomo`: local LoCoMo JSON/JSONL adapter.

Adapters may map input schema, normalize answers, score outputs, and write
reports. They must not write expected answers, category labels, `has_answer`,
dataset names, case IDs, or forbidden answers into runtime memory or evidence.

Example:

```bash
npm run examples:external-mini
```

The external mini example uses `examples/external-mini-fixture.jsonl` and the
native deterministic adapter. It is a local smoke test for report generation,
score semantics, slice scores, and failure taxonomy wiring. It is not an
official benchmark score and is not comparable to LongMemEval or LoCoMo
leaderboards.

Larger local run:

```bash
gmos gym external \
  --input-file ./longmemeval_s_cleaned.json \
  --dataset-format longmemeval \
  --format json \
  --json-file ./longmemeval.json \
  --markdown-file ./longmemeval.md \
  --diagnostics-level full \
  --progress
```

## Report Interpretation

External reports should separate:

- strict score;
- normalized evidence score;
- deterministic adapter score;
- official protocol score;
- setup/runtime ingestion cost;
- scoring runtime;
- diagnostics runtime;
- failure-stage taxonomy.

Low scores are useful only when they identify general memory capability gaps:
extraction, evidence, speaker/person/entity grounding, temporal current/history
state, reconstruction, context composition, safety, action policy, or feedback.

## Claim Rules

- Do not call deterministic adapter results official benchmark scores.
- Do not claim SOTA without the official dataset, official or strictly
  equivalent runner, fixed model/judge settings, and a public reproduction
  bundle.
- Do not hide weak baseline results when they are the current reproducible
  state.
- Do not improve scores by weakening secret, incognito, PERSON, forget,
  sensitive, or do-not-push gates.
