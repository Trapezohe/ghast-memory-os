# Ghast Memory OS

Ghast Memory OS, or gmOS, is a local-first actionable user-world memory runtime
for personal agents.

This repository is the SDK/runtime extraction target for Ghast's memory system.
It is not a vector-memory CRUD wrapper. The public path is:

Project docs: [contributing](./CONTRIBUTING.md), [security and privacy](./SECURITY.md),
[release checklist](./RELEASE_CHECKLIST.md).

```ts
import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const memory = createMemoryOS({
  profileId: "local-user",
  store: createSqliteMemoryStore({ path: "./gmos.db" }),
});

await memory.observe({
  type: "conversation.message",
  profileId: "local-user",
  role: "user",
  content: "以后不要再提醒我这个项目延期了。",
  createdAt: new Date().toISOString(),
});

const prepared = await memory.prepareTurn({
  profileId: "local-user",
  messages: [{ role: "user", content: "这个项目现在怎么办？" }],
});
```

## Current Scope

- Plaintext local SQLite store. No database encryption and no vault integration.
- SQLite FTS-backed recall for query search, with LIKE fallback for tokenizer
  edge cases.
- Search index health reporting and explicit repair for SQLite FTS drift.
- SQLite read-audit snapshots for read-path purity checks. The runtime uses
  trigger-backed table revisions for durable tables and content digests for FTS
  indexes, not only row counts, to catch accidental writes during `prepareTurn`,
  `reconstructContext`, and `explainEvidencePath`.
- SQLite association projection for active reconstruction. It derives
  cue-tag-content edges from existing memory, world belief, and task trajectory
  rows; those associations are an index, not a second source of truth.
- Deterministic world-entity normalization for current-state beliefs. Equivalent
  subjects such as `Atlas project`, `project:atlas`, and `Project Atlas`
  converge before single-cardinality invalidation runs.
- Entity mention metadata for accepted memories and world beliefs. gmOS records
  subject, speaker, alias, and ambient participant mentions for audit, but only
  cue-eligible subject/speaker/alias mentions are projected into strong
  association cues so group participants do not pollute speaker-specific recall.
- Historical recall mode for temporal/current-state questions. Ordinary context
  still suppresses superseded or out-of-window memories, while explicit
  `history` recall can retrieve those past facts without using manage/delete
  search or opening sensitive/person memory.
- Runtime facade: `observe`, `prepareTurn`, `commitOutcome`, `recordFeedback`,
  `reconstructContext`, `explainEvidencePath`, `forget`, `explain`.
- Pluggable extraction pipeline for host-provided structured extractors. The
  built-in rule extractor remains the safe fallback, so hosts can add LLM
  extraction without bypassing evidence, PERSON, secret-like, incognito, or
  forgetting gates.
- Bounded durable-observation fallback extraction. Personal world facts with a
  first-person anchor, including speaker-prefixed first-person statements, plus
  temporal/action signals can become low-confidence memory records; they stay
  memory-only unless a structured predicate is present, so raw observations do
  not flood world belief state.
- Low-level compatibility APIs: `add` and `search` for import, admin, and
  compatibility use cases that cannot emit full host events.
- Safety gates for secret-like content, incognito events, PERSON isolation,
  forgetting, and do-not-push action policies.
- Built-in deterministic Memory Gym smoke benchmark.
- Built-in release gate runner that combines Memory Gym, host compatibility,
  scale, and diagnostics checks for CI/release candidates.
- Host compatibility reports for Ghast, MCP, search-only, and mock L3 adapters.
- Host memory snapshot import for adapters that need to project an existing
  memory store into gmOS.
- Host memory snapshot sync for adapters that need stale imported memories
  archived when the host source changes.
- SQLite profile backup/restore for portable QA reproduction, migration, and
  rollback. Safe backups exclude archived, sensitive, and person memories by
  default; full backups are explicit.
- In-process MCP-style tool router and real MCP stdio server for host/agent
  runtime adapters.
- Local HTTP adapter for hosts that need a small service boundary instead of
  in-process imports or MCP stdio.
- Read-only diagnostics/status report for schema, row counts, failure summary,
  package version, and host compatibility.
- Report-only evolution failure review for clustering failure logs into
  hypotheses and patch candidates without auto-apply or auto-rollout.
- CLI: `gmos`.

## CLI

