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
- `official_protocol` + `officialProtocol=host_judge_context`: host-provided
  judge scoring over the sanitized context. This checks the M6a judge wiring,
  but it is not leaderboard-comparable because there is no reader step.
- `official_protocol` + `officialProtocol=host_reader_and_judge`: host-provided
  reader plus judge. The reader receives only the question and sanitized context,
  generates an answer, and the judge scores that generated answer. This is the
  only gmOS external mode that can be compared to reader+judge leaderboard
  protocols, assuming the dataset, judge, prompt, and settings also match.

The CLI can run `deterministic_local` only:

```bash
gmos gym external \
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --protocol deterministic-local \
  --format json
```

Claim ladder: `deterministic_local` < `host_judge_context` <
`host_reader_and_judge`. Do not compare a lower rung to leaderboard claims.

### Judge profiles

OpenAI-compatible CLI judges support `--judge-profile strict|official`.
`strict` is the default and remains the internal regression profile. It uses the
original strict gmOS judge prompt and is best for tracking whether a local change
moves the gmOS baseline.

`official` is for external comparisons where the published protocol uses a
lenient model judge: lenient on phrasing, formatting, equivalent units, and extra
correct detail, but strict on factual correctness. If the expected answer is
unavailable or unanswerable, an answer that declines or states the missing
information is correct; a fabricated specific answer is incorrect.

Reports and manifests record `judgeProfile` alongside protocol, judge
provenance, and `comparableToOfficialScore`. Publish both the score and the
judge profile. Internal regression tables should use `strict`; apples-to-apples
external comparisons should use `official` only when the rest of the protocol,
reader, judge model, and settings match. SDK host-provided judge objects must
implement their own rubric; `judgeProfile` applies only to gmOS-created
OpenAI-compatible judges.

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

Reader-mode SDK sketch:

```ts
import { runExternalMemoryBenchmark } from "@ghast/memory/gym";

const report = await runExternalMemoryBenchmark({
  cases,
  protocol: "official_protocol",
  answerer: {
    name: "host-reader-v1",
    async answer(question, context) {
      return hostReader(question, context);
    },
  },
  judge: {
    name: "host-fixed-judge-v1",
    async judge(question, expectedAnswer, generatedAnswer) {
      return {
        correct: await hostJudge(question, expectedAnswer, generatedAnswer),
      };
    },
  },
});
```

The answerer receives only `question` and the same sanitized context that would
be sent to the judge in judge-only mode. gmOS removes internal ids and
reconstruction diagnostics before calling the answerer. Generated answers are
recorded per case with a bounded length for failure analysis.

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
  --reader-profile expansive \
  --format json \
  --json-file ./longmemeval.json \
  --markdown-file ./longmemeval.md \
  --diagnostics-level full \
  --progress
```

Use `--reader-profile expansive` for official reader-style runs where the
reader needs enough dated context to answer temporal ordering or duration
questions. The flag keeps CLI defaults unchanged for ordinary runs, but when
selected it sets `maxSteps=8`, `maxBranch=10`, `maxMemories=24`, and
`contextBudgetTokens=4000` unless the matching `--max-*` or
`--context-budget-tokens` flag is explicitly provided. This trades latency for
anchor coverage in reader runs. Reports and manifests record `readerProfile`
plus the effective budget values.

Use `--reader-profile wide` when the benchmark reader needs high supply
bandwidth, such as LongMemEval-style stores with distilled session summaries,
extraction atoms, and raw turn memories competing for the same read. It sets
`maxSteps=8`, `maxBranch=10`, `maxMemories=200`,
`contextBudgetTokens=8000`, `maxCharsPerMemory=400`, and
`layerPolicy={ summaryMinShare: 0.3, turnMaxShare: 0.4 }`. Explicit
`--max-memories` and `--context-budget-tokens` still override those two values.
Use the default profile for scale smoke gates unless a run is intentionally
measuring wide-reader latency.

Paid smoke workflow:

```bash
gmos gym external \
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --protocol official-protocol \
  --ingest-mode message \
  --max-cases 5 \
  --results-jsonl ./paid-smoke.results.jsonl \
  --json-file ./paid-smoke.json \
  --markdown-file ./paid-smoke.md \
  --progress
