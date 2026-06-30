# gmOS Benchmark Guide

gmOS benchmarks are diagnostic tools. They are not the product goal. Low scores
should identify general memory capability gaps, not trigger dataset-specific
runtime branches.

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
- extraction fallback boundary scan;
- consumer install smoke;
- deterministic Memory Gym smoke;
- external fixture smoke;
- release gate;
- scale smoke;
- npm pack dry run.

## Release Evidence Bundle

Run before publishing an alpha, public beta, or release candidate:

```bash
npm run release:evidence -- --output-dir ./release-evidence/<version>-<short-sha>
```

The bundler requires a clean worktree by default, runs `gate:pr`, creates an npm
tarball, installs that tarball into a fresh consumer project, runs minimal SDK
and CLI smoke checks from the installed package, and writes:

- `manifest.json` with package version, git SHA, dirty status, runtime, CI
  policy, command status, and artifact paths;
- `SUMMARY.md` with check status, CI trigger policy, claim boundaries, and known
  limitations;
- stdout/stderr logs for each command.

The output directory is git-ignored. Do not use `--skip-gate`,
`--skip-fresh-install`, or `--allow-dirty` for public release evidence. Those
flags exist only for local diagnostics and script smoke tests.

## Memory Gym

Memory Gym checks SDK architecture and safety contracts:

```bash
gmos gym run --db :memory: --generated-seeds 3 --format json
gmos gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
gmos gym scale --sizes 100,1000 --threshold-p95-ms 250 --format json
```

It validates behavior such as preference recall, do-not-push policy,
secret-like rejection, incognito exclusion, forget residue, read-path purity,
active reconstruction, temporal current/history behavior, and host
compatibility. It is an SDK engineering gate, not proof of mature digital
twin capability.

## External Adapters

`gmos gym external` supports:

- `gmos`: native deterministic JSONL;
- `longmemeval`: local LongMemEval JSON/JSONL adapter;
- `locomo`: local LoCoMo JSON/JSONL adapter.

Adapters may map input schema, normalize answers, score outputs, and write
reports. They must not write expected answers, forbidden/adversarial answers,
evidence ids, category labels, `has_answer`, dataset names, case IDs, session
ids, or adapter trace labels into runtime memory or evidence. Those fields may
appear in benchmark reports and manifests only.

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

## Adapter Baseline Snapshot

Latest local deterministic adapter baseline, alpha.67, 2026-06-29:

| Dataset file | Source format | Scored cases | Deterministic adapter score | Runtime |
| --- | --- | ---: | ---: | ---: |
| `longmemeval_oracle.json` | LongMemEval cleaned oracle | 470 | `0.2404` | 26.3s |
| `longmemeval_s_cleaned.json` | LongMemEval cleaned S | 470 | `0.2532` | 1284.2s |
| `locomo10.json` | LoCoMo full history | 1542 | `0.1089` | 363.4s |

These are local deterministic adapter scores, not official LongMemEval or
LoCoMo protocol scores. Dataset sources:
[LongMemEval cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned),
[LongMemEval GitHub](https://github.com/xiaowu0162/longmemeval), and
[LoCoMo GitHub](https://github.com/snap-research/locomo). Datasets are not
vendored in this repository.

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
