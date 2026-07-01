# Ghast Memory OS

Ghast Memory OS, or gmOS, is an open-source, local-first Memory OS for
personal agents. It is built to help agents learn user experience over time,
maintain a user-world model, reconstruct relevant context from evidence, respect
privacy and forgetting, and gradually become a user's second brain and digital
twin infrastructure.

The current package is the late-alpha runtime kernel for that vision. It
provides the SDK, CLI, MCP, HTTP, plaintext SQLite storage, evidence ledger,
world beliefs, reconstructive recall, action policies, safety gates, release
evidence, and benchmark harness needed for stable integration. It is not a
finished digital twin product and it is not a vector-memory CRUD wrapper.

Project docs: [API reference](./docs/API_REFERENCE.md),
[integration guide](./docs/INTEGRATION_GUIDE.md),
[architecture](./docs/ARCHITECTURE.md), [benchmarking](./docs/BENCHMARKING.md),
[migration](./docs/MIGRATION.md), [contributing](./CONTRIBUTING.md),
[security and privacy](./SECURITY.md), [release checklist](./RELEASE_CHECKLIST.md).

```ts
import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const memory = createMemoryOS({
  profileId: "local-user",
  store: createSqliteMemoryStore({ path: "./gmos.db" }),
});

await memory.add({
  profileId: "local-user",
  kind: "boundary",
  content: "以后不要再提醒我这个项目延期了。",
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
- Deterministic world-entity normalization for current-state beliefs. Structured
  subjects such as `project:<project-id>`, `project/<project-id>`, or subject `<project-id>` with
  predicate `project.state` converge before single-cardinality invalidation runs.
- Optional host-provided `entityResolver` support for product-specific entities.
  Hosts can canonicalize workspaces, accounts, repositories, or other domain
  objects without adding language-specific entity templates to gmOS core.
- Entity mention metadata for accepted memories and world beliefs. gmOS records
  explicit subjects and aliases, and only treats source speaker metadata as a
  person cue when the host or extractor marks it with `speakerKind: "person"`
  or `speakerKind: "human"`.
- Historical recall mode for temporal/current-state questions. Ordinary context
  still suppresses superseded or out-of-window memories, while explicit
  `history` recall can retrieve those past facts without using manage/delete
  search or opening sensitive/person memory.
- Runtime facade: `observe`, `prepareTurn`, `commitOutcome`, `recordFeedback`,
  `reconstructContext`, `explainEvidencePath`, `forget`, `explain`.
- Pluggable extraction pipeline for host-provided structured extractors. gmOS
  keeps write-path authority for evidence, PERSON, secret-like, incognito, and
  forgetting gates, but it does not synthesize durable semantic memory from
  built-in lexical/date cue parsing.
- Durable facts, preferences, boundaries, project state, people, and procedures
  should come from a host-provided structured extractor or an explicit low-level
  import.
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

## Known Limitations

- gmOS is still a late-alpha SDK/runtime, not a stable 1.0 Agent Memory OS.
- Local SQLite is plaintext by design. gmOS does not provide database
  encryption, cloud custody, vault integration, or hosted synchronization.
- gmOS does not ship a production default semantic extractor. Hosts should
  provide a structured extractor, or explicitly import known memories with
  `add()`, for durable facts, preferences, boundaries, procedures, people, and
  project state.
- External LongMemEval and LoCoMo numbers are deterministic local adapter
  baselines for engineering comparison. Official benchmark claims require the
  upstream protocol, fixed model/judge settings, and public reproduction data.
- STATE-Bench, Mem2ActBench, BEAM, and similar action-memory claims require
  their unchanged official runners before they should be presented as comparable
  benchmark results.

## CLI

```bash
npm install
npm run build