```bash
npm install
npm run build

node dist/cli/gmos.js init --db ./gmos.db
node dist/cli/gmos.js doctor --db ./gmos.db --host ghast
node dist/cli/gmos.js repair --db ./gmos.db --search-index
node dist/cli/gmos.js repair --db ./gmos.db --associations
node dist/cli/gmos.js status --db ./gmos.db --profile local --host ghast --format markdown
node dist/cli/gmos.js add --db ./gmos.db --profile local --kind preference --text "我喜欢简洁回答"
node dist/cli/gmos.js update --db ./gmos.db --profile local --id memory_xxx --text "我喜欢先讲风险"
node dist/cli/gmos.js delete --db ./gmos.db --profile local --id memory_xxx
node dist/cli/gmos.js clear --db ./gmos.db --profile local --scope global
node dist/cli/gmos.js search --db ./gmos.db --profile local --query "简洁"
node dist/cli/gmos.js search --db ./gmos.db --profile local --query "之前的状态" --purpose history
node dist/cli/gmos.js history --db ./gmos.db --profile local --query "之前的状态"
node dist/cli/gmos.js list --db ./gmos.db --profile local --query "简洁" --status active
node dist/cli/gmos.js get --db ./gmos.db --profile local --id memory_xxx
node dist/cli/gmos.js export --db ./gmos.db --profile local --output-file ./gmos-memory-export.json
node dist/cli/gmos.js import --db ./gmos.db --profile local --input-file ./gmos-memory-export.json
node dist/cli/gmos.js backup --db ./gmos.db --profile local --mode safe --output-file ./gmos-profile-backup.json
node dist/cli/gmos.js restore --db ./new-gmos.db --profile local-restored --input-file ./gmos-profile-backup.json
node dist/cli/gmos.js observe --db ./gmos.db --profile local --text "我喜欢简洁的中文回答。"
node dist/cli/gmos.js observe --db ./gmos.db --profile local --text "我喜欢简洁的中文回答。" --report
node dist/cli/gmos.js prepare --db ./gmos.db --profile local --text "你之后怎么回答我？"
node dist/cli/gmos.js reconstruct --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？"
node dist/cli/gmos.js reconstruct --db ./gmos.db --profile local --text "这个项目之前是什么状态？" --temporal-mode history
node dist/cli/gmos.js explain-path --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？" --include-trace
node dist/cli/gmos.js mcp tools
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.add --input '{"kind":"preference","content":"我喜欢先讲风险"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.search --input '{"query":"先讲风险"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.search --input '{"query":"之前的状态","purpose":"history"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.prepare_context --input '{"text":"你之后怎么回答我？"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.reconstruct_context --input '{"text":"我之前说的项目下一步是什么？"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.explain_evidence_path --input '{"text":"我之前说的项目下一步是什么？","includePlannerTrace":true}'
node dist/cli/gmos.js mcp serve --db ./gmos.db --profile local
node dist/cli/gmos.js http serve --db ./gmos.db --profile local --port 4787 --host ghast --auth-token local-dev-token
node dist/cli/gmos.js evolution report --db ./gmos.db --profile local --format markdown
node dist/cli/gmos.js gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
node dist/cli/gmos.js gym run --db :memory: --generated-seeds 3
node dist/cli/gmos.js gym run --generated-seeds 10 --format markdown --report-file ./memory-gym.md
node dist/cli/gmos.js gym scale --sizes 100,1000
node dist/cli/gmos.js gym external --input-file ./long-memory-qa.jsonl --dataset-format gmos --format markdown --require-convergence --temporal-mode current
node dist/cli/gmos.js gym external --input-file ./longmemeval_s_cleaned.json --dataset-format longmemeval --format json --json-file ./longmemeval.json --markdown-file ./longmemeval.md --concurrency 4 --diagnostics-level full --progress
node dist/cli/gmos.js gym external --input-file ./locomo10.json --dataset-format locomo --format json --json-file ./locomo.json --markdown-file ./locomo.md --failure-sample-limit 20 --concurrency 2 --progress
node dist/cli/gmos.js gym external-suite --suite-file ./path/to/external-suite.json --output-dir ./external-runs --format json --markdown-file ./external-suite.md
node dist/cli/gmos.js gym statebench build-learnings --domain travel --input-dir ./STATE-Bench/datasets/train_task_trajectories/travel --output-file ./outputs/gmos-learnings/travel.json
node dist/cli/gmos.js gym statebench write-agent --output-file ./STATE-Bench/agents/gmos_memory_agent.py
node dist/cli/gmos.js gym statebench prepare --checkout-dir ./STATE-Bench --domain travel --agent-model-name gpt-5.1 --num-workers 2 --manifest-file outputs/gmos-learnings/travel.prepare.json
node dist/cli/gmos.js gym statebench summarize --checkout-dir ./STATE-Bench --domain travel --metrics-file outputs/travel/metrics.json --prepare-manifest outputs/gmos-learnings/travel.prepare.json
node dist/cli/gmos.js gym gate --generated-seeds 3 --scale-sizes 100,1000 --format json
node dist/cli/gmos.js gym host --hosts ghast,mcp,mock_l3,search_only --format markdown
node dist/cli/gmos.js gym host --hosts ghast --actual-report ./ghast-memory-status.json --format markdown
```

## QA Gates

```bash
npm run gate:pr
node dist/cli/gmos.js gym external --input-file ./long-memory-qa.jsonl --dataset-format gmos --format json --require-convergence --progress
node dist/cli/gmos.js gym external-suite --suite-file ./path/to/external-suite.json --output-dir ./external-runs --format json
node dist/cli/gmos.js gym statebench build-learnings --domain travel --input-dir ./STATE-Bench/datasets/train_task_trajectories/travel --output-file ./outputs/gmos-learnings/travel.json
node dist/cli/gmos.js gym statebench prepare --checkout-dir ./STATE-Bench --domain travel --agent-model-name gpt-5.1 --manifest-file outputs/gmos-learnings/travel.prepare.json
node dist/cli/gmos.js gym statebench summarize --checkout-dir ./STATE-Bench --domain travel --metrics-file outputs/travel/metrics.json --output-file outputs/gmos-learnings/travel.summary.json
node dist/cli/gmos.js repair --db ./gmos.db --search-index
node dist/cli/gmos.js repair --db ./gmos.db --associations
```

`gate:pr` is the local and CI PR gate. It runs build/test, quickstart and host
examples, the core no-benchmark-special-casing scan, consumer install smoke,
deterministic Memory Gym smoke, external fixtures, the SDK release gate, scale
smoke, and a pack dry run.

`test:consumer` packs the SDK, installs it into a temporary external project,
then verifies package exports, plaintext SQLite use, the MCP-style router, MCP
stdio server wiring, the HTTP adapter export, and the `gmos` CLI from the
installed package.

The GitHub Actions CI runs these gates on Linux and macOS with Node 20.19 and
Node 24, and on Windows with Node 24. Windows Node 20.19 is not part of the
official CI matrix because the current `better-sqlite3` prebuild coverage can
fall back to native compilation on GitHub-hosted Windows runners. The benchmark
jobs are deterministic SDK gates; they do not call an external LLM.

`gym run` is the deterministic SDK benchmark. It reports hard gates, coverage
layers, a generalization view, roadmap suggestions, and a run manifest. It does
not run an LLM judge and should not be treated as proof of mature digital-twin
capability.

`gym external` runs a local long-memory QA adapter over a user-provided file.
gmOS supports its native deterministic JSONL format plus direct local adapters
for LongMemEval original/cleaned JSON/JSONL and LoCoMo JSON/JSONL through
`--dataset-format gmos|longmemeval|locomo`. It is meant for converted external
datasets such as long-memory QA or multi-session recall corpora, but gmOS does
not download or vendor those datasets. In native gmOS JSONL, each line is one
deterministic case:

```jsonl
{"id":"project-next-step","events":[{"type":"memory","kind":"project","content":"代号 Vega 的发布计划叫做 Lantern Run。"},{"type":"memory","kind":"procedure","content":"Lantern Run 下一步先更新 rollback matrix，再做发布实现。"}],"question":"Vega 这个发布计划下一步先做什么？","expectedAll":["rollback matrix"],"forbiddenAny":["会议室"]}
```

The LongMemEval adapter maps each instance's `haystack_sessions` turns into
conversation observations and uses `answer` only as the deterministic scoring
target. The LoCoMo adapter maps each sample's `conversation.session_<n>` turns
into observations and creates one case per `qa` annotation. It accepts `answer`
as the deterministic scoring target and treats any provided
`adversarial_answer` as forbidden output. Adapter code does not write answer
labels, adversarial labels, evidence ids, category labels, or `has_answer`
labels into memory; those fields are reserved for scoring and traceability.
LoCoMo QA annotations without an official `answer` are skipped as unscorable
and reported in the dataset warnings instead of being treated as correct.

