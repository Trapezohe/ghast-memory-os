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
tarball, installs that tarball into a fresh consumer project, runs minimal SDK,
agent adapter, host adapter, local HTTP, MCP router, installed public CLI smoke
checks for `gmos`, `ghast-memory`, and `gmos-inspect`, plus backup/restore,
evolution review, doctor, status, and inspector checks from the installed package,
including content-safety, forget-residue, evidence eligibility, failure-summary,
health, and reconstruction-counter validation,
and writes:

- `manifest.json` with package version, git SHA, dirty status, invocation
  command, runtime, CI policy, command status, artifact paths, tarball size,
  sha512, and npm-style SRI integrity;
- `SUMMARY.md` with artifact metadata, check status, CI trigger policy, claim
  boundaries, and known limitations;
- stdout/stderr logs for each command.

The output directory is git-ignored. Do not use `--skip-gate`,
`--skip-fresh-install`, or `--allow-dirty` for public release evidence. Those
flags exist only for local diagnostics and script smoke tests.

## Memory Gym

Memory Gym checks SDK architecture, safety contracts, and experience-learning
horizon behavior:

```bash
gmos gym run --db :memory: --generated-seeds 3 --format json
gmos gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
gmos gym scale --sizes 100,1000 --threshold-p95-ms 250 --format json
```

It validates behavior such as preference recall, do-not-push policy,
secret-like rejection, incognito exclusion, forget residue, read-path purity,
active reconstruction, temporal current/history behavior, host compatibility,
and the default `experience_horizon` group.

`experience_horizon` runs deterministic fixed-clock simulations across eight
or more simulated weeks. The group checks preference reinforcement, boundary
non-decay, unused low-confidence fact decay, full-surface forgetting residue,
current-vs-history contradiction handling, and repeated procedure reuse. The
report includes `experienceHorizon` with per-scenario pass/fail results,
diagnostic counters, and a deterministic replay meta-gate. It is an SDK
engineering gate, not proof of mature digital twin capability.

## Release-Signal Scale Profile

The PR gate keeps scale smoke small. Release candidates should also record a
larger scale signal outside `gate:pr`:

```bash
gmos gym scale --sizes 10000 --threshold-p95-ms 2000 --ingest-threshold-p95-ms 100 --ingest-last-to-first-factor 8 --format json
```

Release machines may also run the documented 100k target:

```bash
gmos gym scale --sizes 100000 --threshold-p95-ms 1500 --ingest-threshold-p95-ms 150 --ingest-last-to-first-factor 10 --format json
```

The 100k profile is not a sandbox or PR-gate requirement. Publish the JSON
output with release evidence when using it as a release signal.

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

Every external report carries a protocol label:

- `deterministic_local`: default offline adapter scoring. This is the local
  reproducible baseline and never calls a model judge.
- `official_protocol`: host-provided judge scoring. This is available through
  the SDK runner when the host passes a judge callback; gmOS never makes
  network calls itself.

The CLI can run `deterministic_local` only:

```bash
gmos gym external \
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --protocol deterministic-local \
  --format json
```

If `--protocol official-protocol` is passed to the CLI, the command refuses
with a clear error instead of downgrading to lexical scoring.

Host SDK official-protocol sketch:

```ts
import { runExternalMemoryBenchmark } from "@ghast/memory/gym";

const report = await runExternalMemoryBenchmark({
  cases,
  protocol: "official_protocol",
  judge: {
    name: "host-fixed-judge-v1",
    async judge(question, expectedAnswer, actualAnswer) {
      return {
        correct: await hostJudge(question, expectedAnswer, actualAnswer),
        rationale: "host judge rationale",
      };
    },
  },
});
```

The judge receives only benchmark dataset content (`question`,
`expectedAnswer`) plus the answer text produced by the gmOS runtime
(`actualAnswer`). It does not receive gmOS memory ids, evidence ids, source
metadata, profile ids, or store handles.

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

## Running With The Intelligence Layer

`gmos gym external` can attach the opt-in `@ghast/memory/intelligence` hook
bundle for benchmark runs. This is host-side wiring: the CLI makes real network
calls only because the user provided an intelligence endpoint for this benchmark
run. The kernel still never discovers or calls a network service on its own.

Use `--ingest-mode memory` for the legacy deterministic direct-import path. Use
`--ingest-mode message` when running LongMemEval or LoCoMo through the
extractor path; adapter turns become conversation observations, timestamps are
preserved, and speaker metadata is carried where the dataset provides it.

Local Ollama-style OpenAI-compatible endpoint:

```bash
gmos gym external \
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --ingest-mode message \
  --intelligence-base-url http://127.0.0.1:11434/v1 \
  --intelligence-model llama3.1 \
  --intelligence-embed-model nomic-embed-text \
  --intelligence-concurrency 2 \
  --intelligence-timeout-ms 20000 \
  --format json
```

OpenAI-compatible cloud endpoint:

```bash
export GMOS_BENCH_API_KEY="..."
gmos gym external \
  --input-file ./multi-session-memory.json \
  --dataset-format locomo \
  --ingest-mode message \
  --intelligence-base-url https://provider.example/v1 \
  --intelligence-model provider-chat-model \
  --intelligence-embed-model provider-embedding-model \
  --intelligence-api-key-env GMOS_BENCH_API_KEY \
  --maintain-phases decay \
  --format json
```

Never pass an API key as a flag value. The CLI accepts only the environment
variable name via `--intelligence-api-key-env`; reports record that env var name
and the endpoint hostname only, not the secret or full URL.

Privacy boundary: benchmark dataset content is sent to the configured endpoint.
Do not run this mode on real personal profiles or private user histories unless
that endpoint is approved for that data.

Claim boundary: intelligence-backed `deterministic_local` runs are still local
adapter scores. They are not official-protocol scores unless the SDK run uses a
host-provided judge and the manifest says `officialProtocol=host_judge`.

## Adapter Baseline Archives

Public docs should describe how to reproduce a run and how to interpret its
score. Current baseline numbers belong in release evidence or a benchmark run
archive with the git SHA, dataset hash, command, options, and failure samples.
Older snapshots that lack those fields must mark them as not recorded.
Do not treat local deterministic adapter scores as official LongMemEval or
LoCoMo protocol scores. Reports and manifests must show
`protocol=deterministic_local`, `officialProtocol=not_run`, and
`comparableToOfficialScore=false` for those baselines. Datasets are not vendored in this repository. See
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
- deterministic adapter score (`protocol=deterministic_local`);
- official protocol score (`protocol=official_protocol`, `officialProtocol=host_judge`);
- judge provenance;
- setup/runtime ingestion cost;
- scoring runtime;
- diagnostics runtime;
- failure-stage taxonomy.

Low scores are useful only when they identify general memory capability gaps:
extraction, evidence, speaker/person/entity grounding, temporal current/history
state, reconstruction, context composition, safety, action policy, or feedback.

## Claim Rules

- Do not call deterministic adapter results official benchmark scores.
- Do not quote a report as official unless its manifest says
  `protocol=official_protocol`, `officialProtocol=host_judge`, and names the
  judge.
- Do not claim SOTA without the official dataset, official or strictly
  equivalent runner, fixed model/judge settings, and a public reproduction
  bundle.
- Do not omit current reproducible baseline results when they are the current
  state.
- Do not improve scores by weakening secret, incognito, PERSON, forget,
  sensitive, or do-not-push gates.