```

Start with a slice. `--max-cases <n>` runs the first `n` parsed cases,
`--case-offset <n>` skips the first `n` parsed cases, and
`--case-ids <id,id>` selects exact case ids. Reports and manifests record the
slice as `slice.sliceSpec`, `totalDatasetCases`, and `executedCases`; markdown
headers show `SLICE n/m`. A sliced or interrupted run is partial and must not be
published as a full benchmark result.

Use `--results-jsonl <file>` on paid runs. The CLI appends one JSON line as
each case completes, including the generated answer, judge result/rationale,
timing, retrieved-memory count, extraction stats, and official failure
attribution. Each line also includes `readerContext`, the sanitized context sent
to the answerer, capped by `--reader-context-char-limit` (default `4000`; `0`
disables). If the process is interrupted after case 16, the first 16 case
artifacts are still on disk.

SIGINT/SIGTERM on `gmos gym external` stops dispatching new work, lets the
current in-flight case finish through the normal timeout path, then writes the
same JSON, markdown, and reproduction-bundle artifacts with `partial: true`.
The suite runner accepts partial reports, but marks the suite
`benchmarkPass=false` so partial output cannot be mistaken for a full run.

## Running With The Intelligence Layer

`gmos gym external` can attach the opt-in `@ghast/memory/intelligence` hook
bundle for benchmark runs. This is host-side wiring: the CLI makes real network
calls only because the user provided an intelligence endpoint for this benchmark
run. The kernel still never discovers or calls a network service on its own.

Use `--ingest-mode memory` for the legacy deterministic direct-import path. Use
`--ingest-mode message` when running LongMemEval or LoCoMo through the
extractor path; adapter turns become conversation observations, timestamps are
preserved, and speaker metadata is carried where the dataset provides it. In
message mode gmOS uses `ingestConversation()` with windowed extraction:
extractor calls are `ceil(eligible_messages / --extraction-window)` per session
boundary, not one call per message. The default window is `12` messages.
Message-mode benchmark ingest also enables turn retention by default: each
eligible raw turn is retrievable as a low-confidence `fact` memory alongside
the extracted atoms. This measures the layered storage bound for answerability,
because extraction can miss facts that direct import would keep. Use
`--turn-retention off` to measure atoms-only behavior, or `--turn-retention on`
to make the default explicit. SDK and host transcript ingestion default this
option off so production hosts consciously trade storage for recall.

Session distillation is a separate message-mode opt-in with
`--session-distill on`. It requires either the intelligence config path or hooks
that provide `sessionDistiller`; memory-mode runs reject it. The hook is called
once per session key inside each ingest batch, using the same
`sessionId`/`sessionKey`/`windowId` boundary as extraction windows. Messages
without a session key share one whole-call fallback group. Each session
distiller input is capped at 24,000 source content characters by default, with
over-cap messages truncated from the tail of that session input. The hook writes
compact dated `fact` memories at default confidence `0.6`, so aggregation
questions can retrieve per-session enumerations instead of many scattered raw
turns. The cost is one extra model call per session. Use it for multi-session
totals, counts, purchases, durations, and other questions where every instance
matters. Leave it off for cheap deterministic baselines.

Message-mode extraction defaults to `["user", "assistant"]` so answer-bearing
assistant turns in LongMemEval are extractable. LoCoMo still maps both speakers
to user-role messages with speaker metadata.

For LongMemEval cleaned S, roughly 150k eligible messages means about 12.5k
extractor calls at window 12 instead of 150k calls. At
`--intelligence-concurrency 16`, setup is bounded by model latency over windows,
not by per-turn serial extraction. Use lower concurrency for small local models
or providers with strict rate limits.

Intelligence calls retry transport failures by default: HTTP `429`, HTTP `5xx`,
timeouts, and network errors get `--intelligence-retries 2` with exponential
backoff and jitter. `Retry-After` is honored when the provider sends it.
`--intelligence-backoff-ms` changes the initial backoff. The call-level
`--intelligence-timeout-ms` remains the total budget for one hook call, so
retries do not multiply a stuck window's wall time.

Recommended provider setup flow:

1. Run one case first with `--max-cases 1 --progress --intelligence-debug-dir ./gmos-debug`.
2. Inspect the bounded JSON samples in that directory: request prompt, raw
   response text, selected completion text, parse outcome, and retry count.
   Files never include Authorization headers or API keys. Empty windows are
   sampled too: the first five `ok_empty` windows are written so you can tell
   "truly no durable facts" from prompt/cap starvation.
3. Fix provider flags before scaling. Thinking models may return useful JSON in
   `reasoning_content`, but if they return reasoning without JSON the run will
   count `extractionParseFailureCount` instead of silently producing zero
   candidates. Prefer `--intelligence-disable-thinking` for providers that
   support it. Markdown fences and prose around JSON are tolerated.
4. Scale only after the one-case probe shows nonzero candidates or an expected
   `extractionEmptyCount`.

For retrieval-vs-extraction probes, add `--debug-dump-memories <n>` with
`--intelligence-debug-dir`. gmOS writes the first `n` extracted memories per
case group with id, kind, redacted content, and temporal label. Official reader
failures also write bounded `reader-context-*` files into the same directory;
`--debug-context-failure-limit` caps their count.

Provider embeddings affect retrieval only when query embedding is active. When
an embedding provider is configured, external benchmark scoring reads default
to `embedQuery=true`; use `--embed-query off` to force lexical/association
retrieval, or `--embed-query on` to make the opt-in explicit. Manifests record
the effective `runtimeIntelligence.embedQuery` and
`queryEmbeddingFailureCount`; failures fall back to lexical retrieval.

Query planning defaults OFF: a measured 30-case comparison showed
model-derived required anchors regressing the reader score (0.30 -> 0.17)
because anchor-matched memories displaced whole-question-relevant ones and
per-anchor embeddings amplified transport failures. The planner is a host-side
hook that sees the question as data and may return
`requiredAnchors: [{ cue, hint? }]`; gmOS then asks the kernel to satisfy those
anchors during reconstruction. Use `--query-planner on` to opt in (kernel-side
requiredAnchors declared directly by a host remain fully supported and are the
recommended form when the host knows the endpoints). `--planner-model` and
`--planner-base-url` override only the planner model/endpoint and still use the
env-only key from `--intelligence-api-key-env`. Manifests disclose
`runtimeIntelligence.queryPlanner` and `failureCount`, and per-case results
record derived anchors and unmet counts.

Distiller overrides follow the planner override shape. `--distiller-base-url`
and `--distiller-model` must be provided together. When base intelligence is
configured, these flags override only the session distiller endpoint/model. If
there is no base intelligence, the paired distiller flags build only the
session distiller hook for `--session-distill on`.

SDK raw-hook runs can set top-level `intelligenceTimeoutMs` and
`intelligenceConcurrency` on `runExternalMemoryBenchmark`. These control the
shared wrapper around extraction, distillation, embedding, reranking, and
planner hooks; explicit top-level values win over matching intelligence config
fields, and manifests record the effective `runtimeIntelligence.timeoutMs` and
`runtimeIntelligence.concurrency`.

Aggregation sweeps are separately opt-in with `--sweep-cues on`. This switch
also calls the query planner, but consumes only `sweepCues` and leaves
planner-derived `requiredAnchors` ignored unless `--query-planner on` is set.
The design is additive because the prior planner regression came from
displacement: anchors changed which ordinary memories fit. Sweep cues run after
ordinary reconstruction, append a separate dated section, and use a sweep-only
budget slice, so ordinary retrieval and culling remain unchanged. Manifests
record `runtimeIntelligence.sweepCues`; case results record the cues used and
the number of sweep lines included.

Reader-baseline runs can use a planner-only endpoint without enabling
extraction, embeddings, or reranking:

```bash
gmos gym external \
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --ingest-mode memory \
  --query-planner on \
  --sweep-cues on \
  --planner-base-url https://provider.example/v1 \
  --planner-model planner-model \
  --intelligence-api-key-env GMOS_BENCH_API_KEY