`gym external-suite` runs several external benchmark files from one manifest and
writes per-run JSON/Markdown reports when `--output-dir` is provided. By default
it is a dry-run baseline tool: failed benchmark runs set `benchmarkPass=false`
but keep the command status successful so teams can record weak baselines. Add
`--fail-on-benchmark-fail` when using the same suite as a release gate.
External benchmark reports include both deterministic failure reasons and a
coarser failure-stage taxonomy so low external scores can be separated into
answer-label/input mismatch, extraction/filtering, retrieval policy filtering,
reconstruction misses, context composer or budget drops, forbidden context
inclusion, and convergence failures. `failureStages` counts whether a stage
appears in a failed case; the per-case taxonomy entries carry the matched terms.
The legacy `score` field is the strict deterministic adapter score and is also
reported explicitly as `strictScore`. Reports also include
`normalizedEvidenceScore`, which counts cases where the reconstructed context
contains the expected evidence after conservative punctuation, date-order, or
number-format normalization. This normalized view is diagnostic only; it is not
an official benchmark score and does not change pass/fail. It still respects
forbidden matches and required convergence; it is not a loose hit-rate that can
override safety or convergence failures.
External run and suite manifests include `scoreSemantics` so generated JSON and
Markdown artifacts identify these numbers as deterministic adapter/context
scores, not official protocol scores.
Suite Markdown reports also include a diagnostic summary of the slowest runs,
weakest slice scores, and top failure stages/reasons. That summary is derived
from existing run statistics only; it does not change scoring, adapter behavior,
or runtime behavior.
Single-run external reports include slowest case and case-group timing
diagnostics. Case timing measures scoring/reconstruction for one question, while
case-group timing separates profile setup from scoring so long-history datasets
can show whether time is spent ingesting events or answering questions. These
timing fields are diagnostic only and do not affect pass/fail scoring. Runtime
is split into setup/ingestion, core scoring, taxonomy, and wide-budget
diagnostic probes so expensive diagnostics do not get mistaken for core memory
runtime.
Use `--diagnostics-level off|basic|full` on `gym external`, or
`diagnosticsLevel` in an external-suite manifest, to control diagnostic cost.
`off` records strict scoring without failure taxonomy, `basic` records taxonomy
without wide-budget recovery probes, and `full` runs the full taxonomy used for
deep failure analysis. The default is `full` for backward-compatible reports.
`wideBudgetDiagnosticRuntimeMs` is a subset of taxonomy runtime, not an
additional runtime bucket to add on top of `taxonomyRuntimeMs`.
When an expected answer is not an exact substring but is present after simple
punctuation/spacing/date-format-or-order/number-grouping normalization, the report uses
`answer_normalization_mismatch` instead of `answer_not_in_input` so adapter
label issues stay separate from missing source evidence.
Per-run `sliceScores` are diagnostic tag buckets, not unique-case totals or
official benchmark scores; use them to locate weak slices, not to claim SOTA.

The repository also includes a small CI-safe fixture suite at
`test/fixtures/external-benchmark/suite.json`. `npm run test:external-fixtures`
runs it with `--fail-on-benchmark-fail` and covers gmOS native JSONL,
LongMemEval adapter abstention handling, LoCoMo adapter unscored-QA handling,
profile reuse, incognito filtering, history recall, task trajectory reuse, and
boundary-aware prepare mode. The curated native fixture set has 43 cases covering
current/history recall, current-state suppression of historical project fields,
direct, speaker-prefixed, possessive, and current-state person grounding,
speaker-prefixed, possessive, and has-relation person grounding,
temporal recall, secret-like and sensitive filtering, project aliases, procedures,
task trajectories, forgetting, and forbidden action boundaries. A separate low-budget native run
covers critical fact retention under context pressure. Full LongMemEval/LoCoMo
datasets remain manual or nightly baselines because they are too large and slow
for ordinary PR CI.

Latest external benchmark dry-run snapshot, alpha.67, 2026-06-29:

These runs were executed on the `@ghast/memory@0.1.0-alpha.67` local build from
commit `3e6afeae3b5395ec60734f8414e6abd6274a1276` with the suite invocation
`gmos gym external-suite --suite-file external-suite-alpha67.json --output-dir results/alpha67-external-suite --format json`
with `concurrency: 2` and `failureSampleLimit: 20` in the suite defaults. They
are deterministic adapter dry-runs for finding retrieval and reconstruction
gaps, not the official LongMemEval/LoCoMo LLM-judge score and not a SOTA claim.
The suite manifest recorded `@ghast/memory@0.1.0-alpha.67`, git branch `main`,
git SHA `3e6afeae3b5395ec60734f8414e6abd6274a1276`, `dirty=false`,
Node `v24.16.0`, and platform `darwin/arm64`.
The suite files and datasets were kept in an external benchmark work directory;
the invocation paths above are relative to that directory, not to the repository
root. Suite summary: `benchmarkPass=false`, `scoreMean=0.2009`,
`scoreWeighted=0.1612`, total cases `400/2482`, total runtime `1676.4s`.

| Dataset file | Source format | Scored cases | Pass | Fail | Deterministic adapter score | Case groups | Reused profile cases | Warnings | Runtime |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `longmemeval_oracle.json` | LongMemEval cleaned oracle | 470 | 113 | 357 | `0.2404` | 470 | 0 | 30 | 26.3s |
| `longmemeval_s_cleaned.json` | LongMemEval cleaned S | 470 | 119 | 351 | `0.2532` | 470 | 0 | 30 | 1284.2s |
| `locomo10.json` | LoCoMo full history | 1542 | 168 | 1374 | `0.1089` | 10 | 1532 | 444 | 363.4s |

Failure-stage taxonomy:

| Dataset file | `answer_not_in_input` | `not_extracted_or_filtered` | `retrieval_or_reconstruction_miss` | `answer_normalization_mismatch` | `context_composer_or_budget_drop` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `longmemeval_oracle.json` | 219 | 128 | 4 | 6 | 0 |
| `longmemeval_s_cleaned.json` | 194 | 119 | 27 | 7 | 4 |
| `locomo10.json` | 946 | 272 | 149 | 7 | 0 |

