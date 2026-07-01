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
[structured extraction](./docs/STRUCTURED_EXTRACTION.md),
[architecture](./docs/ARCHITECTURE.md), [benchmarking](./docs/BENCHMARKING.md),
[benchmark runs](./docs/BENCHMARK_RUNS.md), [migration](./docs/MIGRATION.md),
[contributing](./CONTRIBUTING.md), [security and privacy](./SECURITY.md),
[release checklist](./RELEASE_CHECKLIST.md).

## Install And Quickstart

```bash
npm install @ghast/memory
```

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

console.log(prepared.contextBlock);
await memory.close();
```

Run the packaged quickstart smoke after cloning the repository:

```bash
npm install
npm run build
npm run examples:quickstart
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
  subjects such as `project:<project-id>`, `project/<project-id>`, or subject
  `<project-id>` with predicate `project.state` converge before
  single-cardinality invalidation runs.
- Optional host-provided `entityResolver` support for product-specific entities.
  Hosts can canonicalize workspaces, accounts, repositories, or other domain
  objects without adding product-specific entity templates to gmOS core.
- Entity mention metadata for accepted memories and world beliefs. gmOS records
  explicit subjects and aliases, and only treats source speaker metadata as a
  person cue when the host or extractor marks it with `speakerKind: "person"` or
  `speakerKind: "human"`.
- Historical recall mode for temporal/current-state questions. Ordinary context
  still suppresses superseded or out-of-window memories, while explicit
  `history` recall can retrieve those past facts without using manage/delete
  search or opening sensitive/person memory.
- Runtime facade: `observe`, `prepareTurn`, `commitOutcome`, `recordFeedback`,
  `reconstructContext`, `explainEvidencePath`, `forget`, `explain`.
- Pluggable extraction pipeline for host-provided structured extractors. gmOS
  keeps write-path authority for evidence, PERSON, secret-like, incognito, and
  forgetting gates, but it does not synthesize durable memory from built-in
  lexical/date cue parsing.
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
- gmOS does not ship production-grade content understanding. Hosts should
  provide a structured extractor, or explicitly import known memories with
  `add()`, for durable facts, preferences, boundaries, procedures, people, and
  project state.
- External LongMemEval and LoCoMo numbers are deterministic local adapter
  baselines for engineering comparison. Official benchmark claims require the
  upstream protocol, fixed model/judge settings, and public reproduction data.
- STATE-Bench, Mem2ActBench, BEAM, and similar action-memory claims require
  their unchanged official runners before they should be presented as comparable
  benchmark results.

## Structured Extraction

`createMemoryOS({ extractor })` lets a host provide durable memory candidates
while keeping gmOS as the write-path authority:

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  extractor: {
    name: "host-structured-extractor",
    async extract(input) {
      return [
        {
          kind: "project",
          subject: "project:<project-id>",
          predicate: "project.state",
          object: "blocked on integration dry run",
          content: "project:<project-id> is blocked on the integration dry run.",
          confidence: 0.86,
          cardinality: "single",
        },
      ];
    },
  },
});
```

The extractor is intentionally not a raw database hook. `observe()` still rejects
incognito and secret-like writes before evidence persistence, skips PERSON-routed
candidates, bounds confidence, deduplicates candidates, and writes world beliefs
only from accepted candidates that carry a structured predicate. Returning `[]`
means "extract nothing". Returning `null` or throwing does not cause gmOS to
synthesize user facts, preferences, boundaries, people, or project state on its
own.

For a runnable end-to-end example of host-owned candidate generation and
reconstruction cues:

```bash
npm run examples:structured-extractor
```

See [structured extraction](./docs/STRUCTURED_EXTRACTION.md) for the full
candidate contract.

## Entity, Time, And Reconstruction Hooks

Hosts that already own entity resolution can pass the same `entityResolver` to
both `createSqliteMemoryStore()` and `createMemoryOS()`. The resolver receives a
structured subject/predicate/alias input and returns a raw canonical subject,
entity kind, entity key, and aliases. gmOS sanitizes those values, applies
sensitivity filters, and falls back to the built-in resolver when the custom
resolver returns `null` or an unsafe result.

Hosts with local calendar context can pass `temporal.parser` and return
structured `eventTime`, `eventDate`, `validFrom`, or `validTo` values. Built-in
language/date text inference is disabled by default. Set
`temporal.inferFromText: true` only when the integration explicitly wants gmOS to
parse explicit date text during memory writes. Reconstruction query date text is
also disabled by default; set `reconstruction.inferTemporalCuesFromText: true`
only when the integration explicitly wants the conservative date parser for query
cues. Relative calendar phrases should be resolved by the host parser with
trusted calendar context.

Hosts that already own entity aliases, calendar cues, or route parsing can pass
`createMemoryOS({ reconstruction: { cueExtractor } })`. A cue extractor receives
bounded query/evidence text and returns sanitized `{ cue, cueKind }` values for
the reconstruction planner. gmOS merges those cues with built-in lexical/date
cues, filters secret-like values, and keeps the same evidence, privacy, and
read-path purity gates.

## CLI

```bash
npm install
npm run build

