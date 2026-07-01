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
- extraction boundary scan;
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
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --format json \
  --json-file ./longmemeval.json \
  --markdown-file ./longmemeval.md \
  --diagnostics-level full \
  --progress
```

## Adapter Baseline Archives

Public docs should describe how to reproduce a run and how to interpret its
score. Current baseline numbers belong in release evidence or a benchmark run
archive with the git SHA, dataset hash, command, options, and failure samples.
Older snapshots that lack those fields must mark them as not recorded.
Do not treat local deterministic adapter scores as official LongMemEval or
LoCoMo protocol scores. Datasets are not vendored in this repository. See
[benchmark runs](./BENCHMARK_RUNS.md) for tracked local baseline snapshots.

## Protocol Bridges

`gmos gym statebench` prepares an optional STATE-Bench Agent Learning Track hook
and result summary. It is a bridge, not a replacement for the official runner:
comparable numbers still require the unchanged STATE-Bench protocol, fixed
evaluator/simulator setup, and a reproducible manifest.

Minimal bridge flow:

```bash
gmos gym statebench build-learnings --domain <domain> --input-dir ./STATE-Bench/datasets/train_task_trajectories/<domain> --output-file ./outputs/gmos-learnings/<domain>.json
gmos gym statebench prepare --checkout-dir ./STATE-Bench --domain <domain> --agent-model-name <model-name> --manifest-file ./outputs/gmos-learnings/<domain>.prepare.json
gmos gym statebench summarize --checkout-dir ./STATE-Bench --domain <domain> --metrics-file ./outputs/<domain>/metrics.json --prepare-manifest ./outputs/gmos-learnings/<domain>.prepare.json
```

Run the official STATE-Bench `run_batch` and `compute_metrics` commands from
the prepare manifest before publishing comparable results.

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
- Do not omit current reproducible baseline results when they are the current
  state.
- Do not improve scores by weakening secret, incognito, PERSON, forget,
  sensitive, or do-not-push gates.