Dataset hashes:

- `longmemeval_oracle.json`:
  `sha256:821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`
- `longmemeval_s_cleaned.json`:
  `sha256:d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
- `locomo10.json`:
  `sha256:79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`

The suite-level result was `benchmarkPass=false`, which is expected for this
alpha baseline, while the dry-run command itself stayed successful so the weak
baseline can be recorded and compared over time. The runner skips official
LongMemEval abstention cases by default. The LoCoMo adapter also skips QA
annotations that lack an official `answer`; in this run, 444 such annotations
were reported as warnings and not counted as scored cases. Compared with the
alpha.66 snapshot, LongMemEval oracle moved from `0.2787` to `0.2404`,
LongMemEval cleaned S moved from `0.2787` to `0.2532`, and LoCoMo10 moved from
`0.0687` to `0.1089`. Runtime also increased materially: cleaned S moved from
`543.3s` to `1284.2s`, and LoCoMo10 moved from `88.3s` to `363.4s`. This is a
real baseline, not a filtered success report: the current branch improved some
multi-party LoCoMo recall while regressing LongMemEval score and large-input
runtime. The taxonomy shows three immediate work streams: dataset/adapter answer
normalization for `answer_normalization_mismatch` / `answer_not_in_input`,
stronger durable observation extraction for `not_extracted_or_filtered`, and
better speaker/entity/time/event reconstruction for
`retrieval_or_reconstruction_miss`. LoCoMo remains the clearest pressure test
for multi-party entity grounding and exact event recall.
Many failed cases carried medium or high uncertainty, and many did not reach
evidence convergence, which makes this a useful baseline for active
reconstruction, hybrid retrieval, entity resolution, and temporal current-state
work. The `longmemeval_s_cleaned.json` run is intentionally recorded with
runtime because it is much larger than the oracle file: the local copy is about
265 MB and contains roughly 246k message turns, so it is also a scale warning
for external benchmark execution. The LoCoMo run demonstrates why profile/event
grouping matters: all scored QA cases share only 10 conversation histories, so
the benchmark can reuse prepared profiles without writing answer labels,
evidence ids, category labels, or `has_answer` labels into memory.

Previous historical snapshot, alpha.66, 2026-06-27:

| Dataset file | Deterministic adapter score | Runtime |
| --- | ---: | ---: |
| `longmemeval_oracle.json` | `0.2787` | 14.5s |
| `longmemeval_s_cleaned.json` | `0.2787` | 543.3s |
| `locomo10.json` | `0.0687` | 88.3s |

Dataset source pointers used for this dry-run:
[LongMemEval cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned),
[LongMemEval GitHub](https://github.com/xiaowu0162/longmemeval), and
[LoCoMo GitHub](https://github.com/snap-research/locomo). The datasets are not
vendored in this repository.

`gym statebench` is a protocol bridge for the STATE-Bench Agent Learning Track,
not a replacement for the official runner. `build-learnings` reads only
`datasets/train_task_trajectories/<domain>` style JSON files, extracts compact
procedural learnings from prior successful tool-call trajectories, and writes a
`gmos.state_bench_learnings.v1` artifact. It does not read held-out test tasks,
judge labels, or simulator state. By default the builder refuses paths that do
not end in `datasets/train_task_trajectories/<domain>`; `--allow-non-train-input`
is intended only for isolated fixtures and local smoke tests. `write-agent`
writes a Python
`GmosMemoryAgent(StateBenchAgent)` hook that implements the official
`retrieve_learnings(query, top_k=3) -> list[str]` interface and refuses to
overwrite existing files unless `--force` is passed. `prepare` combines the two
steps inside a STATE-Bench checkout and emits a
`gmos.state_bench_prepare_run.v1` manifest with relative artifact paths, the
exact `uv run python -m state_bench.scripts.run_batch ...` command, and the
matching `compute_metrics` command. The manifest intentionally omits absolute
local paths and train trajectory content. Officially comparable STATE-Bench
numbers still require running the unchanged STATE-Bench protocol, fixed
evaluator/simulator setup, and `--retrieve-learnings-top-k 3` inside a
STATE-Bench checkout.

After the official `compute_metrics` command writes `metrics.json`,
`gym statebench summarize` can archive a gmOS-side
`gmos.state_bench_results_summary.v1` report. It reads the official metrics
artifact and optional prepare manifest, counts run output files, and keeps all
paths relative to the checkout root. It does not inspect held-out task
definitions, read evaluator labels, re-score trajectories, or claim a score
that STATE-Bench did not produce.

This adapter targets the original/cleaned LongMemEval schema, not the newer
LongMemEval-V2 trajectory/haystack schema. It is deterministic context and
reconstruction scoring, not the official benchmark's LLM-judge QA score.

The runner seeds a temporary plaintext SQLite store, executes `prepareTurn` or
bounded `reconstructContext`, and scores context evidence by `expectedAny`,
`expectedAll`, and `forbiddenAny`. It is deterministic and local-first; it does
not call an LLM judge. Results include a run manifest, dataset format, dataset
SHA-256 hash, deterministic failure reasons, warnings, evidence-convergence
diagnostics, missing intent groups, uncertainty, token estimates, reconstructed
path counts, aggregate failure summaries, and bounded failure samples. Cases
with the same profile id and identical event history are grouped by default, so
multi-QA datasets such as LoCoMo build the conversation memory once and run
multiple questions against the same temporary profile. Pass `--no-reuse-profiles`
when a debugging run needs strict case-by-case isolation. `--concurrency <n>`
limits how many independent case groups run at once; the default is bounded to
avoid opening hundreds of SQLite stores for long-history datasets. `--progress`
writes content-free case progress to stderr, which keeps large redirected JSON
runs observable without mixing progress lines into stdout. `--json-file` and
`--markdown-file` can be used together to create a reproducibility bundle from
one run. External suite reports also include the raw suite file SHA-256 hash
when a `--suite-file` is provided, so reproduced runs can verify both the suite
manifest and each dataset file. `--failure-sample-limit <n>` controls how many
failed cases are copied into the summary section. Add `"requireConvergence":
true` to a case, or pass `--require-convergence` for the whole run, when the
benchmark should fail unless active reconstruction converges; this is useful for
multi-hop or multi-intent cases where a plain text hit is not strong enough
evidence. `--require-convergence` is only valid for reconstruct mode and forces
every case in that run to require convergence. Pass
`--temporal-mode current|history`, or set `"temporalMode"` on
a case or external suite run, when a benchmark must force current-state or
historical recall instead of relying on query cues. Pass `--temporal-metadata`, or set `"includeTemporalMetadata":
true` in an external suite manifest, when session-date answers should be scored
from evidence metadata. Sensitive memories remain excluded unless the run passes
`--include-sensitive` or sets `"includeSensitive": true` in an external suite
manifest. The manifest does not
include dataset contents or absolute local
paths, but public reports can still reveal repository branch names, dataset file
names, expected answer strings, and deterministic scoring labels in failure
samples; redact those fields before publishing if needed.

`gmos gate` is the SDK release-candidate gate. It runs deterministic Memory Gym,
the host compatibility gym, the local SQLite scale benchmark, and diagnostics
in one command. The scale sub-check covers both ordinary `prepareTurn` retrieval
and bounded `reconstructContext` association planning, reporting p95 latency,
prompt tokens, reconstructed tokens, and reconstructed path counts. By default
the gate uses an in-memory database and does not inspect or mutate a user's
production memory database. The gate intentionally does not accept a production
DB input; use `gym run --db` or `status --db` when you need to inspect a specific
file. The scale sub-check creates and deletes its own temporary SQLite files
under the OS temp directory; it does not read a user's memory DB. Passing this
gate means the SDK's local runtime contract is healthy;
it is still not an external long-term agent benchmark or a proof of mature
digital-twin capability.

`doctor` and `status` include content-free SQLite health summaries: indexed row
count, missing FTS rows, stale rows, orphan rows, duplicates, local vector side
index status, and read-audit coverage. The read-audit summary reports table
counts and whether hashes are available; it does not print table state hashes or
memory content. Context search uses a deterministic local vector projection with
FTS/BM25 and LIKE fallback; delete and management search stay lexical so fuzzy
recall cannot archive the wrong memory. The vector index is derived from
`gmos_memories`, stored in plaintext SQLite, and never calls a network embedding
service. If the index drifts from the canonical table,
run `gmos repair --db ./gmos.db --search-index` to rebuild both FTS and vector
rows from the stored memories. Repair does not create or delete memories; it
only rebuilds derived search indexes.

`reconstructContext()` is the active reconstruction API. It starts from the
current turn's cue terms, explores bounded cue-tag-content associations, fetches
matching memory content, generates new cues from intermediate evidence, and
reranks noisy branches by query intent before spending context budget. For
example, a "next step" query prefers procedure and task-trajectory paths over
high-confidence but generic facts; a boundary query prefers boundary and
`do_not_push` paths. The planner also blends association paths with direct
memory-search hits using a bounded reciprocal-rank signal, so explicit entity or
temporal clues can reinforce the chosen evidence path without replacing the
cue-tag-content graph. Returned paths include `routeScore` and `routeReason` so
a host can explain why a branch was selected. Returned paths also expose
`informationGain`, and returned stats include evidence convergence, coverage,
and reconstruction uncertainty. This lets hosts distinguish "we found enough
supporting evidence" from "we only retrieved plausible nearby memories".
Returned results also include `plannerTrace`, a structured cue-exploration trace
with selected cues, branch decisions, pruned branches, and evidence-driven new
cue activation. This trace is for host diagnostics, benchmark verification, and
offline regression reports; it is not injected into the default prompt context
and should not be forwarded directly to an LLM or end user.
When a query carries multiple intents, such as "what is the next step and what
should I avoid?", convergence requires every detected intent group to be covered
by evidence; a procedure path alone is not enough if the query also asks for a
boundary.
`stopWhenEvidenceEnough` defaults to true; set it to false for diagnostics when
you want the planner to spend the full step budget and inspect additional
branches. `evidenceConvergenceThreshold` can be raised for stricter release
gates or lowered for exploratory tooling.
`explainEvidencePath()` exposes the same reconstructed cue-tag-content evidence
path as an audit object without returning `contextBlock` or a prompt-ready
memory list. It is intended for host diagnostics, agent self-checks, Memory Gym
reports, and product-visible "why did you remember this?" affordances. It
defaults to including canonical evidence and can optionally include
`plannerTrace`; public MCP and HTTP expose it as `memory.explain_evidence_path`
and `POST /explain-path`, while still rejecting `includeSensitive`.
Memory metadata may carry ISO timestamp validity windows through `validFrom` /
`validTo` (or `valid_from` / `valid_to`; `expiresAt` is accepted as an expiry
alias). Ordinary context search and active reconstruction only use memories
whose validity window includes the current time; `validTo` and `expiresAt` are
treated as exclusive expiries. Management and delete searches still see
out-of-window memories so hosts can audit, repair, or forget them explicitly.
History search and reconstruction are separate from management: `purpose:
"history"` and `temporalMode: "history"` let agents answer "what was true
before?" without treating the request as an admin/delete operation. The default
`temporalMode: "auto"` infers history mode from cues such as "previous",
"before", "历史", or "之前"; `temporalMode: "current"` forces ordinary current
context behavior even when the query contains historical wording. History mode
does not bypass sensitive or person-memory defaults.
Rule and host extractor candidates can also pick up conservative validity
metadata from explicit ISO-date text such as `until 2026-07-01`, `expires on
2026-07-01`, `valid from 2026-01-01`, or `从 2026-01-01 开始`. When a message has
a trusted ISO `createdAt`, gmOS also records conservative event-date metadata
for `today`, `yesterday`, `tomorrow`, `今天`, `昨天`, and `明天`. gmOS still does
not try to resolve ambiguous relative dates such as "next week" inside the rule
extractor; hosts should pass structured metadata when they have a trusted
calendar parser. The same validity metadata is written to the derived world
belief when a candidate creates one, so reconstruction does not reintroduce an
expired belief through the association graph.
Active reconstruction can render observation time and resolved event dates as
metadata on memory, evidence, and reconstructed path lines when
`includeTemporalMetadata: true` is set, for example `observed=2026-06-03` or
`event_date=2026-06-02; event_date_text=2 June 2026`. `event_date_text` is
derived at render time from the stored ISO date. The timestamp is not appended
to stored memory content; it is rendered at composition time so agents can
reason over timelines without polluting the canonical memory record or the
ordinary context path. CLI users can pass `--temporal-metadata` to `reconstruct`
or `explain-path`.
The first production mode is shadow-safe:
`prepareTurn({ reconstruction: { mode: "shadow" } })` returns a separate
`reconstruction` field without replacing the ordinary `contextBlock`.
Public MCP/HTTP reconstruction does not allow `includeSensitive`; sensitive and
person-scoped memory remains hidden by default. If a migrated SQLite file has no
association rows, run `gmos repair --db ./gmos.db --associations` to rebuild the
derived index from canonical memory, world, and task tables.

`createMemoryOS({ extractor })` lets a host provide structured extraction while
keeping gmOS as the write-path authority:

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  extractor: {
    name: "host-llm-extractor",
    async extract(input) {
      // Use input.event, input.evidence, and input.ruleCandidates to produce
      // structured candidates from the current user message.
      return [
        {
          kind: "preference",
          content: "The user prefers risk-first release plans.",
          confidence: 0.9,
          predicate: "user.preference",
          actionPolicyKind: "prefer",
        },
        {
          kind: "project",
          subject: "project:helio",
          predicate: "project.state",
          content: "Helio is blocked on the migration probe.",
          confidence: 0.86,
          cardinality: "single",
        },
      ];
    },
  },
});
```