node dist/cli/gmos.js init --db ./gmos.db
node dist/cli/gmos.js doctor --db ./gmos.db --host ghast --format markdown
node dist/cli/gmos.js repair --db ./gmos.db --search-index
node dist/cli/gmos.js repair --db ./gmos.db --associations
node dist/cli/gmos.js status --db ./gmos.db --profile local --host ghast --format markdown
node dist/cli/gmos.js add --db ./gmos.db --profile local --kind preference --text "回答风格：简洁，先给结论"
node dist/cli/gmos.js update --db ./gmos.db --profile local --id memory_xxx --text "回答风格：先给结论，再列方案"
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
node dist/cli/gmos.js add --db ./gmos.db --profile local --kind boundary --text "不要再提醒我这个项目延期了。"
node dist/cli/gmos.js observe --db ./gmos.db --profile local --text "记录一条普通会话事件。" --report
node dist/cli/gmos.js prepare --db ./gmos.db --profile local --text "你之后怎么回答我？"
node dist/cli/gmos.js reconstruct --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？" --reconstruction-intent-json '{"queryCues":["project:<project-id>"],"requiredTagGroups":[{"name":"procedure_or_next_step","tags":["procedure","task_trajectory","project.state","world_belief"]}]}'
node dist/cli/gmos.js reconstruct --db ./gmos.db --profile local --text "这个项目之前是什么状态？" --temporal-mode history
node dist/cli/gmos.js explain-path --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？" --reconstruction-intent-json '{"queryCues":["project:<project-id>"],"requiredTagGroups":[{"name":"procedure_or_next_step","tags":["procedure","task_trajectory","project.state","world_belief"]}]}' --include-trace
node dist/cli/gmos.js mcp tools
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.add --input '{"kind":"preference","content":"回答风格：先给结论"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.search --input '{"query":"先给结论"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.search --input '{"query":"之前的状态","purpose":"history"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.prepare_context --input '{"text":"你之后怎么回答我？"}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.reconstruct_context --input '{"text":"我之前说的项目下一步是什么？","reconstructionIntent":{"queryCues":["project:<project-id>"],"requiredTagGroups":[{"name":"procedure_or_next_step","tags":["procedure","task_trajectory","project.state","world_belief"]}]}}'
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.explain_evidence_path --input '{"text":"我之前说的项目下一步是什么？","includePlannerTrace":true,"reconstructionIntent":{"queryCues":["project:<project-id>"],"requiredTagGroups":[{"name":"procedure_or_next_step","tags":["procedure","task_trajectory","project.state","world_belief"]}]}}'
node dist/cli/gmos.js mcp serve --db ./gmos.db --profile local
node dist/cli/gmos.js http serve --db ./gmos.db --profile local --port 4787 --host ghast --auth-token local-dev-token
node dist/cli/gmos.js evolution report --db ./gmos.db --profile local --format markdown
node dist/cli/gmos.js gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
node dist/cli/gmos.js gym run --db :memory: --generated-seeds 3
node dist/cli/gmos.js gym run --generated-seeds 10 --format markdown --report-file ./memory-gym.md
node dist/cli/gmos.js gym scale --sizes 100,1000
node dist/cli/gmos.js gym external --input-file ./long-memory-qa.jsonl --dataset-format gmos --format markdown --require-convergence --temporal-mode current
node dist/cli/gmos.js gym external --input-file ./long-memory-cleaned.json --dataset-format longmemeval --format json --json-file ./longmemeval.json --markdown-file ./longmemeval.md --concurrency 4 --diagnostics-level full --progress
node dist/cli/gmos.js gym external --input-file ./multi-session-memory.json --dataset-format locomo --format json --json-file ./locomo.json --markdown-file ./locomo.md --failure-sample-limit 20 --concurrency 2 --progress
node dist/cli/gmos.js gym external-suite --suite-file ./path/to/external-suite.json --output-dir ./external-runs --format json --markdown-file ./external-suite.md
node dist/cli/gmos.js gym gate --generated-seeds 3 --scale-sizes 100,1000 --format json
node dist/cli/gmos.js gym host --hosts ghast,mcp,mock_l3,search_only --format markdown
node dist/cli/gmos.js gym host --hosts ghast --actual-report ./ghast-memory-status.json --format markdown
```

## QA Gates

```bash
npm run gate:pr
npm run release:evidence -- --output-dir ./release-evidence/alpha68-local
node dist/cli/gmos.js gym external --input-file ./long-memory-qa.jsonl --dataset-format gmos --format json --require-convergence --progress
node dist/cli/gmos.js gym external-suite --suite-file ./path/to/external-suite.json --output-dir ./external-runs --format json
node dist/cli/gmos.js repair --db ./gmos.db --search-index
node dist/cli/gmos.js repair --db ./gmos.db --associations
```

`gate:pr` is the local and CI PR gate. It runs build/test, published examples,
benchmark-integrity checks, extraction boundary checks, consumer
install smoke, deterministic Memory Gym smoke, external fixtures, the SDK
release gate, scale smoke, and a pack dry run.

`release:evidence` is the release-candidate evidence bundler. It requires a
clean worktree by default, runs `gate:pr`, packs the SDK tarball, installs that
tarball into a fresh temporary consumer project, runs minimal SDK and CLI smoke
checks from the installed package, and writes `manifest.json`, `SUMMARY.md`, and
command logs under `release-evidence/`. The directory is git-ignored. Use
`--skip-gate`, `--skip-fresh-install`, and `--allow-dirty` only for local
diagnostics; do not use those flags for public release evidence.

`test:consumer` packs the SDK, installs it into a temporary external project,
then verifies package exports, plaintext SQLite use, the MCP-style router, MCP
stdio server wiring, the HTTP adapter export, and the `gmos` CLI from the
installed package.

The GitHub Actions CI runs these gates on Linux and macOS with Node 20.19 and
Node 24, and on Windows with Node 24. Windows Node 20.19 is not part of the
official CI matrix because the current `better-sqlite3` prebuild coverage can
fall back to native compilation on GitHub-hosted Windows runners. Remote CI is
opt-in: use `workflow_dispatch` or add the `run-ci` / `full-ci` label on a pull
request when remote matrix evidence is needed. Branch pushes and release tag
pushes do not run CI by default. The benchmark jobs are deterministic SDK gates;
they do not call an external LLM.

`gym run` is the deterministic SDK benchmark. It reports hard gates, coverage
layers, a generalization view, diagnostic suggestions, and a run manifest. It does
not run an LLM judge and should not be treated as proof of mature digital-twin
capability.

`gym external` runs a local long-memory QA adapter over a user-provided file.
gmOS supports its native deterministic JSONL format plus direct local adapters
for LongMemEval original/cleaned JSON/JSONL and LoCoMo JSON/JSONL through
`--dataset-format gmos|longmemeval|locomo`. gmOS does not download or vendor
those datasets. In native gmOS JSONL, each line is one deterministic case:

```jsonl
{"id":"sample-project-next-step","events":[{"type":"memory","kind":"project","content":"project:sample-project 的公开别名是 sample project。"},{"type":"memory","kind":"procedure","content":"sample project 下一步先完成 recorded preflight item，再做实现。"}],"question":"sample project 这个项目下一步先做什么？","reconstructionIntent":{"queryCues":["project:sample-project"],"requiredTagGroups":[{"name":"procedure_or_next_step","tags":["procedure","task_trajectory","project.state","world_belief"]}]},"expectedAll":["recorded preflight item"],"forbiddenAny":["unrelated schedule"]}
```

The LongMemEval adapter maps each instance's `haystack_sessions` turns into a
local deterministic memory corpus and uses `answer` only as the scoring target.
The LoCoMo adapter maps each sample's `conversation.session_<n>` turns into the
same corpus format and creates one case per `qa` annotation. It accepts `answer`
as the deterministic scoring target and treats any provided
`adversarial_answer` as forbidden output. Adapter code must not write expected
answers, forbidden/adversarial answers, evidence ids, category labels,
`has_answer`, dataset names, case IDs, session IDs, or adapter trace labels into
runtime memory/evidence. Those fields may appear in benchmark reports and
manifests only.
LoCoMo QA annotations without an official `answer` are skipped as unscorable
and reported in the dataset warnings instead of being treated as correct.

`gym external-suite` runs several external benchmark files from one manifest and
writes per-run JSON/Markdown reports when `--output-dir` is provided. Add
`--fail-on-benchmark-fail` when using a suite as a release gate. Reports include
strict deterministic scores, normalized evidence scores, timing, manifests, and
failure-stage taxonomy for debugging extraction, grounding, reconstruction,
context budget, temporal policy, and safety behavior. See
[benchmarking](./docs/BENCHMARKING.md) for scoring semantics and claim rules.

The repository also includes a small CI-safe fixture suite at
`test/fixtures/external-benchmark/suite.json`. `npm run test:external-fixtures`
runs it with `--fail-on-benchmark-fail` and covers gmOS native JSONL,
LongMemEval adapter abstention handling, LoCoMo adapter unscored-QA handling,
profile reuse, incognito filtering, history recall, task trajectory reuse, and
boundary-aware prepare mode. Full LongMemEval/LoCoMo datasets remain manual or
scheduled baselines because they are too large and slow for ordinary PR CI.

`gym statebench` is a protocol bridge for the STATE-Bench Agent Learning Track,
not a replacement for the official runner. See
[benchmarking](./docs/BENCHMARKING.md) for protocol boundaries and claim rules.

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

`doctor` and `status` include content-free SQLite health summaries and runtime
capability metadata: public CLI binaries, package exports, MCP tools, HTTP
routes, the local-first SQLite trust contract, indexed row count, missing FTS
rows, stale rows, orphan rows, duplicates, local vector side index status, and
read-audit coverage. The read-audit summary reports table counts and whether
hashes are available; it does not print table state hashes or memory content.
Context search uses a deterministic local vector projection with FTS/BM25 and
LIKE fallback; delete and management search stay lexical so fuzzy recall cannot
archive the wrong memory. The vector index is derived from `gmos_memories`,
stored in plaintext SQLite, and never calls a network embedding service. If the
index drifts from the canonical table,
run `gmos repair --db ./gmos.db --search-index` to rebuild both FTS and vector
rows from the stored memories. Repair does not create or delete memories; it
only rebuilds derived search indexes.

`reconstructContext()` is the active reconstruction API. It starts from the
current turn's cue terms, explores bounded cue-tag-content associations, fetches
matching memory content, generates new cues from intermediate evidence, and
reranks noisy branches by structured intent before spending context budget. The
planner does not synthesize procedure, boundary, preference, or current-state
intent from language keyword lists. Hosts that already know the turn route should
pass `reconstructionIntent` so procedure paths, task trajectories, boundaries, or
current-state beliefs can receive explicit intent support. The planner also
blends association paths with direct memory-search hits using a bounded
reciprocal-rank signal, so explicit entity or temporal clues can reinforce the
chosen evidence path without replacing the cue-tag-content graph. Returned paths
include `routeScore`, stable `routeSources`, and human-readable `routeReason` so
a host can explain why a branch was selected without parsing diagnostic text.
Returned paths also expose
`informationGain`, and returned stats include evidence convergence, coverage,
and reconstruction uncertainty. This lets hosts distinguish "we found enough
supporting evidence" from "we only retrieved plausible nearby memories".
Returned results also include `plannerTrace`, a structured cue-exploration trace
with selected cues, branch decisions, pruned branches, and evidence-driven new
cue activation. This trace is for host diagnostics, benchmark verification, and
offline regression reports; it is not injected into the default prompt context
and should not be forwarded directly to an LLM or end user.
When a host declares multiple intent groups, such as procedure plus boundary,
convergence requires every declared group to be covered by evidence; a procedure
path alone is not enough if the structured route also requires a boundary.
`stopWhenEvidenceEnough` defaults to true; set it to false for diagnostics when
you want the planner to spend the full step budget and inspect additional
branches. `evidenceConvergenceThreshold` can be raised for stricter release
gates or lowered for exploratory tooling.
Hosts that already know the turn intent can pass `reconstructionIntent` with
structured `queryCues`, `expectedTags`, and required tag groups. gmOS uses those
host-owned signals instead of growing language-specific phrase lists for
procedure, boundary, preference, or current-state evidence.
Hosts that own entity, calendar, or route parsing can also pass
`createMemoryOS({ reconstruction: { cueExtractor } })`. A cue extractor receives
bounded query/evidence text and returns sanitized `{ cue, cueKind }` values for
the reconstruction planner. gmOS merges those cues with built-in lexical/date
cues, filters secret-like values, and keeps the same evidence, privacy, and read-path
purity gates. This is the preferred integration point for product-specific
entity aliases or temporal parsers; do not add language-specific cue word lists
to gmOS core. Natural-language temporal query cues are also off by default; a
host that explicitly wants gmOS to parse conservative date text in reconstruction
queries can set `reconstruction.inferTemporalCuesFromText: true`, or preferably
return trusted temporal cues from its own `cueExtractor`.
Private route ids, debug labels, or host-only control names can be used as
retrieval hints, but they are not treated as user-facing memory facts: if they do
not appear in the public query, gmOS renders them as `retrieval_hint` in prompt
context, evidence paths, planner traces, and explain-path output. gmOS still
ignores sensitive or secret-like cue hints and intent tags, and caps cue hints
before they can enter the reconstruction frontier.
`recallPurpose: "history"` and `recallPurpose: "context"` provide the same explicit boundary for
current/history state; `temporalMode` remains the CLI/MCP-facing convenience
option.

`forget()` accepts optional structured `targetTerms`. Hosts that already know
which user-visible subject should be forgotten should pass those terms instead
of relying on gmOS to infer the deletion target from a natural-language query.
The `query` remains required as a human-readable request and literal compatibility
fallback; gmOS does not strip language-specific command words from it by default.
Empty literal queries and empty `targetTerms` archive nothing rather than
broadening into a whole-profile delete. Hosts that need natural-language forget
commands can pass a `forgetTargetParser` to `createSqliteMemoryStore`. Parser
`undefined` or `null` falls back to the literal `query`; parser empty terms mean
"parsed but no clear target" and also archive nothing:

```ts
const store = createSqliteMemoryStore({
  path: "./gmos.db",
  forgetTargetParser: ({ query }) => hostOwnedForgetParser(query),
});
```

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
`temporalMode: "auto"` uses ordinary current-context behavior; hosts should pass
`recallPurpose: "history"` or `temporalMode: "history"` when their controller or
model has classified the turn as historical recall. History mode does not bypass
sensitive or person-memory defaults.
gmOS does not enable built-in language/date text inference by default. Hosts that
want the conservative built-in parser for memory writes can set
`temporal.inferFromText: true`; then host extractor candidates can pick up
validity metadata from explicit date text such as `until 2026-07-01`,
`expires on 2026-07-01`, `valid from 2026-01-01`, or `从 2026-01-01 开始`.
Hosts that want the same conservative date parser for reconstruction queries
must also explicitly set `reconstruction.inferTemporalCuesFromText: true`, or
provide trusted temporal cues through `reconstruction.cueExtractor`. gmOS core
does not maintain a language-specific relative-date vocabulary for phrases such
as "yesterday" or "明天"; hosts with calendar context should keep the default and
pass a `temporal.parser` that returns structured `eventTime`, `eventDate`,
`validFrom`, or `validTo` values. Parser output is normalized and safety-filtered
before it enters memory metadata. gmOS still does not try to resolve ambiguous
relative dates such as "next week" through the built-in parser; hosts should pass
structured metadata when they have a trusted calendar parser. The same validity
metadata is written to the derived world belief when a candidate creates one, so
reconstruction does not reintroduce an expired belief through the association
graph.
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
      // Use input.event and input.evidence to produce structured candidates
      // from the current user message.
      return [
        {
          kind: "preference",
          content: "Release plan response style: summary first, then options.",
          confidence: 0.9,
          predicate: "user.preference",
          actionPolicyKind: "prefer",
        },
        {
          kind: "project",
          subject: "project:sample-project",
          predicate: "project.state",
          content: "project:sample-project is blocked on the integration dry run.",
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
Returning `[]` means "extract nothing". Returning `null` or throwing does not
cause gmOS to synthesize user facts, preferences, boundaries, people, or project
state on its own. If a custom extractor returns candidates
but all of them are rejected by the gmOS write-path validator, gmOS records the
hard/soft reject audit and does not synthesize replacement memory. Hosts should
use a structured extractor for durable semantic memory, or call low-level `add`
when they already have an explicit memory record.

Hosts that already own entity resolution can pass the same `entityResolver` to
both `createSqliteMemoryStore()` and `createMemoryOS()`. The resolver receives a
structured subject/predicate/alias input and returns a raw canonical subject,
entity kind, entity key, and aliases. gmOS sanitizes those values, applies
sensitivity filters, and falls back to the built-in resolver when the custom resolver returns
`null` or an unsafe result:

```ts
const entityResolver = (input) => {
  if (!input.subject.startsWith("workspace:")) return null;
  const key = input.subject.slice("workspace:".length).trim().toLowerCase();
  return {
    canonicalSubject: `workspace:${key}`,
    originalSubject: input.subject,
    entityKind: "workspace",
    entityKey: key,
    aliases: [input.subject, key, ...(input.aliases ?? [])],
  };
};

const store = createSqliteMemoryStore({ path: "./gmos.db", entityResolver });
const memory = createMemoryOS({ profileId: "local-user", store, entityResolver });
```

`observe()` remains the stable fire-and-forget observation API. Use
`observeWithReport()` when a host or benchmark needs an `ObserveResult` to
audit the write path without reading private tables:

```ts
const report = await memory.observeWithReport({
  type: "conversation.message",
  role: "user",
  content: "User opened the release planning thread and asked for a rollback check.",
});

console.log(report.memoryIds);
console.log(report.extraction?.decisions);
```

The report includes the evidence id, accepted memory ids, world belief ids,
custom extractor status, hard/soft reject counts, and accepted/rejected
candidate decisions after candidates enter gmOS write-path validation. gmOS core
does not synthesize replacement candidates when an extractor returns nothing or
fails. It is not a raw
LLM-output transcript. Candidate snapshots are sanitized; rejected secret-like
fields and sensitive metadata are redacted or omitted so the report can be
logged by a host without becoming a credential side channel.

Use `listEvidence()` when a host needs a read-only diagnostic view of recent
evidence events, including eligible non-user messages that were intentionally
not promoted into memories. This API is not used for ordinary prompt context.
It defaults to normal-sensitivity evidence only; `includeSensitive: true`
returns sensitive rows with sanitized public fields and still excludes
secret-like evidence.

Durable extraction only runs for `role: "user"` conversation messages by
default. Eligible assistant, tool, and system messages can still be recorded as
evidence for diagnostics, but they are not promoted into memories unless a host
explicitly opts into trusted non-user extraction:

```ts
const memory = createMemoryOS({
  store,
  extraction: {
    extractFromRoles: ["user", "assistant"],
  },
});
```

Use this only for host-owned summaries or other trusted agent outputs. The same
safety gates still apply: incognito and secret-like content is skipped before
evidence persistence, `PERSON:` routed content is not promoted into user memory,
and accepted memories keep their source role in metadata for auditability.

Hosts with local product domains can add a host-owned sensitivity classifier
instead of asking gmOS core to grow more language or domain keyword lists:

```ts
const memory = createMemoryOS({
  store,
  safety: {
    sensitivityClassifier: ({ value, surface }) =>
      hostSensitivityPolicy.classify({ value, surface }),
  },
});
```

This classifier is additive. gmOS still runs its built-in conservative detector
and combines both results by maximum sensitivity, so a host can mark additional
terms as sensitive or secret-like but cannot downgrade built-in secret-like
matches. Host-classified secret-like observations are skipped before evidence
persistence. Host-classified sensitive and secret-like values are redacted on
runtime report and public evidence output surfaces before they leave the SDK.

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

The extractor sends a Chat Completions-shaped request to `/chat/completions`,
requests JSON output, and parses `{"memories":[...]}` from ordinary message
content, Chat Completions content parts, or OpenAI-compatible proxy responses
that expose `output_text` / `output[].content[].text`. It does not switch the
request body to the Responses API. Parsed candidates then pass through the same
gmOS write-path guards as every other extractor: incognito events are skipped
before extraction, secret-like and PERSON-routed candidates are rejected,
confidence is bounded, and provider failure does not enable built-in semantic
synthesis. Event metadata is not sent to the provider unless
`includeEventMetadata: true` is set. Structured candidates may include
`subject`, `predicate`, `object`, `source`, `eventTime`, `validFrom`, `validTo`,
and `cardinality`; `source` is only a short public label for the extracted
candidate, while evidence `sourceType/sourceUri` remain the provenance source of
truth.
Accepted memories and world beliefs retain the normalized structured fields in
their public metadata so hosts can audit the extraction without reading private
tables.

Use `cardinality: "single"` only for current-state beliefs where one active
value should replace the previous one, such as a project's current owner,
status, or next step. gmOS first resolves the subject into a canonical entity
key; for example, `project:<project-id>`, `project/<project-id>`, or subject `<project-id>` with
predicate `project.state` converge to a stable project entity. `repo:<repo-id>` and
`repository:<repo-id>` normalize as repository entities, not project entities.
Natural-language aliases such as "sample project alias" are host-specific and should
come from `entityResolver`, not from gmOS core. It then marks the previous active world
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
npm run examples:agent-adapter
npm run examples:host-adapter
npm run examples:http-adapter
npm run examples:mcp-router
npm run examples:external-mini
```

`examples/quickstart.mjs` creates a temporary plaintext SQLite store, imports an
explicit preference memory, prepares memory context, exercises low-level
`add/update/search/archive`, prints a content-free diagnostics summary, and
removes the temporary database.

`examples/agent-adapter.mjs` uses the framework-agnostic
`createAgentMemoryAdapter()` helper from `@ghast/memory/host`. It observes
conversation events, prepares memory-injected model messages, exposes action
policies and evidence counts, commits an outcome, records feedback, and runs a
forget cleanup without depending on a specific agent framework.

`examples/host-adapter.mjs` shows the host migration path: project an existing
host memory snapshot into gmOS, skip secret-like and person-routed memories,
prepare evidence-aware context, and archive stale imported memories on the next
sync. Use this path when the host already has a memory table and needs gmOS as
the context/action runtime without replacing storage in one step.

`examples/http-adapter.mjs` starts a local ephemeral HTTP server with bearer
auth, verifies unauthenticated non-health requests are rejected, records an
ordinary observation through `/observe`, imports an explicit preference memory,
prepares evidence-backed context through `/prepare`, reads a content-free
`/status` report, and removes its temporary plaintext SQLite database. Use this
path when the host process cannot import the Node SDK directly.

`examples/mcp-router.mjs` exercises the in-process MCP tool router through the
public package exports. It checks `memory.runtime_info`, records an ordinary
observation through `memory.observe`, imports an explicit preference memory,
prepares evidence-backed context, verifies public MCP rejects sensitive override
switches, explains the evidence path without returning a prompt block, and
prints only sanitized integration metadata.

`examples/external-mini-benchmark.mjs` runs the native deterministic external
mini fixture in `examples/external-mini-fixture.jsonl`. It is a reproducibility
smoke for the external adapter report path, not a comparable external benchmark
report. The output keeps only aggregate scores, score semantics, and slice
scores.

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
  content: "回答风格：先给结论，再列方案。",
});