node dist/cli/gmos.js init --db ./gmos.db
node dist/cli/gmos.js doctor --db ./gmos.db --host ghast --format markdown
node dist/cli/gmos.js status --db ./gmos.db --profile local --host ghast --format markdown
node dist/cli/gmos.js add --db ./gmos.db --profile local --kind preference --text "回答风格：简洁，先给结论"
node dist/cli/gmos.js add --db ./gmos.db --profile local --kind boundary --text "不要再提醒我这个项目延期了。"
node dist/cli/gmos.js search --db ./gmos.db --profile local --query "结论 方案"
node dist/cli/gmos.js history --db ./gmos.db --profile local --query "之前的状态"
node dist/cli/gmos.js prepare --db ./gmos.db --profile local --text "你之后怎么回答我？"
node dist/cli/gmos.js reconstruct --db ./gmos.db --profile local --text "这个项目之前是什么状态？" --temporal-mode history
node dist/cli/gmos.js explain-path --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？" --include-trace
node dist/cli/gmos.js mcp serve --db ./gmos.db --profile local
node dist/cli/gmos.js http serve --db ./gmos.db --profile local --port 4787 --host ghast --auth-token local-dev-token
node dist/cli/gmos.js evolution report --db ./gmos.db --profile local --format markdown
node dist/cli/gmos.js gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
```

## QA Gates

```bash
npm run gate:pr
npm run release:evidence -- --output-dir ./release-evidence/alpha-local
node dist/cli/gmos.js gym external --input-file ./long-memory-qa.jsonl --dataset-format gmos --format json --require-convergence --progress
node dist/cli/gmos.js repair --db ./gmos.db --search-index
node dist/cli/gmos.js repair --db ./gmos.db --associations
```

`gate:pr` is the local and CI PR gate. It runs build/test, published examples,
benchmark-integrity checks, extraction boundary checks, consumer install smoke,
deterministic Memory Gym smoke, external fixtures, the SDK release gate, scale
smoke, and a pack dry run.

`release:evidence` is the release-candidate evidence bundler. It requires a
clean worktree by default, runs `gate:pr`, packs the SDK tarball, installs that
tarball into a fresh temporary consumer project, runs minimal SDK and CLI smoke
checks plus a content-safe inspector smoke from the installed package, validates
that the inspector report includes numeric forget-residue counters, and writes
`manifest.json`, `SUMMARY.md`, and command logs under `release-evidence/`. The
directory is git-ignored. Use `--skip-gate`, `--skip-fresh-install`, and
`--allow-dirty` only for local diagnostics; do not use those flags for public
release evidence.

The GitHub Actions CI runs these gates on Linux and macOS with Node 20.19 and
Node 24, and on Windows with Node 24. Windows Node 20.19 is not part of the
official CI matrix because the current `better-sqlite3` prebuild coverage can
fall back to native compilation on GitHub-hosted Windows runners. Remote CI is
opt-in: use `workflow_dispatch` or add the `run-ci` / `full-ci` label on a pull
request when remote matrix evidence is needed. Branch pushes and release tag
pushes do not run CI by default. The benchmark jobs are deterministic SDK gates;
they do not call an external LLM.

## Benchmarking

`gym run` is the deterministic SDK benchmark. It reports hard gates, coverage
layers, a generalization view, diagnostic suggestions, and a run manifest. It
does not run an LLM judge and should not be treated as proof of mature
digital-twin capability.

`gym external` runs a local long-memory QA adapter over a user-provided file.
gmOS supports its native deterministic JSONL format plus direct local adapters
for LongMemEval original/cleaned JSON/JSONL and LoCoMo JSON/JSONL through
`--dataset-format gmos|longmemeval|locomo`. gmOS does not download or vendor
those datasets.

External reports include strict deterministic scores, normalized evidence scores,
timing, manifests, and failure-stage taxonomy for debugging extraction,
grounding, reconstruction, context budget, temporal policy, and safety behavior.
See [benchmarking](./docs/BENCHMARKING.md) and
[benchmark runs](./docs/BENCHMARK_RUNS.md) for scoring semantics, baseline
snapshots, and claim rules.

## Examples

Run the examples after installing dependencies:

```bash
npm run examples:quickstart
npm run examples:structured-extractor
npm run examples:agent-adapter
npm run examples:host-adapter
npm run examples:http-adapter
npm run examples:mcp-router
npm run examples:external-mini
```

`examples/structured-extractor.mjs` demonstrates the preferred host boundary:
the host supplies structured candidates and reconstruction cues, while gmOS
handles evidence, validation, action-policy projection, reconstruction, and
read-path safety.

`examples/agent-adapter.mjs` uses the framework-agnostic
`createAgentMemoryAdapter()` helper from `@ghast/memory/host`. It observes
conversation events, prepares memory-injected model messages, exposes action
policies and evidence counts, commits an outcome, records feedback, and runs a
forget cleanup without depending on a specific agent framework.

`examples/host-adapter.mjs` shows the host migration path: project an existing
host memory snapshot into gmOS, skip secret-like and person-routed memories,
prepare evidence-aware context, and archive stale imported memories on the next
sync.

`examples/http-adapter.mjs` starts a local ephemeral HTTP server with bearer
auth, verifies unauthenticated non-health requests are rejected, records an
ordinary observation through `/observe`, imports an explicit preference memory,
prepares evidence-backed context through `/prepare`, reads a content-free
`/status` report, and removes its temporary plaintext SQLite database.

`examples/mcp-router.mjs` exercises the in-process MCP tool router through the
public package exports. It checks `memory.runtime_info`, records an ordinary
observation through `memory.observe`, imports an explicit preference memory,
prepares evidence-backed context, verifies public MCP rejects sensitive override
switches, explains the evidence path without returning a prompt block, and
prints only sanitized integration metadata.

`examples/external-mini-benchmark.mjs` runs the native deterministic external
mini fixture in `examples/external-mini-fixture.jsonl`. It is a reproducibility
smoke for the external adapter report path, not a comparable external benchmark
report.

## Low-Level Compatibility APIs

The primary gmOS integration path is `observe()` plus `prepareTurn()`. Low-level
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

The CLI also supports portable memory snapshot migration and profile backup:

```bash
gmos export --db ./gmos.db --profile local --output-file ./gmos-memory-export.json
gmos import --db ./new-gmos.db --profile local --input-file ./gmos-memory-export.json
gmos backup --db ./gmos.db --profile local --mode safe --output-file ./gmos-profile-backup.json
gmos restore --db ./new-gmos.db --profile local-restored --input-file ./gmos-profile-backup.json
```

Safe exports and backups exclude archived, sensitive, and person memories by
default. Full backups are plaintext JSON and should be used only inside a trusted
host boundary.

## MCP Tools

The alpha SDK exposes both a protocol-neutral in-process router and a real MCP
stdio server through `@ghast/memory/mcp`. Hosts can mount the same tools behind
MCP stdio, HTTP, Electron IPC, or another agent runtime without changing the
memory core.

Current tools are `memory.add`, `memory.search`, `memory.observe`,
`memory.prepare_context`, `memory.reconstruct_context`,
`memory.explain_evidence_path`, `memory.commit_outcome`,
`memory.record_feedback`, `memory.forget`, `memory.explain_belief`, and
`memory.runtime_info`.

`memory.add` and `memory.search` are public-safe tools for simple agent
integrations. They do not expose `allowPerson`, `includeSensitive`,
`includePerson`, or raw metadata fields. Secret-like content is rejected before
write, person-routed content is rejected, and search returns only context-safe
memory records.

## HTTP Adapter

Hosts that cannot embed the Node SDK directly can run gmOS as a local HTTP
service. This adapter reuses the MCP tool router for memory operations, so it
does not bypass the public safety boundary. It defaults to `127.0.0.1` and does
not add TLS, cloud sync, or database encryption. For local service boundaries
that cross a process boundary, pass `authToken` or `--auth-token`; all non-health
endpoints will then require `Authorization: Bearer <token>`.

Endpoints include `GET /health`, `GET /runtime-info`, `GET /status`, `GET
/tools`, `POST /add`, `POST /search`, `POST /observe`, `POST /prepare`, `POST
/reconstruct`, `POST /explain-path`, `POST /commit-outcome`, `POST /feedback`,
`POST /forget`, `POST /explain`, and `POST /mcp/call`.

Profile backup/restore is intentionally not exposed as an MCP tool or HTTP route.
It remains an in-process SQLite store API and CLI operation for trusted
engineering workflows.

## Evolution Review

The alpha SDK includes a report-only self-evolution control plane. It reads the
failure log, clusters failures by kind, proposes repair hypotheses, and emits
policy patch candidates. It does not apply patches, roll out changes, or weaken
hard gates.

```bash
gmos evolution report --db ./gmos.db --profile local --format markdown
```

## Diagnostics

Hosts can generate a read-only status report for integration checks and support
bundles. The report includes package version, public SDK/CLI/MCP/HTTP runtime
surface, SQLite schema version, row counts, read-audit coverage, failure counts
by kind, and optional host compatibility. It does not include memory content,
failure samples, or table state hashes.

```bash
gmos doctor --db ./gmos.db --host ghast --format markdown
gmos status --db ./gmos.db --profile local --host ghast --format markdown
```

## Trust Contract

gmOS defaults to a plaintext SQLite database. Security comes from memory policy
and host boundaries, not database encryption:

- secret-like content is not persisted as long-term memory;
- incognito/private events are not promoted to long-term memory;
- ordinary context does not include sensitive memory unless explicitly allowed;
- forget operations archive matching memory and remove it from future context;
- read paths must not write;
- SQLite read paths are audited with table state hashes so same-row updates or
  same-row-count FTS rewrites are treated as side effects.

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

Host adapters can import existing memory snapshots through
`loadHostMemorySnapshotsIntoStore()` from `@ghast/memory/host`, or use
`syncHostMemorySnapshotsIntoStore()` when the snapshot list represents the host's
complete active memory set for that `profileId` and `sourceType`.

## Status

This is an alpha TypeScript/Node SDK and local runtime for host applications that
need user-owned, evidence-backed memory. It is ready for public beta preparation
with release evidence, but the complete second-brain and digital-twin product
layer is still under active development.