The extractor is intentionally not a raw database hook. `observe()` still
rejects incognito and secret-like writes before evidence persistence, skips PERSON
routed candidates, bounds confidence, deduplicates candidates, and writes world
beliefs only from accepted candidates that carry a structured predicate.
Returning `[]` means "extract nothing"; returning `null` or throwing falls back
to the built-in rules by default. If a custom extractor returns candidates but
all of them are rejected by the gmOS write-path validator, gmOS records the
hard/soft reject audit. If every rejection is a soft structural or quality
failure, gmOS may fall back to built-in durable rule candidates instead of
treating the structured extraction failure as final. Secret-like, PERSON-routed,
person-kind, and non-person speaker hard rejects do not fall back. Use
`createMemoryOS({ extraction: { fallbackToRules: false } })` when a host wants
custom extraction failure to produce no memory instead of rule fallback.

`observe()` remains the stable fire-and-forget observation API. Use
`observeWithReport()` when a host or benchmark needs an `ObserveResult` to
audit the write path without reading private tables:

```ts
const report = await memory.observeWithReport({
  type: "conversation.message",
  role: "user",
  content: "I prefer risk-first release plans.",
});

console.log(report.memoryIds);
console.log(report.extraction?.decisions);
```

The report includes the evidence id, accepted memory ids, world belief ids,
rule/custom candidate counts, fallback status, hard/soft reject counts,
fallback durable candidate counts, and accepted/rejected candidate decisions
after candidates enter gmOS write-path validation. It is not a raw
LLM-output transcript. Candidate snapshots are sanitized; rejected secret-like
fields and sensitive metadata are redacted or omitted so the report can be
logged by a host without becoming a credential side channel.