const matches = await memory.search({
  profileId: "local-user",
  query: "结论 方案",
});

await memory.update({
  profileId: "local-user",
  id: saved.id,
  content: "回答风格：先给结论，最后列方案。",
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
`memory.record_feedback`, `memory.forget`, `memory.explain_belief`, and
`memory.runtime_info`.

`memory.runtime_info` takes no input and returns the installed package version,
CLI binaries, package exports, public MCP/HTTP surface, and local-first trust
contract. It does not open or mutate the SQLite store.

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
- `GET /runtime-info`
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
in-process SDK behind a private host boundary.

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
bundles. The report includes package version, public SDK/CLI/MCP/HTTP runtime
surface, SQLite schema version, row counts, read-audit coverage, failure counts
by kind, and optional host compatibility. It does not include memory content,
failure samples, or table state hashes.

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
gmos doctor --db ./gmos.db --host ghast --format markdown
gmos status --db ./gmos.db --profile local --host ghast --format markdown
```

Both commands can also write reproducibility artifacts with `--json-file` and
`--markdown-file`; the reports stay content-free and do not include memory text,
failure samples, or table state hashes.

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
the current schema version plus the same content-free runtime capability
contract exposed by `gmos version`, `/runtime-info`, `memory.runtime_info`, and
`createMemoryStatusReport()`, so host applications can verify package surface
and upgrade state before running long-lived agents. TypeScript consumers can
use the exported `SqliteMemoryStore` type when they need SQLite-specific
diagnostics.

## Host Compatibility

gmOS reports host capability as L0-L4. The SDK can maintain memory state, but a
host must expose the right hooks to preserve full behavior:

- `ghast`: L4, managed memory runtime.
- `mock_l3`: L3, useful for adapter smoke tests.
- `mcp`: L2, useful for tool-based integrations but cannot guarantee full
  directive enforcement.
- `search_only`: L1, recall-only and not a full Memory OS integration.

Run `gmos doctor --host ghast --format markdown` to inspect runtime surface,
SQLite health, capability gaps, and hard-gate coverage.

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
      content: "回答风格：先给结论。",
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

This is an alpha TypeScript/Node SDK and local runtime for host applications
that need user-owned, evidence-backed memory.