```

With `--progress`, message-mode setup prints content-free window progress every
10 windows and at completion: windows done/total, outcome counts, extracted
candidate count so far, turn-memory count, distilled-memory count, retry count,
outcome character totals, elapsed time, and rough ETA. Runtime manifests
include `runtimeIntelligence.turnRetention`,
`runtimeIntelligence.sessionDistillation`, per-group `turnMemoryCount`,
per-group `distilledMemoryCount`,
`extractionRetryCount`,
`extractionEmptyCount`, `extractionParseFailureCount`,
`extractionTransportFailureCount`, outcome character totals such as
`extractionOkWithCandidatesCharCount` and `extractionEmptyCharCount`, alongside
`extractionFailureCount`. Failed windows are replayed once after the ingest pass
by default; `--ingest-replay-attempts 0` disables it. Progress, reports, and
manifests include `replayedWindowCount` and `replayRecoveredCount`, and
recovered windows are removed from `extractionFailedWindowIndexes`.

## Ingest Cache

Use `--ingest-cache-dir <dir>` when repeating the same ingest with different
reader, judge, context-budget, planner, or reporting settings:

```bash
gmos gym external \
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --ingest-mode message \
  --intelligence-base-url http://127.0.0.1:11434/v1 \
  --intelligence-model llama3.1 \
  --ingest-cache-dir ./.gmos-ingest-cache \
  --progress