Use `listEvidence()` when a host needs a read-only diagnostic view of recent
evidence events, including eligible non-user messages that were intentionally
not promoted into memories. This API is not used for ordinary prompt context.
It defaults to normal-sensitivity evidence only; `includeSensitive: true`
returns sensitive rows with sanitized public fields and still excludes
secret-like evidence.

For OpenAI-compatible providers, gmOS includes an optional structured extractor
factory. It is never enabled by default and the SDK never stores provider keys:

```ts
import { createOpenAICompatibleExtractor } from "@ghast/memory";

const memory = createMemoryOS({
  profileId: "local-user",
  store,
  extractor: createOpenAICompatibleExtractor({
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: process.env.DEEPSEEK_API_KEY,
  }),
});
```

The extractor calls `/chat/completions`, requests JSON output, parses
`{"memories":[...]}`, and then sends candidates through the same gmOS write-path
guards as every other extractor: incognito events are skipped before extraction,
secret-like and PERSON-routed candidates are rejected, confidence is bounded,
and rule fallback is used when the provider call fails unless disabled. Event
metadata is not sent to the provider unless `includeEventMetadata: true` is set.
Structured candidates may include `subject`, `predicate`, `object`, `source`,
`eventTime`, `validFrom`, `validTo`, and `cardinality`; `source` is only a short
public label for the extracted candidate, while evidence `sourceType/sourceUri`
remain the provenance source of truth.

Use `cardinality: "single"` only for current-state beliefs where one active
value should replace the previous one, such as a project's current owner,
status, or next step. gmOS first resolves the subject into a canonical entity
key; for example, `Atlas project`, `project:atlas`, and `Project Atlas` all
converge to the same project entity. It then marks the previous active world
belief for the same `profileId + canonical subject + predicate` as
`superseded` and removes its association projection from active reconstruction.
Ordinary context search and active reconstruction also suppress source memories
that only support the superseded current-state value. Use `purpose: "history"`
or `temporalMode: "history"` when the user is asking for past state; use
`purpose: "manage"` and `purpose: "delete"` only for audit, cleanup, or explicit
forgetting. Omit `cardinality`, or set `"multi"`, for
preferences, boundaries, facts, and procedures that can validly coexist.

The host compatibility gym distinguishes target presets from actual host
adoption. `--hosts ghast` without an actual report tests the SDK's target Ghast
capability contract. To gate a real app migration, pass a host status JSON with
`--actual-report`; the CLI accepts either a direct host report or a Ghast
Desktop status object containing `gmosSdkAdapter`. If the actual report says
the app is still L3, the gym fails instead of treating the target L4 preset as
proof of completed adoption.

Host apps can use the same parser in-process:

```ts
import { runHostCompatibilityGym } from "@ghast/memory/gym";
import { parseHostActualCompatibilityReports } from "@ghast/memory/host";

const actualReports = parseHostActualCompatibilityReports(hostStatusJson);
const result = await runHostCompatibilityGym({
  hosts: ["ghast"],
  actualReports,
});
```

Use `requireHostActualCompatibilityReports` when the host gate should fail fast
on malformed payloads. `parseHostActualCompatibilityReports` is tolerant by
design and ignores invalid entries, such as reports with an unknown compatibility
level.

## Examples

Run the examples after installing dependencies:

```bash
npm run examples:quickstart
npm run examples:host-adapter
```

`examples/quickstart.mjs` creates a temporary plaintext SQLite store, observes a user
preference, prepares memory context, exercises low-level
`add/update/search/archive`, prints a content-free diagnostics summary, and removes
the temporary database.

`examples/host-adapter.mjs` shows the host migration path: project an existing
host memory snapshot into gmOS, skip secret-like and person-routed memories,
prepare evidence-aware context, and archive stale imported memories on the next
sync. Use this path when the host already has a memory table and needs gmOS as
the context/action runtime without replacing storage in one step.

## Low-Level Compatibility APIs

The primary gmOS integration path is still `observe()` plus `prepareTurn()`.
That path gives the runtime conversation events, privacy mode, task state, and
feedback signals.
`prepareTurn().task` intent, project id, and topic are used as retrieval hints
alongside the latest user message. They are not rendered into reconstructed
context blocks or route metadata returned to callers.

`add()`, `update()`, `archive()`, `clear()`, `search()`, `list()`, and `get()`
exist for lower-level compatibility cases: importing a known memory from another
host, admin/debug tools, migration scripts, or simple agent runtimes that do not
yet expose full event hooks. They are intentionally not raw database access:

- `add()` records a `sdk.low_level_add` evidence event before creating memory;
- `update()` records a `sdk.low_level_update` evidence event before changing memory;
- `archive()` and `clear()` archive active memories instead of physically deleting rows;
- secret-like content is rejected before it reaches long-term memory;
- `person` memory and `PERSON:`-routed content require `allowPerson: true` on add/update;
- `clear()` requires an explicit filter: `all`, `scope`, or `metadataEquals`;
- `search()` defaults to `purpose: "context"`, which hides sensitive memory
  unless `includeSensitive` is explicitly set and hides person memory unless
  `includePerson` is explicitly set.
- SQLite search uses a maintained full-text index for query recall instead of
  only scanning the newest memories, so older relevant memories remain
  discoverable as the local store grows.
- `searchIndexStatus()` and `repairSearchIndex()` expose the same derived-index
  health and repair path used by CLI diagnostics.
- `list()` and `get()` provide host management/migration reads without forcing a
  host to import the store directly. They still hide archived, sensitive, and
  person-scoped memory unless the caller explicitly asks for those management
  views.

The CLI also supports portable memory snapshot migration:

```bash
gmos export --db ./gmos.db --profile local --output-file ./gmos-memory-export.json
gmos import --db ./new-gmos.db --profile local --input-file ./gmos-memory-export.json
```

This is not a byte-for-byte database backup. It exports a versioned
`gmos.memory_snapshot_export.v1` JSON document and imports it through the same
host snapshot importer used by adapters. By default, export only includes
active, non-sensitive, non-person memories. Use `--include-sensitive`,
`--include-person`, or `--include-archived` only when the host explicitly needs
those management views.

For engineering reproduction, migration rehearsal, or rollback, use profile
backup instead of public snapshot export:

```bash
gmos backup --db ./gmos.db --profile local --mode safe --output-file ./gmos-profile-backup.json
gmos backup --db ./gmos.db --profile local --mode full --output-file ./gmos-profile-full-backup.json
gmos restore --db ./new-gmos.db --profile local-restored --input-file ./gmos-profile-full-backup.json
```

`gmos.profile_backup.v1` is a SQLite profile backup document. `--mode safe`
keeps the ordinary migration boundary: active, normal, non-person memories plus
their safe evidence. It does not include failures, task trajectories, archived
rows, sensitive rows, or person memories unless explicitly requested. `--mode
full` is for trusted engineering use and includes archived/sensitive/person
memories, evidence events, world beliefs, failure events, and task
trajectories. The backup is plaintext JSON; gmOS does not encrypt local
databases or backup files. `parseSqliteProfileBackup()` validates the document
before restore: schema, mode, options, row fields, enum values, counts,
duplicate IDs, source profile IDs, and included evidence/world-belief
references must all be consistent.

The same path is available in-process:

```ts
import {
  createSqliteMemoryStore,
  parseSqliteProfileBackup,
} from "@ghast/memory/store/sqlite";

const store = createSqliteMemoryStore({ path: "./gmos.db" });
const backup = store.exportProfileBackup({ profileId: "local", mode: "full" });
const parsed = parseSqliteProfileBackup(JSON.parse(JSON.stringify(backup)));
store.restoreProfileBackup({
  backup: parsed,
  profileId: "local-restored",
  onConflict: "skip",
});
```

```ts
const saved = await memory.add({
  profileId: "local-user",
  kind: "preference",
  content: "我喜欢先讲风险，再给方案。",
});

const matches = await memory.search({
  profileId: "local-user",
  query: "风险 方案",
});

await memory.update({
  profileId: "local-user",
  id: saved.id,
  content: "我喜欢先讲风险，再给方案。",
});

await memory.archive({
  profileId: "local-user",
  id: saved.id,
});

// The CLI exposes the same managed read boundary:
// gmos list --db ./gmos.db --profile local --status archived
// gmos get --db ./gmos.db --profile local --id memory_xxx --include-archived
const archived = await memory.list({
  profileId: "local-user",
  status: "archived",
});

const managedRead = await memory.get({
  profileId: "local-user",
  id: saved.id,
  includeArchived: true,
});
```

## MCP Tools

The alpha SDK exposes both a protocol-neutral in-process router and a real MCP
stdio server through `@ghast/memory/mcp`. Hosts can mount the same tools behind
MCP stdio, HTTP, Electron IPC, or another agent runtime without changing the
memory core.

```ts
import { createMemoryMcpServer } from "@ghast/memory/mcp";

const server = createMemoryMcpServer(memory);
const result = await server.callTool("memory.prepare_context", {
  text: "你知道我什么偏好吗？",
  includeEvidence: true,
});
```

For agent clients that can launch MCP stdio servers:

```bash
gmos mcp serve --db ./gmos.db --profile local
```

Programmatic stdio server:

```ts
import { serveMemoryMcpStdio } from "@ghast/memory/mcp";

const server = await serveMemoryMcpStdio(memory);
await server.close();
```

The stdio server reports the installed `@ghast/memory` package version during
MCP initialization unless the host passes an explicit `version` override.

Current tools are `memory.add`, `memory.search`, `memory.observe`,
`memory.prepare_context`, `memory.reconstruct_context`,
`memory.explain_evidence_path`, `memory.commit_outcome`,
`memory.record_feedback`, `memory.forget`, and `memory.explain_belief`.

Hosts can gate this public tool surface explicitly:

```ts
import {
  PUBLIC_MEMORY_MCP_TOOL_NAMES,
  listMemoryMcpTools,
} from "@ghast/memory/mcp";

if (
  JSON.stringify(listMemoryMcpTools().map((tool) => tool.name)) !==
  JSON.stringify(PUBLIC_MEMORY_MCP_TOOL_NAMES)
) {
  throw new Error("gmOS MCP public surface changed");
}
```