```

The cache stores the pre-maintain, pre-read SQLite file for each case group.
On a hit gmOS copies the cached `.db` into that group's temp directory, verifies
the SQLite schema version, skips ingest, and then runs maintain/read/scoring on
the temp copy as usual. The cache entry is never mutated by answering. Cache-hit
groups report ingestion counters such as extraction, embedding, replay, and
distillation calls as zero; `cacheHit=true` records that those diagnostics were
skipped, while scores, failure attribution, lexical ceiling, and context checks
still come from the copied store.

The key is `sha256` over:

- package version and SQLite schema version;
- dataset format, group profile id, case count, event count, and a hash of the
  canonical JSON for the group's case ids, event times, and event payloads;
- ingest mode, turn retention, extraction window, ingest replay attempts,
  extraction concurrency, extractor name/model/host, and hook timeout/retry
  settings;
- session-distillation enabled/name/model/host;
- embedding provider name, embed model, host, and dimensions.

The sidecar `<key>.meta.json` records these non-secret fields plus created-at
and package info. Event content is recorded only as hashes. Entries invalidate
when any key field changes. Reader-only settings are not part of the key because
they run after the cached ingest copy is loaded. Corrupt cache files or schema
mismatches are treated as misses and overwritten after a fresh ingest.

Local Ollama-style OpenAI-compatible endpoint:

```bash
gmos gym external \
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --ingest-mode message \
  --extraction-window 12 \
  --ingest-replay-attempts 1 \
  --intelligence-base-url http://127.0.0.1:11434/v1 \
  --intelligence-model llama3.1 \
  --intelligence-embed-model nomic-embed-text \
  --intelligence-concurrency 2 \
  --intelligence-timeout-ms 20000 \
  --intelligence-retries 2 \
  --intelligence-backoff-ms 250 \
  --intelligence-debug-dir ./gmos-debug \
  --embed-query on \
  --progress \
  --format json
```

OpenAI-compatible cloud endpoint:

```bash
export GMOS_BENCH_API_KEY="..."
gmos gym external \
  --input-file ./multi-session-memory.json \
  --dataset-format locomo \
  --ingest-mode message \
  --extraction-window 12 \
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

## Reader Mode

Reader mode adds a host-side answerer before the judge. Use it when comparing
against protocols where a model reads retrieved context and emits an answer
before a model judge scores the answer.

Local Ollama-style reader and judge:

```bash
gmos gym external \
  --input-file ./long-memory-cleaned.json \
  --dataset-format longmemeval \
  --protocol official-protocol \
  --answerer-base-url http://127.0.0.1:11434/v1 \
  --answerer-model llama3.1 \
  --judge-profile official \
  --format json
```

OpenAI-compatible cloud reader and judge:

```bash
export GMOS_BENCH_API_KEY="..."
gmos gym external \
  --input-file ./multi-session-memory.json \
  --dataset-format locomo \
  --protocol official-protocol \
  --answerer-base-url https://provider.example/v1 \
  --answerer-model provider-reader-model \
  --answerer-api-key-env GMOS_BENCH_API_KEY \
  --judge-profile official \
  --format json
```

When only `--answerer-model` is provided, the answerer uses the
`--intelligence-base-url` and `--intelligence-api-key-env` endpoint. This keeps
reader and extraction runs on the same disclosed host while still recording the
reader model separately.

For CLI runs, the configured OpenAI-compatible endpoint is also the host-side
judge endpoint. SDK users who need a custom judge prompt, retry policy, or
rubric should pass explicit `judge` and `answerer` callbacks instead.

Privacy boundary: benchmark dataset content is sent to the configured endpoint.
Do not run this mode on real personal profiles or private user histories unless
that endpoint is approved for that data.

Claim boundary: intelligence-backed `deterministic_local` runs are still local
adapter scores. Judge-only official runs are still not leaderboard-comparable.
Only reader+judge runs may be described as official-protocol comparable, and
only when the manifest says `officialProtocol=host_reader_and_judge`. If query
planning is enabled, it is part of the disclosed intelligence stack, not a hidden
benchmark shortcut. Always state `judgeProfile`; use `strict` for gmOS internal
regression tracking and `official` for published comparisons that need the
lenient official-style rubric.

Before scaling a paid reader+judge run, read the markdown attribution table.
Official failures are bucketed deterministically:

- `answerer_or_judge_stage`: gold terms were present in sanitized context, but
  the reader/judge result was wrong.
- `retrieval_stage`: gold terms were in raw input and stored memory, but absent
  from the sanitized context.
- `extraction_stage`: message-mode only; gold terms were in raw input but absent
  from all stored memories for the case group.
- `input_stage`: gold terms were absent from raw input, so the reader would have
  to synthesize rather than recall.

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
- judge-only official score (`officialProtocol=host_judge_context`);
- reader+judge official score (`officialProtocol=host_reader_and_judge`);
- lexical ceiling and reachable score for deterministic reports;
- judge provenance;
- judge profile;
- answerer provenance when reader mode is enabled;
- setup/runtime ingestion cost;
- scoring runtime;
- diagnostics runtime;
- failure-stage taxonomy.

Low scores are useful only when they identify general memory capability gaps:
extraction, evidence, speaker/person/entity grounding, temporal current/history
state, reconstruction, context composition, safety, action policy, or feedback.

## Claim Rules

- Do not call deterministic adapter results official benchmark scores.
- Do not quote a report as leaderboard-comparable unless its manifest says
  `protocol=official_protocol`, `officialProtocol=host_reader_and_judge`, and
  names both the answerer and judge.
- Do not publish an external comparison without the recorded `judgeProfile`.
- Do not claim SOTA without the official dataset, official or strictly
  equivalent runner, fixed model/judge settings, and a public reproduction
  bundle.
- Do not omit current reproducible baseline results when they are the current
  state.
- Do not improve scores by weakening secret, incognito, PERSON, forget,
  sensitive, or do-not-push gates.