`memory.add` and `memory.search` are public-safe tools for simple agent
integrations. They do not expose `allowPerson`, `includeSensitive`,
`includePerson`, or raw metadata fields. Secret-like content is rejected before
write, person-routed content is rejected, and search returns only context-safe
memory records.

## HTTP Adapter

Hosts that cannot embed the Node SDK directly can run gmOS as a local HTTP
service. This adapter reuses the MCP tool router for memory operations, so it
does not bypass the public safety boundary. It defaults to `127.0.0.1` and
does not add TLS, cloud sync, or database encryption. For local service
boundaries that cross a process boundary, pass `authToken` or
`--auth-token`; all non-health endpoints will then require
`Authorization: Bearer <token>`.

```ts
import { createMemoryHttpServer } from "@ghast/memory/http";

const server = createMemoryHttpServer({
  memory,
  store,
  profileId: "local-user",
  authToken: process.env.GMOS_HTTP_AUTH_TOKEN,
});
const { url } = await server.listen({ port: 4787 });
```

CLI:

```bash
GMOS_HTTP_AUTH_TOKEN=local-dev-token \
  gmos http serve --db ./gmos.db --profile local --port 4787 --host ghast
```

Endpoints:

- `GET /health` (always open; reports whether auth is required)
- `GET /status?profileId=local`
- `GET /tools`
- `POST /add`
- `POST /search`
- `POST /observe`
- `POST /prepare`
- `POST /reconstruct`
- `POST /explain-path`
- `POST /commit-outcome`
- `POST /feedback`
- `POST /forget`
- `POST /explain`
- `POST /mcp/call` with `{ "tool": "memory.prepare_context", "args": {} }`

When `authToken` is configured, every endpoint except `/health` returns `401`
unless the request includes `Authorization: Bearer <token>`. The token is never
printed in status or health responses.

The route list is also exported for host package-contract tests:

```ts
import { PUBLIC_MEMORY_HTTP_ROUTES } from "@ghast/memory/http";
```

The HTTP adapter intentionally rejects `includeSensitive` on `/prepare`,
`/reconstruct`, `/explain-path`, and `/search` through the same public-tool
contract as MCP. Hosts that need sensitive/admin memory access should use the
in-process SDK with an explicit internal trust boundary.

Profile backup/restore is intentionally not exposed as an MCP tool or HTTP
route. It remains an in-process SQLite store API and CLI operation for trusted
engineering workflows.

## Evolution Review

The alpha SDK includes a report-only self-evolution control plane. It reads the
failure log, clusters failures by kind, proposes repair hypotheses, and emits
policy patch candidates. It does not apply patches, roll out changes, or weaken
hard gates.

```ts
import { createEvolutionControlPlane } from "@ghast/memory/evolution";

const evolution = createEvolutionControlPlane({ store, profileId: "local-user" });
const report = await evolution.reviewFailures();
```

CLI:

```bash
gmos evolution report --db ./gmos.db --profile local --format markdown
```

Every proposal in this alpha path is explicitly marked `autoApply=false` and
`autoRollout=false`.

## Diagnostics

Hosts can generate a read-only status report for integration checks and support
bundles. The report includes package version, SQLite schema version, row counts,
read-audit coverage, failure counts by kind, and optional host compatibility. It
does not include memory content, failure samples, or table state hashes.

```ts
import { createMemoryStatusReport } from "@ghast/memory/diagnostics";

const report = await createMemoryStatusReport({
  store,
  profileId: "local-user",
  host: "ghast",
});
```

CLI:

```bash
gmos status --db ./gmos.db --profile local --host ghast --format markdown
```

## Trust Contract

gmOS defaults to a plaintext SQLite database. Security comes from memory policy
and host boundaries, not database encryption:

- secret-like content is not persisted as long-term memory;
- incognito/private events are not promoted to long-term memory;
- ordinary context does not include sensitive memory unless explicitly allowed;
- forget operations archive matching memory and remove it from future context;
- read paths must not write.
- SQLite read paths are audited with table state hashes so same-row updates or
  same-row-count FTS rewrites are treated as side effects.

SQLite stores include a `gmos_schema_migrations` ledger. `gmos doctor` reports
the current schema version so host applications can verify upgrade state before
running long-lived agents. TypeScript consumers can use the exported
`SqliteMemoryStore` type when they need SQLite-specific diagnostics.

## Host Compatibility

gmOS reports host capability as L0-L4. The SDK can maintain memory state, but a
host must expose the right hooks to preserve full behavior:

- `ghast`: L4, managed memory runtime.
- `mock_l3`: L3, useful for adapter smoke tests.
- `mcp`: L2, useful for tool-based integrations but cannot guarantee full
  directive enforcement.
- `search_only`: L1, recall-only and not a full Memory OS integration.

Run `gmos doctor --host ghast` to inspect capability gaps and hard-gate
coverage.

Run `gmos gym host` to execute the host compatibility gym. Unlike `doctor`,
which is a static capability report, the host gym exercises behavior expected
from each advertised capability: preference memory use, action-policy
directives, forget residue, private-mode exclusion, evidence-aware context, and
MCP sensitive-boundary enforcement. Unsupported capabilities are reported as
`not_applicable` instead of being hidden.

Host adapters can also import existing memory snapshots through
`loadHostMemorySnapshotsIntoStore()` from `@ghast/memory/host`. The importer
defaults to skipping `person` and `secret_like` snapshots before they enter the
gmOS store. It requires a store that implements
`findActiveMemoryByMetadata()` so repeated snapshot imports are idempotent.

Use `syncHostMemorySnapshotsIntoStore()` when the host is sending a full
current snapshot and stale mirror entries should be archived:

```ts
import { syncHostMemorySnapshotsIntoStore } from "@ghast/memory/host";

await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "local-user",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  memories: [
    {
      id: "host-memory-1",
      content: "我喜欢先讲风险。",
      kind: "preference",
      updatedAt: new Date().toISOString(),
    },
  ],
});
```

`loadHostMemorySnapshotsIntoStore()` is append/reuse import.
`syncHostMemorySnapshotsIntoStore()` is import plus stale host-import archive.
Use sync only when the snapshot list represents the host's complete active
memory set for that `profileId` and `sourceType`.

## Status

This is an alpha SDK extraction repository. The first target is a stable local
TypeScript/Node runtime that Ghast Desktop can consume through a host adapter.
